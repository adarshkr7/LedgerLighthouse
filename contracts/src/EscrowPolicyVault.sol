// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {PolicyVault} from "./PolicyVault.sol";

/// The parts of commerce-payments' AuthCaptureEscrow this vault calls.
interface IAuthCaptureEscrow {
    struct PaymentInfo {
        address operator;
        address payer;
        address receiver;
        address token;
        uint120 maxAmount;
        uint48 preApprovalExpiry;
        uint48 authorizationExpiry;
        uint48 refundExpiry;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        address feeReceiver;
        uint256 salt;
    }

    function authorize(PaymentInfo calldata info, uint256 amount, address collector, bytes calldata collectorData)
        external;
    function charge(
        PaymentInfo calldata info,
        uint256 amount,
        address collector,
        bytes calldata collectorData,
        uint256 feeAmount,
        address feeReceiver
    ) external;
    function capture(PaymentInfo calldata info, uint256 amount, uint256 feeAmount, address feeReceiver) external;
    function void(PaymentInfo calldata info) external;
    function getHash(PaymentInfo calldata info) external view returns (bytes32);
    function paymentState(bytes32 paymentInfoHash)
        external
        view
        returns (bool hasCollectedPayment, uint120 capturableAmount, uint120 refundableAmount);
}

/// @title EscrowPolicyVault: the policy vault as the operator of an x402 auth-capture escrow
///
/// @notice PolicyVault signs an EIP-3009 transfer straight to the vendor, so a
/// signature outlives whatever approval it was issued for. A signer fed a false
/// approval by its RPC, or an approval on a branch that is later dropped, gives
/// away a transfer the token will honour regardless.
///
/// Here every signature is a `receiveWithAuthorization` to the escrow's collector,
/// and its nonce is a hash of the whole PaymentInfo, operator included. The escrow
/// only takes calls from the operator, and the operator is this contract. So no
/// signature can move money without passing the checks below, on the chain as it
/// actually is at that moment. The Authorization Signer stops being trusted with
/// what the chain says for the loss bound: a lie to it can waste a signature or stall a run,
/// and cannot widen what can be paid.
///
/// ## The life of an approved spend
///
/// ```
///              authorize                 claim
///   Approved ------------> Held --------------------> Paid
///      |                    |
///      | window closes      | capture deadline passes, or the payer reclaims
///      v                    v
///   Credited back        Returned, then credited back
/// ```
///
/// `Paid` and `Credited back` are exclusive and final. See `reclaimExpired`.
///
/// ## What this does not do
///
/// A compromised enclave can still sign anything with the payer's key, including a
/// plain transfer. The vendor's bond, the dispute window and a vendor-signed hold
/// are not here. See docs/escrow-design.md.
contract EscrowPolicyVault is PolicyVault {
    /// What each escrowed spend adds to the frozen SpendRecord.
    struct Order {
        /// The vendor must claim before this; after it the funds can go back.
        uint48 captureDeadline;
        /// When non-zero, claiming requires the preimage, which publishes it.
        bytes32 keyHash;
    }

    /// The longest a vendor can keep a buyer's funds in escrow past the window.
    /// Bounds how long a compromised relay can tie up money it cannot take.
    uint64 public constant MAX_CAPTURE_WINDOW = 1 hours;

    IAuthCaptureEscrow public immutable escrow;
    /// Pinned: a caller-chosen collector is a caller-chosen token pull.
    address public immutable collector;

    mapping(uint256 goalId => mapping(uint64 seq => Order)) internal _orders;

    event KeyReleased(uint256 indexed goalId, uint64 indexed seq, bytes32 key);

    error UseRequestEscrowSpend();
    error AmountTooLarge();
    error InvalidCaptureDeadline();
    error PaymentMismatch();
    error WrongCollector();
    error PartialPayment();
    error GoalStillOpen();
    error NotVendor();
    error WrongKey();

    constructor(IAuthCaptureEscrow escrow_, address collector_) {
        escrow = escrow_;
        collector = collector_;
    }

    // ------------------------------------------------------------ spend cycle

    /// @dev There is no direct path here. One signature a signer can be talked
    /// into giving as a plain transfer undoes the property this contract exists
    /// for, so a goal on this vault can only spend through the escrow.
    function requestSpend(uint256, uint256, address, string calldata, uint64) public pure override returns (uint64) {
        revert UseRequestEscrowSpend();
    }

    /// @notice `requestSpend` plus what the escrow needs. The budget, cap, call
    /// count and attempt budget behave exactly as in PolicyVault.
    ///
    /// @param captureDeadline From the vendor, through the relay, like `payBy`.
    /// @param keyHash Zero for a vendor that delivers some other way. A relay can
    /// choose it, so on its own it does not bind the vendor to anything; binding
    /// it needs the vendor's signature over its terms.
    function requestEscrowSpend(
        uint256 goalId,
        uint256 amount,
        address payTo,
        string calldata resource,
        uint64 payBy,
        uint48 captureDeadline,
        bytes32 keyHash
    ) external returns (uint64 seq) {
        // The escrow's maxAmount is 120 bits. Truncating would make the signed
        // amount differ from the debited one.
        require(amount <= type(uint120).max, AmountTooLarge());

        seq = super.requestSpend(goalId, amount, payTo, resource, payBy);

        uint64 validBefore = _spends[goalId][seq].validBefore;
        require(
            captureDeadline >= validBefore && captureDeadline <= validBefore + MAX_CAPTURE_WINDOW
                && captureDeadline <= goals[goalId].expiry,
            InvalidCaptureDeadline()
        );
        _orders[goalId][seq] = Order({captureDeadline: captureDeadline, keyHash: keyHash});
    }

    /// @notice The escrow's own `authorize`, callable by anyone holding the
    /// payer's signature, which is what x402's "custom" operator type requires.
    /// Everything that matters is checked here against the chain, not the caller.
    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint256 amount,
        address tokenCollector,
        bytes calldata collectorData
    ) external {
        (uint256 goalId, uint64 seq) = _split(info.salt);
        // The whole struct, so a signature issued for other terms, other deadlines
        // or a record that later changed cannot be collected.
        require(keccak256(abi.encode(info)) == keccak256(abi.encode(escrowPayment(goalId, seq))), PaymentMismatch());

        SpendRecord storage record = _spends[goalId][seq];
        require(record.finalized && record.approved, NotApproved());
        require(!record.reclaimed, AlreadyReclaimed());
        // Closing a goal stops collection, which PolicyVault could not do.
        require(goals[goalId].open, GoalNotOpen());
        // All or nothing, so a held payment is one amount and `Paid` is unambiguous.
        require(amount == record.amount, PartialPayment());
        require(tokenCollector == collector, WrongCollector());

        escrow.authorize(info, amount, tokenCollector, collectorData);
    }

    /// @notice The vendor takes the held payment, publishing the key if there is
    /// one. Only the vendor may call this, so publishing a key cannot pay anyone
    /// else. The escrow enforces the deadline.
    function claim(uint256 goalId, uint64 seq, bytes32 key) external {
        SpendRecord storage record = _spends[goalId][seq];
        require(msg.sender == record.payTo, NotVendor());
        bytes32 keyHash = _orders[goalId][seq].keyHash;
        require(keyHash == bytes32(0) || keccak256(abi.encodePacked(key)) == keyHash, WrongKey());

        // No fee, no fee receiver. Whole amount only, and no refund entry point
        // exists, so `refundableAmount` stays non-zero once paid.
        escrow.capture(escrowPayment(goalId, seq), record.amount, 0, address(0));
        emit KeyReleased(goalId, seq, key);
    }

    /// @notice Credits an approved amount back once it can never be paid.
    ///
    /// PolicyVault's check cannot be reused: funding the escrow consumes a
    /// different nonce, and the old one would read as unused while the escrow still
    /// held the money. The escrow's own state decides instead.
    ///
    /// - Never collected, window closed: the token and the escrow both refuse the
    ///   signature from `preApprovalExpiry` on, so it stays uncollected for good.
    /// - Held, capture deadline passed: the escrow refuses capture from then on, so
    ///   voiding here is safe and returns the funds to the payer.
    /// - Collected with nothing held and nothing captured: the payer reclaimed it
    ///   from the escrow directly.
    /// - Captured: paid, so never credited.
    ///
    /// @dev Anyone may call this; every condition is read from the chain.
    function reclaimExpired(uint256 goalId, uint64 seq) external override {
        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        require(record.finalized && record.approved, NotApproved());
        require(!record.reclaimed, AlreadyReclaimed());

        IAuthCaptureEscrow.PaymentInfo memory info = escrowPayment(goalId, seq);
        (bool collected, uint120 held, uint120 captured) = escrow.paymentState(escrow.getHash(info));
        require(captured == 0, AuthorizationUsed());

        if (!collected) {
            require(block.timestamp >= info.preApprovalExpiry, AuthorizationLive());
            _creditBack(goalId, seq);
        } else if (held > 0) {
            require(block.timestamp >= info.authorizationExpiry, AuthorizationLive());
            // Before the call: nothing a token does in `void` can reach a credit.
            _creditBack(goalId, seq);
            escrow.void(info);
        } else {
            _creditBack(goalId, seq);
        }
    }

    /// @notice Returns the payer's remaining balance to the goal's owner, after the
    /// owner has closed the goal. The escrow's `charge`, callable by anyone holding
    /// the payer's signature.
    ///
    /// PolicyVault's sweep is a plain transfer signed on what the RPC says about the
    /// owner. Through here a lie gets the signer to sign something this check
    /// refuses. It also cannot race a vendor: held funds left the payer already.
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

    // ----------------------------------------------------------------- views

    /// @notice The PaymentInfo for `(goalId, seq)`, derived entirely from the frozen
    /// record. The signer reads this and signs its hash, and `authorize` recomputes
    /// it, so the same record always yields a byte-identical authorization.
    function escrowPayment(uint256 goalId, uint64 seq) public view returns (IAuthCaptureEscrow.PaymentInfo memory) {
        SpendRecord storage record = _spends[goalId][seq];
        require(record.amount != 0, UnknownSpend());
        Goal storage goal = goals[goalId];
        uint48 captureDeadline = _orders[goalId][seq].captureDeadline;
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(this),
            payer: goal.payer,
            receiver: record.payTo,
            token: goal.asset,
            // Safe: requestEscrowSpend refuses an amount above 120 bits.
            // forge-lint: disable-next-line(unsafe-typecast)
            maxAmount: uint120(record.amount),
            preApprovalExpiry: uint48(record.validBefore),
            authorizationExpiry: captureDeadline,
            refundExpiry: captureDeadline,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: (goalId << 64) | seq
        });
    }

    function order(uint256 goalId, uint64 seq) external view returns (Order memory) {
        return _orders[goalId][seq];
    }

    /// @notice True when `reclaimExpired(goalId, seq)` would succeed now.
    function isReclaimable(uint256 goalId, uint64 seq) external view override returns (bool) {
        SpendRecord storage record = _spends[goalId][seq];
        if (record.amount == 0 || !record.finalized || !record.approved || record.reclaimed) return false;

        IAuthCaptureEscrow.PaymentInfo memory info = escrowPayment(goalId, seq);
        (bool collected, uint120 held, uint120 captured) = escrow.paymentState(escrow.getHash(info));
        if (captured > 0) return false;
        if (!collected) return block.timestamp >= info.preApprovalExpiry;
        if (held > 0) return block.timestamp >= info.authorizationExpiry;
        return true;
    }

    function _split(uint256 salt) private pure returns (uint256 goalId, uint64 seq) {
        // Truncation is the point: the sequence number is the low 64 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (salt >> 64, uint64(salt));
    }
}
