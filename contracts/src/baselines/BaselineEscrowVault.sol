// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAuthCaptureEscrow} from "../EscrowPolicyVault.sol";

/// @title BaselineEscrowVault: EscrowPolicyVault's escrow path with the policy engine left open
///
/// @notice A comparator for the paper, not a product. It keeps everything of
/// EscrowPolicyVault that is not the confidential policy: enrollment, the public call
/// and attempt counts, the frozen record, the escrow as the only collection path, and
/// the same reclaim rules. Subclasses decide a request in one transaction:
///
///   - PlaintextEscrowVault keeps the budget and cap on chain in the clear (a plain
///     smart-account spending limit), which isolates what confidentiality costs.
///   - EnclavePolicyVault keeps them inside the signer's enclave and accepts its
///     signed decisions, anchored to on-chain state so the enclave cannot be rolled
///     back, which is the enclave-only design the paper compares against.
///
/// Differences from EscrowPolicyVault, all because the decision is immediate: no
/// pending request, no finalizeDecision, and the call count moves at request time.
abstract contract BaselineEscrowVault is EIP712 {
    struct Goal {
        address owner;
        address payer;
        address relay;
        address asset;
        uint32 callsRemaining;
        uint32 attemptsRemaining;
        uint64 expiry;
        uint64 seq;
        bool open;
    }

    struct SpendRecord {
        address payTo;
        uint120 amount;
        uint48 validBefore;
        uint48 captureDeadline;
        bool approved;
        bool reclaimed;
    }

    struct GoalParams {
        uint32 callsRemaining;
        uint32 maxAttempts;
        address payer;
        address relay;
        address asset;
        uint64 expiry;
        address[] allowlist;
    }

    uint64 public constant AUTHORIZATION_WINDOW = 1 hours;
    uint64 public constant MAX_CAPTURE_WINDOW = 1 hours;
    bytes32 public constant ENROLLMENT_TYPEHASH =
        keccak256("Enrollment(address payer,address owner,bytes32 enrollmentId)");

    IAuthCaptureEscrow public immutable escrow;
    address public immutable collector;
    address public immutable enrollmentSigner;

    uint256 public goalCount;
    mapping(uint256 goalId => Goal) public goals;
    mapping(uint256 goalId => mapping(address payee => bool)) public allowlisted;
    mapping(uint256 goalId => mapping(uint64 seq => SpendRecord)) internal _spends;
    mapping(address payer => uint256 goalId) public payerGoal;

    event GoalOpened(uint256 indexed goalId, address indexed owner, address indexed payer);
    event SpendDecided(uint256 indexed goalId, uint64 indexed seq, address indexed payTo, uint256 amount, bool approved);
    event SpendReclaimed(uint256 indexed goalId, uint64 indexed seq, uint256 amount);

    error InvalidEnrollment();
    error PayerAlreadyBound();
    error InvalidGoal();
    error UnknownGoal();
    error NotRelay();
    error NotGoalOwner();
    error GoalNotOpen();
    error GoalExpired();
    error PayeeNotAllowlisted();
    error ZeroAmount();
    error AmountTooLarge();
    error PayByPassed();
    error NoAttemptsLeft();
    error InvalidCaptureDeadline();
    error UnknownSpend();
    error NotApproved();
    error AlreadyReclaimed();
    error AuthorizationLive();
    error AuthorizationUsed();
    error PaymentMismatch();
    error WrongCollector();
    error PartialPayment();
    error GoalStillOpen();
    error NotVendor();

    constructor(IAuthCaptureEscrow escrow_, address collector_, address enrollmentSigner_, string memory name)
        EIP712(name, "1")
    {
        escrow = escrow_;
        collector = collector_;
        enrollmentSigner = enrollmentSigner_;
    }

    // ------------------------------------------------------------- policy hooks

    /// Decides one request and applies its debit, in the same transaction.
    function _decide(uint256 goalId, uint64 seq, uint256 amount, address payTo, bytes calldata policyData)
        internal
        virtual
        returns (bool approved);

    /// Gives an approved amount back to the policy once it can never be paid.
    function _credit(uint256 goalId, uint256 amount) internal virtual;

    // ------------------------------------------------------------------- setup

    function _openGoal(GoalParams calldata params, bytes32 enrollmentId, bytes calldata signature)
        internal
        returns (uint256 goalId)
    {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ENROLLMENT_TYPEHASH, params.payer, msg.sender, enrollmentId)));
        (address signer, ECDSA.RecoverError failure,) = ECDSA.tryRecover(digest, signature);
        require(failure == ECDSA.RecoverError.NoError && signer == enrollmentSigner, InvalidEnrollment());
        require(payerGoal[params.payer] == 0, PayerAlreadyBound());
        require(
            params.payer != address(0) && params.relay != address(0) && params.asset != address(0)
                && params.expiry > block.timestamp && params.callsRemaining > 0
                && params.maxAttempts >= params.callsRemaining && params.allowlist.length > 0,
            InvalidGoal()
        );
        goalId = ++goalCount;
        goals[goalId] = Goal({
            owner: msg.sender,
            payer: params.payer,
            relay: params.relay,
            asset: params.asset,
            callsRemaining: params.callsRemaining,
            attemptsRemaining: params.maxAttempts,
            expiry: params.expiry,
            seq: 0,
            open: true
        });
        payerGoal[params.payer] = goalId;
        for (uint256 i = 0; i < params.allowlist.length; i++) {
            allowlisted[goalId][params.allowlist[i]] = true;
        }
        emit GoalOpened(goalId, msg.sender, params.payer);
    }

    function closeGoal(uint256 goalId) external {
        require(msg.sender == goals[goalId].owner, NotGoalOwner());
        goals[goalId].open = false;
    }

    // -------------------------------------------------------------- the request

    /// @notice Request and decision in one transaction. Same structural checks, the
    /// same window and the same bounded capture deadline as EscrowPolicyVault.
    function requestEscrowSpend(
        uint256 goalId,
        uint256 amount,
        address payTo,
        uint64 payBy,
        uint48 captureDeadline,
        bytes calldata policyData
    ) external returns (uint64 seq, bool approved) {
        Goal storage goal = goals[goalId];
        require(goal.owner != address(0), UnknownGoal());
        require(msg.sender == goal.relay, NotRelay());
        require(goal.open, GoalNotOpen());
        require(block.timestamp < goal.expiry, GoalExpired());
        require(allowlisted[goalId][payTo], PayeeNotAllowlisted());
        require(amount > 0, ZeroAmount());
        require(amount <= type(uint120).max, AmountTooLarge());
        require(payBy > block.timestamp, PayByPassed());
        require(goal.attemptsRemaining > 0, NoAttemptsLeft());
        goal.attemptsRemaining -= 1;

        seq = ++goal.seq;
        uint64 validBefore = uint64(block.timestamp) + AUTHORIZATION_WINDOW;
        if (validBefore > payBy) validBefore = payBy;
        if (validBefore > goal.expiry) validBefore = goal.expiry;
        require(
            captureDeadline >= validBefore && captureDeadline <= validBefore + MAX_CAPTURE_WINDOW
                && captureDeadline <= goal.expiry,
            InvalidCaptureDeadline()
        );

        approved = goal.callsRemaining >= 1 && _decide(goalId, seq, amount, payTo, policyData);
        if (approved) goal.callsRemaining -= 1;

        _spends[goalId][seq] = SpendRecord({
            payTo: payTo,
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint120(amount),
            // forge-lint: disable-next-line(unsafe-typecast)
            validBefore: uint48(validBefore),
            captureDeadline: captureDeadline,
            approved: approved,
            reclaimed: false
        });
        emit SpendDecided(goalId, seq, payTo, amount, approved);
    }

    // ------------------------------------------------------- escrow, unchanged

    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external {
        (uint256 goalId, uint64 seq) = _split(info.salt);
        require(keccak256(abi.encode(info)) == keccak256(abi.encode(escrowPayment(goalId, seq))), PaymentMismatch());
        SpendRecord storage record = _spends[goalId][seq];
        require(record.approved, NotApproved());
        require(!record.reclaimed, AlreadyReclaimed());
        require(goals[goalId].open, GoalNotOpen());
        require(amount == record.amount, PartialPayment());
        require(tokenCollector == collector, WrongCollector());
        escrow.authorize(info, amount, tokenCollector, collectorData);
    }

    function claim(uint256 goalId, uint64 seq) external {
        SpendRecord storage record = _spends[goalId][seq];
        require(msg.sender == record.payTo, NotVendor());
        escrow.capture(escrowPayment(goalId, seq), record.amount, 0, address(0));
    }

    function reclaimExpired(uint256 goalId, uint64 seq) external {
        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        require(record.approved, NotApproved());
        require(!record.reclaimed, AlreadyReclaimed());
        IAuthCaptureEscrow.PaymentInfo memory info = escrowPayment(goalId, seq);
        (bool collected, uint120 held, uint120 captured) = escrow.paymentState(escrow.getHash(info));
        require(captured == 0, AuthorizationUsed());
        if (!collected) {
            require(block.timestamp >= info.preApprovalExpiry, AuthorizationLive());
        } else if (held > 0) {
            require(block.timestamp >= info.authorizationExpiry, AuthorizationLive());
        }
        record.reclaimed = true;
        goals[goalId].callsRemaining += 1;
        _credit(goalId, record.amount);
        emit SpendReclaimed(goalId, seq, record.amount);
        if (collected && held > 0) escrow.void(info);
    }

    function charge(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData,
        uint256 feeAmount,
        address feeReceiver
    ) external {
        (uint256 goalId, uint64 seq) = _split(info.salt);
        Goal storage goal = goals[goalId];
        require(seq == 0 && goal.owner != address(0), UnknownGoal());
        require(!goal.open, GoalStillOpen());
        require(
            info.operator == address(this) && info.payer == goal.payer && info.receiver == goal.owner
                && info.token == goal.asset && info.maxFeeBps == 0 && info.feeReceiver == address(0) && feeAmount == 0
                && feeReceiver == address(0),
            PaymentMismatch()
        );
        require(amount == info.maxAmount, PartialPayment());
        require(tokenCollector == collector, WrongCollector());
        escrow.charge(info, amount, tokenCollector, collectorData, 0, address(0));
    }

    function escrowPayment(uint256 goalId, uint64 seq) public view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        Goal storage goal = goals[goalId];
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(this),
            payer: goal.payer,
            receiver: record.payTo,
            token: goal.asset,
            maxAmount: record.amount,
            preApprovalExpiry: record.validBefore,
            authorizationExpiry: record.captureDeadline,
            refundExpiry: record.captureDeadline,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: (goalId << 64) | seq
        });
    }

    function enrollmentDigest(address payer, address owner, bytes32 enrollmentId) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ENROLLMENT_TYPEHASH, payer, owner, enrollmentId)));
    }

    function spend(uint256 goalId, uint64 seq) external view returns (SpendRecord memory) {
        return _spends[goalId][seq];
    }

    function _split(uint256 salt) private pure returns (uint256 goalId, uint64 seq) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return (salt >> 64, uint64(salt));
    }
}
