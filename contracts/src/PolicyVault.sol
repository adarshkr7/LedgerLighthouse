// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ebool, euint256, e, inco} from "@inco/lightning/src/Lib.sol";

/// @title PolicyVault — confidential spending policy for an autonomous agent
///
/// @notice Enforces a spending policy whose budget is confidential, so that
/// compromising the AI orchestrator does not confer arbitrary spending
/// authority. The orchestrator may only call `requestSpend` with public terms;
/// it can neither read nor alter the budget, nor forge an approval.
///
/// ## Hackathon-v1 simplification
///
/// Only `remainingBudget` is encrypted. `perCallCap` and `callsRemaining` are
/// public plaintext. This narrows what is hidden — a vendor can now see the
/// per-call ceiling — but leaves the security property intact: the headline
/// secret (how much is left to spend) stays confidential, and the decision is
/// still produced by Inco and verified on chain.
///
/// ## Where a condition is enforced, and why it differs
///
/// Two kinds of checks, deliberately handled differently:
///
///   - **Structural validity** — allowlist, asset, expiry, goal open, caller is
///     the relay. These `revert`. A malformed request is not a policy decision
///     and should never reach the chain as one.
///   - **Policy** — `perCallCap`, `callsRemaining`, `remainingBudget`. These
///     resolve into the decision rather than reverting, *including the public
///     ones*. An over-cap request must land on chain and bounce visibly. If it
///     reverted, there would be no record, and the bounce is the product.
///
/// ## Write-ahead ordering
///
/// The encrypted debit is applied unconditionally via `e.select` in the same
/// transaction that records the terms — before anyone, including the caller,
/// can learn whether it was approved. Inco makes this the only expressible
/// option, since branching on an encrypted condition is impossible.
contract PolicyVault {
    using e for euint256;
    using e for ebool;
    using e for uint256;
    using e for bool;
    using e for bytes;

    // ------------------------------------------------------------------ types

    struct Goal {
        address owner; // opened the goal; only they may close it
        address payer; // ephemeral EOA that will sign EIP-3009. Immutable.
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
    }

    struct OpenGoalParams {
        bytes budgetCiphertext;
        uint256 perCallCap;
        uint32 callsRemaining;
        address payer;
        address relay;
        address asset;
        uint64 expiry;
        address[] allowlist;
    }

    // ------------------------------------------------------------------ state

    /// How long an EIP-3009 authorization stays valid once issued. Clamped to
    /// the goal's expiry so an authorization can never outlive its goal.
    uint64 public constant AUTHORIZATION_WINDOW = 1 hours;

    uint256 public goalCount;

    mapping(uint256 goalId => Goal) public goals;
    /// Public, so the value is plainly visible — that is the simplification.
    mapping(uint256 goalId => uint256) public perCallCap;
    /// Encrypted. The vault never sees a plaintext balance.
    mapping(uint256 goalId => euint256) internal _remainingBudget;
    mapping(uint256 goalId => mapping(address payee => bool)) public allowlisted;
    mapping(uint256 goalId => mapping(uint64 seq => SpendRecord)) internal _spends;
    /// 0 when no spend awaits finalisation.
    mapping(uint256 goalId => uint64) public pendingSeq;

    // ----------------------------------------------------------------- events

    event GoalOpened(
        uint256 indexed goalId,
        address indexed owner,
        address indexed payer,
        address relay,
        address asset,
        uint256 perCallCap,
        uint32 callsRemaining,
        uint64 expiry,
        bytes32 budgetHandle
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

    // ----------------------------------------------------------------- errors

    error FeeNotPaid();
    error InvalidPayer();
    error InvalidRelay();
    error InvalidAsset();
    error InvalidExpiry();
    error InvalidCap();
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

    // ------------------------------------------------------------- open/close

    /// @notice Opens a goal. **Must be sent by the user's own wallet**: the
    /// budget ciphertext is bound to the address that produced it, and the
    /// on-chain conversion takes `msg.sender`. The orchestrator therefore
    /// structurally cannot open a goal.
    ///
    /// @dev Payable because converting a client ciphertext into a handle is the
    /// one operation here that charges the Inco fee. Trivial encryption,
    /// comparison, select, sub and reveal do not, which is why `requestSpend`
    /// is not payable.
    function openGoal(OpenGoalParams calldata params) external payable returns (uint256 goalId) {
        require(msg.value == inco.getFee(), FeeNotPaid());
        require(params.payer != address(0), InvalidPayer());
        require(params.relay != address(0), InvalidRelay());
        require(params.asset != address(0), InvalidAsset());
        require(params.expiry > block.timestamp, InvalidExpiry());
        require(params.perCallCap > 0, InvalidCap());
        require(params.callsRemaining > 0, InvalidCallCount());
        require(params.allowlist.length > 0, EmptyAllowlist());

        goalId = ++goalCount;

        // Binds the ciphertext to the sender. A ciphertext prepared for anyone
        // else yields a handle this call cannot use.
        euint256 budget = params.budgetCiphertext.newEuint256(msg.sender);
        // Persisted across transactions, so it needs a permanent grant —
        // without this the vault could never compute over its own budget again.
        budget.allowThis();
        _remainingBudget[goalId] = budget;

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
        perCallCap[goalId] = params.perCallCap;

        for (uint256 i = 0; i < params.allowlist.length; i++) {
            allowlisted[goalId][params.allowlist[i]] = true;
        }

        emit GoalOpened(
            goalId,
            msg.sender,
            params.payer,
            params.relay,
            params.asset,
            params.perCallCap,
            params.callsRemaining,
            params.expiry,
            euint256.unwrap(budget)
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
    /// @dev `asset` is deliberately not a parameter — it is read from the goal
    /// record. A 402 body is a claim, not a source of configuration.
    function requestSpend(uint256 goalId, uint256 amount, address payTo, string calldata resource)
        external
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
        // Strictly sequential per goal: the public call counter is only
        // decremented at finalisation, so a second in-flight spend would be
        // evaluated against a stale count.
        require(pendingSeq[goalId] == 0, SpendPending());

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

        // Policy predicates. The public ones are evaluated in plaintext —
        // branching on public data is unrestricted — and only the budget
        // comparison touches Inco.
        record.decision =
            _evaluateAndDebit(goalId, amount, amount <= perCallCap[goalId] && goal.callsRemaining >= 1);

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

    /// @dev Evaluates the encrypted conjunct and applies the conditional debit.
    /// Returns the revealed decision handle.
    function _evaluateAndDebit(uint256 goalId, uint256 amount, bool publicOk) private returns (ebool ok) {
        if (publicOk) {
            ok = _remainingBudget[goalId].ge(amount);

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
        return (goal.payer, record.amount, record.payTo, goal.asset, keccak256(abi.encode(goalId, seq)));
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

    /// @notice The budget handle — an opaque `bytes32`. Exposed so the UI can
    /// show that it reveals nothing; no access is granted to anyone by
    /// returning it.
    function remainingBudgetHandle(uint256 goalId) external view returns (euint256) {
        return _remainingBudget[goalId];
    }
}
