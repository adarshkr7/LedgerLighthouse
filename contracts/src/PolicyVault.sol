// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ebool, euint256, e, inco} from "@inco/lightning/src/Lib.sol";

/// The one read the vault makes of its token.
interface IAuthorizationState {
    /// True once the token has consumed the EIP-3009 authorization `nonce` from `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title PolicyVault — confidential spending policy for an autonomous agent
///
/// @notice Enforces a spending policy whose budget is confidential, so that
/// compromising the AI orchestrator does not confer arbitrary spending
/// authority. The orchestrator may only call `requestSpend` with public terms;
/// it can neither read nor alter the budget, nor forge an approval.
///
/// ## What is encrypted
///
/// `remainingBudget` and `perCallCap`. Both are bound to the opener's own
/// ciphertexts and only ever compared inside Inco. `callsRemaining`, the
/// allowlist, the asset and the expiry stay public.
///
/// The cap was public until 9 October 2026. A public cap told every vendor the
/// most a single call would pay, so a hostile vendor simply priced at it, and
/// the encrypted budget then hid only how many such calls the agent could
/// afford. With both encrypted, a rejection does not say which limit failed.
///
/// ## What still leaks, and how much
///
/// Every requested amount and every decision is public, so each request
/// answers one yes/no question: is this amount within both limits? An attacker
/// who controls the relay chooses the questions, and a binary search over them
/// recovers the cap exactly in about twenty requests. Before `reclaimExpired`
/// existed, each approval at least spent a call; since then an approval whose
/// authorization is left to expire costs nothing, and a rejection never did.
///
/// So the number of questions is itself limited. `attemptsRemaining` is public,
/// set by the owner at `openGoal`, decremented by every `requestSpend` whatever
/// its outcome, and never restored, not by `reclaimExpired` and not by
/// anything else. Over the life of a goal, the relay learns at most
/// `maxAttempts` bits about the cap and the budget, and the owner chooses that
/// number knowing it.
///
/// ## Where a condition is enforced, and why it differs
///
/// Two kinds of checks, deliberately handled differently:
///
///   - **Structural validity** — allowlist, asset, expiry, goal open, caller is
///     the relay, payer not already bound to another goal. These `revert`. A
///     malformed request is not a policy decision and should never reach the
///     chain as one.
///   - **Policy** — `perCallCap`, `remainingBudget` (both encrypted) and
///     `callsRemaining` (public). These resolve into the decision rather than
///     reverting, *including the public one*. An over-cap request must land on
///     chain and bounce visibly. If it reverted, there would be no record, and
///     the bounce is the product.
///
/// ## Write-ahead ordering
///
/// The encrypted debit is applied unconditionally via `e.select` in the same
/// transaction that records the terms — before anyone, including the caller,
/// can learn whether it was approved. Inco makes this the only expressible
/// option, since branching on an encrypted condition is impossible.
///
/// ## The vendor's hold
///
/// A vendor holds what it quoted for a limited time, and an authorization that
/// outlives the hold lets the vendor collect after it has let the thing go.
/// So each authorization expires when the hold does (`payBy`), and an approved
/// amount whose authorization expired unused goes back to the budget
/// (`reclaimExpired`).
contract PolicyVault {
    using e for euint256;
    using e for ebool;
    using e for uint256;
    using e for bool;
    using e for bytes;

    // ------------------------------------------------------------------ types

    struct Goal {
        address owner; // opened the goal; only they may close it
        address payer; // ephemeral EOA that will sign EIP-3009. Immutable, and bound
            // to this goal alone — see `payerGoal`.
        address relay; // may call requestSpend; pays gas, authorizes nothing
        address asset; // token the signer is bound to. Never read from a 402.
        uint32 callsRemaining; // public
        uint64 expiry;
        uint64 seq; // monotonic, per goal
        bool open;
    }

    /// Everything the Authorization Signer needs, frozen at `requestSpend` time.
    struct SpendRecord {
        address payTo;
        uint256 amount;
        uint64 validAfter;
        uint64 validBefore;
        bytes32 termsHash;
        ebool decision;
        bool finalized;
        bool approved;
        /// The authorization expired unused and the amount went back to the budget.
        bool reclaimed;
    }

    struct OpenGoalParams {
        bytes budgetCiphertext;
        /// Encrypted like the budget, by the same wallet, for this vault.
        bytes perCallCapCiphertext;
        uint32 callsRemaining;
        /// How many `requestSpend` calls the goal allows in total, approved or
        /// rejected. At least `callsRemaining`. Bounds what the relay can learn
        /// about the encrypted limits; see "What still leaks" above.
        uint32 maxAttempts;
        address payer;
        address relay;
        address asset;
        uint64 expiry;
        address[] allowlist;
    }

    // ------------------------------------------------------------------ state

    /// The longest an EIP-3009 authorization stays valid once issued. Each one
    /// ends at the vendor's hold (`payBy`) when that comes sooner, and never
    /// after the goal's expiry.
    uint64 public constant AUTHORIZATION_WINDOW = 1 hours;

    uint256 public goalCount;

    mapping(uint256 goalId => Goal) public goals;
    /// Encrypted. The most one call may spend; set once at `openGoal`.
    mapping(uint256 goalId => euint256) internal _perCallCap;
    /// Encrypted. The vault never sees a plaintext balance.
    mapping(uint256 goalId => euint256) internal _remainingBudget;
    mapping(uint256 goalId => mapping(address payee => bool)) public allowlisted;
    mapping(uint256 goalId => mapping(uint64 seq => SpendRecord)) internal _spends;
    /// 0 when no spend awaits finalisation.
    mapping(uint256 goalId => uint64) public pendingSeq;

    /// Public. `requestSpend` calls this goal still allows, approved or not.
    /// Only ever decreases. Kept out of `Goal` so the `goals()` getter, which
    /// the Authorization Signer decodes, keeps its shape.
    mapping(uint256 goalId => uint32) public attemptsRemaining;

    /// The goal a payer belongs to, or 0 if the address has never been used.
    ///
    /// One payer, one goal. Every other control here is scoped to a goal —
    /// `perCallCap`, `callsRemaining`, the encrypted budget, the allowlist —
    /// and that scoping only bounds anything if a payer cannot appear in two
    /// goals at once. It could. Payer addresses are public in `GoalOpened`, so
    /// anyone could open their own goal naming somebody else's payer, supply
    /// their own budget ciphertext, cap and allowlist, and have the
    /// Authorization Signer sign a transfer out of that payer: the signer reads
    /// the payer off whichever goal it is handed and holds the key either way.
    /// `closeGoal` plus a sweep was the cheaper version of the same move.
    ///
    /// The binding is never cleared, not at `closeGoal` and not after a sweep.
    /// Releasing it would restore the whole attack against any payer whose goal
    /// had finished, which is exactly the state a payer holding a leftover
    /// balance is in. Payer keys are ephemeral and minting another is one call,
    /// so nothing legitimate wants to reuse one.
    mapping(address payer => uint256 goalId) public payerGoal;

    // ----------------------------------------------------------------- events

    event GoalOpened(
        uint256 indexed goalId,
        address indexed owner,
        address indexed payer,
        address relay,
        address asset,
        uint32 callsRemaining,
        uint64 expiry,
        bytes32 budgetHandle,
        bytes32 perCallCapHandle
    );
    event GoalClosed(uint256 indexed goalId);
    event SpendRequested(
        uint256 indexed goalId,
        uint64 indexed seq,
        address indexed payTo,
        uint256 amount,
        bytes32 termsHash,
        bytes32 decisionHandle,
        uint64 validAfter,
        uint64 validBefore
    );
    event SpendFinalized(uint256 indexed goalId, uint64 indexed seq, bool approved, bytes32 decisionHandle);
    event SpendReclaimed(uint256 indexed goalId, uint64 indexed seq, uint256 amount, bytes32 budgetHandle);

    // ----------------------------------------------------------------- errors

    error FeeNotPaid();
    error InvalidPayer();
    error PayerAlreadyBound();
    error InvalidRelay();
    error InvalidAsset();
    error InvalidExpiry();
    error InvalidCallCount();
    error EmptyAllowlist();
    error UnknownGoal();
    error GoalNotOpen();
    error GoalExpired();
    error NotGoalOwner();
    error NotRelay();
    error PayeeNotAllowlisted();
    error ZeroAmount();
    error SpendPending();
    error UnknownSpend();
    error AlreadyFinalized();
    error InvalidAttestation();
    error PayByPassed();
    error NotApproved();
    error AlreadyReclaimed();
    error AuthorizationLive();
    error AuthorizationUsed();
    error InvalidAttemptCount();
    error NoAttemptsLeft();

    // ------------------------------------------------------------- open/close

    /// @notice Opens a goal. **Must be sent by the user's own wallet**: the
    /// budget ciphertext is bound to the address that produced it, and the
    /// on-chain conversion takes `msg.sender`. The orchestrator therefore
    /// structurally cannot open a goal.
    ///
    /// @dev Payable because converting a client ciphertext into a handle is the
    /// one operation here that charges the Inco fee, and `openGoal` converts
    /// two: the budget and the cap. Trivial encryption, comparison, select, sub
    /// and reveal do not, which is why `requestSpend` is not payable.
    ///
    /// There is no plaintext check that the cap is positive, because there is
    /// no plaintext cap. A zero cap only makes every request reject.
    function openGoal(OpenGoalParams calldata params) external payable returns (uint256 goalId) {
        require(msg.value == 2 * inco.getFee(), FeeNotPaid());
        require(params.payer != address(0), InvalidPayer());
        // Structural, so it reverts: naming a payer that is already somebody
        // else's is not a request the policy has an opinion about. See
        // `payerGoal` for what it costs to leave this out.
        require(payerGoal[params.payer] == 0, PayerAlreadyBound());
        require(params.relay != address(0), InvalidRelay());
        require(params.asset != address(0), InvalidAsset());
        require(params.expiry > block.timestamp, InvalidExpiry());
        require(params.callsRemaining > 0, InvalidCallCount());
        // Fewer attempts than calls would strand calls the owner paid for.
        require(params.maxAttempts >= params.callsRemaining, InvalidAttemptCount());
        require(params.allowlist.length > 0, EmptyAllowlist());

        goalId = ++goalCount;

        // Binds the ciphertext to the sender. A ciphertext prepared for anyone
        // else yields a handle this call cannot use.
        euint256 budget = params.budgetCiphertext.newEuint256(msg.sender);
        // Persisted across transactions, so it needs a permanent grant —
        // without this the vault could never compute over its own budget again.
        budget.allowThis();
        _remainingBudget[goalId] = budget;

        // Same binding, same permanent grant: every request compares against it.
        euint256 cap = params.perCallCapCiphertext.newEuint256(msg.sender);
        cap.allowThis();
        _perCallCap[goalId] = cap;

        goals[goalId] = Goal({
            owner: msg.sender,
            payer: params.payer,
            relay: params.relay,
            asset: params.asset,
            callsRemaining: params.callsRemaining,
            expiry: params.expiry,
            seq: 0,
            open: true
        });
        attemptsRemaining[goalId] = params.maxAttempts;
        // Written alongside the goal record it describes, so the two cannot be
        // added separately and drift.
        payerGoal[params.payer] = goalId;

        for (uint256 i = 0; i < params.allowlist.length; i++) {
            allowlisted[goalId][params.allowlist[i]] = true;
        }

        emit GoalOpened(
            goalId,
            msg.sender,
            params.payer,
            params.relay,
            params.asset,
            params.callsRemaining,
            params.expiry,
            euint256.unwrap(budget),
            euint256.unwrap(cap)
        );
    }

    /// @notice Closes a goal so no further spend can be requested. Inco has no
    /// delete, so closure is public state rather than anything encrypted.
    function closeGoal(uint256 goalId) external {
        Goal storage goal = goals[goalId];
        require(goal.owner != address(0), UnknownGoal());
        require(msg.sender == goal.owner, NotGoalOwner());
        goal.open = false;
        emit GoalClosed(goalId);
    }

    // ------------------------------------------------------------ spend cycle

    /// @notice Requests authorization to spend `amount` to `payTo`.
    ///
    /// Records the terms and applies the conditional debit in one transaction.
    /// The decision is committed here but only knowable later, once Inco's
    /// compute server has processed the emitted events.
    ///
    /// @param payBy When the vendor stops holding what it quoted. The
    /// authorization expires then, so a payment that arrives after the vendor
    /// has let the thing go cannot be collected at all.
    ///
    /// @dev `asset` is deliberately not a parameter — it is read from the goal
    /// record. A 402 body is a claim, not a source of configuration.
    ///
    /// `payBy` does come from the 402, through the relay, and nothing here can
    /// check it against the vendor. It can only shorten the window. A relay
    /// that names a later time gets at most `AUTHORIZATION_WINDOW`, which is
    /// what every authorization got before `payBy` existed.
    function requestSpend(uint256 goalId, uint256 amount, address payTo, string calldata resource, uint64 payBy)
        public
        virtual
        returns (uint64 seq)
    {
        Goal storage goal = goals[goalId];
        require(goal.owner != address(0), UnknownGoal());

        // Structural validity — revert. These leak nothing.
        require(msg.sender == goal.relay, NotRelay());
        require(goal.open, GoalNotOpen());
        require(block.timestamp < goal.expiry, GoalExpired());
        require(allowlisted[goalId][payTo], PayeeNotAllowlisted());
        require(amount > 0, ZeroAmount());
        // A hold that has already ended leaves nothing to pay for.
        require(payBy > block.timestamp, PayByPassed());
        // Strictly sequential per goal: the public call counter is only
        // decremented at finalisation, so a second in-flight spend would be
        // evaluated against a stale count.
        require(pendingSeq[goalId] == 0, SpendPending());
        // Every request is a yes/no question about the encrypted limits, so
        // every request spends an attempt, approved or rejected. Reverting here
        // leaks nothing: the count is public.
        require(attemptsRemaining[goalId] > 0, NoAttemptsLeft());
        attemptsRemaining[goalId] -= 1;

        // Burns unconditionally, so a rejected attempt still appears in the trace.
        seq = ++goal.seq;

        // Written field-by-field straight into storage rather than assembled in
        // locals: the encrypted branch alone needs enough stack slots that
        // holding the whole tuple alongside it overflows.
        SpendRecord storage record = _spends[goalId][seq];
        record.payTo = payTo;
        record.amount = amount;

        // Freeze the authorization tuple. Read back verbatim on retry: EIP-3009
        // marks the whole authorization used, so regenerating this window would
        // produce a *different* authorization that could execute a second time.
        record.validAfter = uint64(block.timestamp) - 1;
        record.validBefore = uint64(block.timestamp) + AUTHORIZATION_WINDOW;
        if (record.validBefore > payBy) record.validBefore = payBy;
        if (record.validBefore > goal.expiry) record.validBefore = goal.expiry;

        record.termsHash = keccak256(
            abi.encode(
                goalId,
                seq,
                goal.payer,
                amount,
                payTo,
                goal.asset,
                resource,
                record.validAfter,
                record.validBefore
            )
        );

        // Policy predicates. The call count is public and evaluated in
        // plaintext, since branching on public data is unrestricted. The cap and
        // the budget are compared inside Inco.
        record.decision = _evaluateAndDebit(goalId, amount, goal.callsRemaining >= 1);

        pendingSeq[goalId] = seq;

        emit SpendRequested(
            goalId,
            seq,
            payTo,
            amount,
            record.termsHash,
            ebool.unwrap(record.decision),
            record.validAfter,
            record.validBefore
        );
    }

    /// @dev Evaluates the encrypted conjuncts and applies the conditional debit.
    /// Returns the revealed decision handle.
    ///
    /// One combined condition, so the revealed decision says only approve or
    /// reject, never which limit stopped the spend.
    function _evaluateAndDebit(uint256 goalId, uint256 amount, bool publicOk) private returns (ebool ok) {
        if (publicOk) {
            ok = _remainingBudget[goalId].ge(amount).and(_perCallCap[goalId].ge(amount));

            // Select the *operand*, not the result: the subtraction is then
            // always well-defined, rather than computing an underflowed value
            // on every rejected request and relying on nobody reading it.
            euint256 debit = ok.select(amount.asEuint256(), uint256(0).asEuint256());
            euint256 newBudget = _remainingBudget[goalId].sub(debit);
            // Persisted across transactions, so it needs a permanent grant.
            newBudget.allowThis();
            _remainingBudget[goalId] = newBudget;
        } else {
            // Publicly rejected: the answer is already known, so there is
            // nothing to compute and the budget handle is left untouched.
            ok = false.asEbool();
        }

        // Makes the decision publicly attestable, so the payment loop can
        // retrieve it with no wallet signature. Only ever the per-request
        // decision — never a budget handle. Reveals are permanent.
        //
        // Deliberately no `allowThis` here: `reveal` already makes the handle
        // publicly readable, and granting on top of it would be the habit that
        // leads to granting on the wrong handle.
        ok.reveal();
    }

    /// @notice Records the revealed decision for `(goalId, seq)`.
    ///
    /// @param approved The plaintext the caller claims the decision handle
    /// decrypts to. It is not taken on trust: the covalidator signatures must
    /// cover `(storedHandle, approved)`, so a wrong claim cannot verify.
    ///
    /// @dev Verification binds to the handle *this contract stored*, never one
    /// supplied by the caller. Checking the signature alone would be
    /// insufficient — a genuine attestation for a different handle could
    /// otherwise be substituted.
    ///
    /// Anyone may submit this. The attestation is unforgeable, so there is
    /// nothing to gain by calling it, and requiring the relay would let a stuck
    /// relay wedge the goal.
    function finalizeDecision(uint256 goalId, uint64 seq, bool approved, bytes[] calldata signatures) external {
        Goal storage goal = goals[goalId];
        require(goal.owner != address(0), UnknownGoal());

        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        require(!record.finalized, AlreadyFinalized());

        require(e.verifyDecryption(record.decision, approved, signatures), InvalidAttestation());

        record.finalized = true;
        record.approved = approved;
        pendingSeq[goalId] = 0;

        // The encrypted budget was already debited by `e.select` at request
        // time. The public call counter cannot be, because its decrement
        // depends on a decision that was not knowable then — so it moves here,
        // and only on approval.
        if (approved) {
            goal.callsRemaining -= 1;
        }

        emit SpendFinalized(goalId, seq, approved, ebool.unwrap(record.decision));
    }

    /// @notice Puts an approved amount back in the budget, and the call back in
    /// the count, once its authorization can never be used.
    ///
    /// That is the case when the window has closed and the token never consumed
    /// the authorization: an EIP-3009 token refuses an authorization at or after
    /// `validBefore`, so an unused one stays unused for good, and the amount
    /// cannot be both returned here and paid.
    ///
    /// @dev Anyone may call this. Both conditions are read from the chain, the
    /// window from this record and the use from the token itself, so a caller
    /// has nothing to claim. A spend that was paid fails the second check,
    /// whoever paid it.
    function reclaimExpired(uint256 goalId, uint64 seq) external virtual {
        Goal storage goal = goals[goalId];
        require(goal.owner != address(0), UnknownGoal());

        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        // A rejected spend debited zero, so it has nothing to give back.
        require(record.finalized && record.approved, NotApproved());
        require(!record.reclaimed, AlreadyReclaimed());
        require(block.timestamp >= record.validBefore, AuthorizationLive());
        require(
            !IAuthorizationState(goal.asset).authorizationState(goal.payer, _nonce(goalId, seq)),
            AuthorizationUsed()
        );

        _creditBack(goalId, seq);
    }

    /// @dev Puts an approved amount back in the budget and the call back in the
    /// count, once. The caller has established that the amount cannot be paid.
    function _creditBack(uint256 goalId, uint64 seq) internal {
        Goal storage goal = goals[goalId];
        SpendRecord storage record = _spends[goalId][seq];
        record.reclaimed = true;

        euint256 restored = _remainingBudget[goalId].add(record.amount);
        // Persisted across transactions, so it needs a permanent grant.
        restored.allowThis();
        _remainingBudget[goalId] = restored;
        // Decremented at finalisation on approval, so this cannot pass the count
        // the goal was opened with.
        goal.callsRemaining += 1;
        // The attempt is deliberately not given back. The money and the call
        // were never used, but the question was asked and answered; returning
        // the attempt would make probing free again.

        emit SpendReclaimed(goalId, seq, record.amount, euint256.unwrap(restored));
    }

    // ----------------------------------------------------------------- views

    /// @notice The frozen EIP-3009 tuple. The Authorization Signer reads every
    /// field it signs from here and accepts nothing from its caller but
    /// `(goalId, seq)`.
    function authorization(uint256 goalId, uint64 seq)
        external
        view
        returns (address payer, uint256 amount, address payTo, address asset, bytes32 nonce)
    {
        SpendRecord storage record = _spends[goalId][seq];
        Goal storage goal = goals[goalId];
        return (goal.payer, record.amount, record.payTo, goal.asset, _nonce(goalId, seq));
    }

    function validityWindow(uint256 goalId, uint64 seq)
        external
        view
        returns (uint64 validAfter, uint64 validBefore)
    {
        SpendRecord storage record = _spends[goalId][seq];
        return (record.validAfter, record.validBefore);
    }

    /// @notice Deterministic so an interrupted settlement can be retried with a
    /// byte-identical authorization. Uniqueness holds because the payer key is
    /// per-goal and `seq` is per-goal and monotonic. `abi.encode`, not
    /// `encodePacked`, so no two distinct pairs can collide via concatenation.
    function spendNonce(uint256 goalId, uint64 seq) external pure returns (bytes32) {
        return _nonce(goalId, seq);
    }

    function _nonce(uint256 goalId, uint64 seq) private pure returns (bytes32) {
        return keccak256(abi.encode(goalId, seq));
    }

    function termsHash(uint256 goalId, uint64 seq) external view returns (bytes32) {
        return _spends[goalId][seq].termsHash;
    }

    function decisionHandle(uint256 goalId, uint64 seq) external view returns (ebool) {
        return _spends[goalId][seq].decision;
    }

    function isFinalized(uint256 goalId, uint64 seq) external view returns (bool) {
        return _spends[goalId][seq].finalized;
    }

    /// @notice True only once a decision has been finalised *and* was approved.
    /// The signer must treat anything else as a refusal.
    function isApproved(uint256 goalId, uint64 seq) external view returns (bool) {
        SpendRecord storage record = _spends[goalId][seq];
        return record.finalized && record.approved;
    }

    function isReclaimed(uint256 goalId, uint64 seq) external view returns (bool) {
        return _spends[goalId][seq].reclaimed;
    }

    /// @notice True when `reclaimExpired(goalId, seq)` would succeed now.
    function isReclaimable(uint256 goalId, uint64 seq) external view virtual returns (bool) {
        Goal storage goal = goals[goalId];
        SpendRecord storage record = _spends[goalId][seq];
        if (goal.owner == address(0) || record.amount == 0) return false;
        if (!record.finalized || !record.approved || record.reclaimed) return false;
        if (block.timestamp < record.validBefore) return false;
        return !IAuthorizationState(goal.asset).authorizationState(goal.payer, _nonce(goalId, seq));
    }

    /// @notice The budget handle — an opaque `bytes32`. Exposed so the UI can
    /// show that it reveals nothing; no access is granted to anyone by
    /// returning it.
    function perCallCapHandle(uint256 goalId) external view returns (euint256) {
        return _perCallCap[goalId];
    }

    function remainingBudgetHandle(uint256 goalId) external view returns (euint256) {
        return _remainingBudget[goalId];
    }
}
