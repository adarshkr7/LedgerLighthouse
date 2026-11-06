// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Test amounts and block times, all far below the sizes they are cast to.
// forge-lint: disable-start(unsafe-typecast)

import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";
import {ebool, inco} from "@inco/lightning/src/Lib.sol";
import {CREATE_X_ADDRESS, CREATE_X_DEPLOYER} from "@inco/lightning/src/pasted-dependencies/CreateX.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {EscrowPolicyVault, IAuthCaptureEscrow} from "../src/EscrowPolicyVault.sol";

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

interface IEscrowReclaim {
    function reclaim(IAuthCaptureEscrow.PaymentInfo calldata info) external;
}

/// Runs against the real deployed escrow, collector and USDC on a fork of Base
/// Sepolia, because the whole point is how those contracts bind a signature. Inco
/// is the test double, as in PolicyVault.t.sol.
///
/// Needs a network, so it skips unless asked:
///   ESCROW_FORK_RPC=https://sepolia.base.org forge test --match-contract EscrowPolicyVault
contract EscrowPolicyVaultTest is IncoTest {
    IAuthCaptureEscrow constant ESCROW = IAuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    IUSDC constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);

    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// Not the demo's 0x1111…, which holds real test USDC on the forked chain.
    address constant VENDOR = address(uint160(uint256(keccak256("escrow test vendor"))));
    address constant STRANGER = address(0xBADBAD);
    string constant RESOURCE = "https://api.example.com/resource/honest";

    uint256 constant FUNDED = 1_000_000; // 1.00 USDC
    uint64 constant HOLD = 10 minutes;
    uint48 constant DELIVERY = 5 minutes;
    bytes32 constant KEY = keccak256("the vendor's key");

    uint256 payerKey = 0xA11CE;
    address payer;

    EscrowPolicyVault vault;
    uint256 goalId;

    function setUp() public override {
        string memory rpc = vm.envOr("ESCROW_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        // Inco's test double deploys CreateX and itself at fixed addresses, which a
        // live network already occupies. Clear them, in this fork only.
        _clear(CREATE_X_ADDRESS);
        _clear(address(inco));
        _clear(0xad24561EE8f1f2C6309a5D5394523b0dFA43659a); // CREATE3 stub for Inco's proxy
        _clear(0x867758FFe098fB0D74826A8DCf60127696440f09); // Inco's verifier
        _clear(0xbdB58BC3C9C50E751bDd4093076BDE9ADeb43fF9); // CREATE3 stub for the verifier
        vm.setNonceUnsafe(CREATE_X_DEPLOYER, 0);
        super.setUp();

        vault = new EscrowPolicyVault(ESCROW, COLLECTOR);
        payer = vm.addr(payerKey);
        deal(address(USDC), payer, FUNDED);
        // B0 = C = 0.20, as in the reorganization example the design answers.
        goalId = _open(200_000, 200_001, 1, 4, payer);
    }

    // ---------------------------------------------------------------- helpers

    function _clear(address occupied) internal {
        vm.etch(occupied, hex"");
        vm.setNonceUnsafe(occupied, 0);
    }

    function _open(uint256 budget, uint256 cap, uint32 calls, uint32 attempts, address goalPayer)
        internal
        returns (uint256 id)
    {
        address[] memory allowlist = new address[](1);
        allowlist[0] = VENDOR;
        PolicyVault.OpenGoalParams memory params = PolicyVault.OpenGoalParams({
            budgetCiphertext: fakePrepareEuint256Ciphertext(budget, alice, address(vault)),
            perCallCapCiphertext: fakePrepareEuint256Ciphertext(cap, alice, address(vault)),
            callsRemaining: calls,
            maxAttempts: attempts,
            payer: goalPayer,
            relay: address(this),
            asset: address(USDC),
            expiry: uint64(block.timestamp + 7 days),
            allowlist: allowlist
        });
        uint256 fee = 2 * inco.getFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        id = vault.openGoal{value: fee}(params);
        processAllOperations();
    }

    function _request(uint256 amount) internal returns (uint64 seq) {
        uint64 payBy = uint64(block.timestamp) + HOLD;
        seq = vault.requestEscrowSpend(
            goalId, amount, VENDOR, RESOURCE, payBy, uint48(payBy) + DELIVERY, keccak256(abi.encodePacked(KEY))
        );
        processAllOperations();
    }

    function _finalize(uint64 seq) internal returns (bool approved) {
        ebool handle = vault.decisionHandle(goalId, seq);
        approved = getBoolValue(handle);
        (, bytes[] memory signatures) = getDecryptionAttestation(
            address(this), HandleWithProof({handle: ebool.unwrap(handle), proof: _emptyAllowanceProof()})
        );
        vault.finalizeDecision(goalId, seq, approved, signatures);
    }

    function _approved(uint256 amount) internal returns (uint64 seq) {
        seq = _request(amount);
        assertTrue(_finalize(seq), "expected approval");
    }

    /// What the enclave would sign: exactly the signature a payment needs.
    function _sign(IAuthCaptureEscrow.PaymentInfo memory info) internal view returns (bytes memory) {
        address actualPayer = info.payer;
        info.payer = address(0);
        bytes32 nonce = ESCROW.getHash(info);
        info.payer = actualPayer;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, actualPayer, COLLECTOR, uint256(info.maxAmount), 0, info.preApprovalExpiry, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _collect(uint64 seq) internal returns (IAuthCaptureEscrow.PaymentInfo memory info) {
        info = vault.escrowPayment(goalId, seq);
        vm.prank(STRANGER); // permissionless, as x402's custom operator requires
        vault.authorize(info, info.maxAmount, COLLECTOR, _sign(info));
    }

    function _budget() internal returns (uint256) {
        processAllOperations();
        return getUint256Value(vault.remainingBudgetHandle(goalId));
    }

    function _callsLeft() internal view returns (uint32 calls) {
        (,,,, calls,,,) = vault.goals(goalId);
    }

    // ------------------------------------------------------- the signer service

    /// A signature produced by the TypeScript signer, for the fixed payment in
    /// services/signer/src/escrow-service.test.ts. Submitted here to the deployed USDC,
    /// collector and escrow, so a mistake in any field of the signer's hashing or typed
    /// data makes the token refuse it. The operator is pranked: this checks the signer
    /// against the deployed contracts, and the vault's own checks are tested below.
    function testTheSignerServicesSignatureIsAcceptedByTheDeployedContracts() public {
        address operator = address(uint160(0xAB0B1));
        address receiver = address(uint160(0x7E57));
        IAuthCaptureEscrow.PaymentInfo memory info = IAuthCaptureEscrow.PaymentInfo({
            operator: operator,
            payer: payer,
            receiver: receiver,
            token: address(USDC),
            maxAmount: 100_000,
            preApprovalExpiry: 4102444800,
            authorizationExpiry: 4102445100,
            refundExpiry: 4102445100,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: (uint256(1) << 64) | 1
        });
        bytes memory signature =
            hex"16da224649ab955655569ae0f24e443910acb33263451cd2c5b383d85f6939ae743f8e9be901b93dc1d2ceb0d3f516fe3f793fb34a3b915115ddf101c1011e651b";

        vm.prank(operator);
        ESCROW.authorize(info, 100_000, COLLECTOR, signature);
        assertEq(USDC.balanceOf(payer), FUNDED - 100_000, "the token accepted it");

        vm.prank(operator);
        ESCROW.capture(info, 100_000, 0, address(0));
        assertEq(USDC.balanceOf(receiver), 100_000, "and the escrow paid it out");
    }

    // ------------------------------------------------------------- happy path

    function testClaimPaysTheVendorAndPublishesTheKey() public {
        uint64 seq = _approved(100_000);
        _collect(seq);
        assertEq(USDC.balanceOf(payer), FUNDED - 100_000, "the payer funded the hold");
        assertEq(USDC.balanceOf(VENDOR), 0, "the vendor holds nothing yet");

        vm.expectEmit(true, true, false, true, address(vault));
        emit EscrowPolicyVault.KeyReleased(goalId, seq, KEY);
        vm.prank(VENDOR);
        vault.claim(goalId, seq, KEY);
        assertEq(USDC.balanceOf(VENDOR), 100_000);

        vm.warp(block.timestamp + 1 days);
        assertFalse(vault.isReclaimable(goalId, seq));
        vm.expectRevert(PolicyVault.AuthorizationUsed.selector);
        vault.reclaimExpired(goalId, seq);
    }

    // --------------------------------------------- a signature alone buys nothing

    /// The property the design exists for: the signer was lied to about a record
    /// that does not exist. It signs, and the signature is useless.
    function testASignatureForAnInventedApprovalCannotBeCollected() public {
        IAuthCaptureEscrow.PaymentInfo memory forged = IAuthCaptureEscrow.PaymentInfo({
            operator: address(vault),
            payer: payer,
            receiver: STRANGER,
            token: address(USDC),
            maxAmount: uint120(FUNDED),
            preApprovalExpiry: uint48(block.timestamp + HOLD),
            authorizationExpiry: uint48(block.timestamp + HOLD + DELIVERY),
            refundExpiry: uint48(block.timestamp + HOLD + DELIVERY),
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: (goalId << 64) | 99
        });
        bytes memory signature = _sign(forged);

        vm.expectRevert(PolicyVault.UnknownSpend.selector);
        vault.authorize(forged, FUNDED, COLLECTOR, signature);
        assertEq(USDC.balanceOf(payer), FUNDED);
    }

    /// Astra's counterexample against PolicyVault: B0 = C = 0.20, n0 = 1. A dropped
    /// branch approves 0.10 and the signer releases it; the canonical chain rejects
    /// that sequence number and approves 0.20 at the next. With plain transfers the
    /// token pays both, 0.30. Here the first signature is dead on the canonical chain.
    function testASignatureFromADroppedBranchIsDead() public {
        uint256 fork = vm.snapshotState();
        IAuthCaptureEscrow.PaymentInfo memory dropped;
        bytes memory droppedSignature;
        {
            uint64 seq = _approved(100_000);
            dropped = vault.escrowPayment(goalId, seq);
            droppedSignature = _sign(dropped);
        }
        vm.revertToState(fork);

        // The canonical chain: over the limits at seq 1, then 0.20 at seq 2.
        vm.warp(block.timestamp + 2);
        uint64 rejected = _request(300_000);
        assertFalse(_finalize(rejected));
        assertEq(rejected, uint64(dropped.salt), "the same sequence number, with other terms");
        uint64 approved = _approved(200_000);

        vm.expectRevert(EscrowPolicyVault.PaymentMismatch.selector);
        vault.authorize(dropped, dropped.maxAmount, COLLECTOR, droppedSignature);

        _collect(approved);
        vm.prank(VENDOR);
        vault.claim(goalId, approved, KEY);
        assertEq(USDC.balanceOf(VENDOR), 200_000, "total paid is the bound, not 0.30");
    }

    function testTheEscrowAndTheTokenRefuseAnyoneButTheVault() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bytes memory signature = _sign(info);

        vm.expectRevert();
        ESCROW.authorize(info, info.maxAmount, COLLECTOR, signature);

        address actualPayer = info.payer;
        info.payer = address(0);
        bytes32 nonce = ESCROW.getHash(info);
        info.payer = actualPayer;
        vm.expectRevert(); // receiveWithAuthorization: only `to` may submit
        USDC.receiveWithAuthorization(payer, COLLECTOR, info.maxAmount, 0, info.preApprovalExpiry, nonce, signature);
    }

    function testOtherTermsCannotBeCollected() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        info.receiver = STRANGER;
        bytes memory signature = _sign(info);
        vm.expectRevert(EscrowPolicyVault.PaymentMismatch.selector);
        vault.authorize(info, info.maxAmount, COLLECTOR, signature);
    }

    function testAPendingOrRejectedRequestCannotBeCollected() public {
        uint64 pending = _request(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, pending);
        bytes memory signature = _sign(info);
        vm.expectRevert(PolicyVault.NotApproved.selector);
        vault.authorize(info, info.maxAmount, COLLECTOR, signature);
        _finalize(pending);

        uint64 rejected = _request(150_000); // over what is left
        assertFalse(_finalize(rejected));
        info = vault.escrowPayment(goalId, rejected);
        signature = _sign(info);
        vm.expectRevert(PolicyVault.NotApproved.selector);
        vault.authorize(info, info.maxAmount, COLLECTOR, signature);
    }

    function testACallerCannotChooseTheCollectorOrAPartialAmount() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bytes memory signature = _sign(info);
        vm.expectRevert(EscrowPolicyVault.WrongCollector.selector);
        vault.authorize(info, info.maxAmount, STRANGER, signature);
        vm.expectRevert(EscrowPolicyVault.PartialPayment.selector);
        vault.authorize(info, 1, COLLECTOR, signature);
    }

    function testADirectRequestIsRefused() public {
        vm.expectRevert(EscrowPolicyVault.UseRequestEscrowSpend.selector);
        vault.requestSpend(goalId, 100_000, VENDOR, RESOURCE, uint64(block.timestamp) + HOLD);
    }

    // -------------------------------------------------------------- non-delivery

    function testAVendorThatNeverClaimsLosesThePaymentAndTheBudgetComesBack() public {
        uint64 seq = _approved(100_000);
        assertEq(_budget(), 100_000);
        assertEq(_callsLeft(), 0);
        uint32 attempts = vault.attemptsRemaining(goalId);
        IAuthCaptureEscrow.PaymentInfo memory info = _collect(seq);

        vm.expectRevert(PolicyVault.AuthorizationLive.selector);
        vault.reclaimExpired(goalId, seq);

        vm.warp(info.authorizationExpiry);
        vm.prank(VENDOR);
        vm.expectRevert(); // the escrow's AfterAuthorizationExpiry
        vault.claim(goalId, seq, KEY);

        assertTrue(vault.isReclaimable(goalId, seq));
        vm.prank(STRANGER);
        vault.reclaimExpired(goalId, seq);

        assertEq(USDC.balanceOf(payer), FUNDED, "the funds are back with the payer");
        assertEq(_budget(), 200_000, "the budget is restored");
        assertEq(_callsLeft(), 1, "the call is restored");
        assertEq(vault.attemptsRemaining(goalId), attempts, "the attempt is not");

        vm.expectRevert(PolicyVault.AlreadyReclaimed.selector);
        vault.reclaimExpired(goalId, seq);
    }

    function testAnUncollectedApprovalComesBackOnceItsWindowCloses() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bytes memory signature = _sign(info);

        vm.expectRevert(PolicyVault.AuthorizationLive.selector);
        vault.reclaimExpired(goalId, seq);

        vm.warp(info.preApprovalExpiry);
        vault.reclaimExpired(goalId, seq);
        assertEq(_budget(), 200_000);

        vm.expectRevert(PolicyVault.AlreadyReclaimed.selector);
        vault.authorize(info, info.maxAmount, COLLECTOR, signature);
    }

    /// The payer can also take its hold back from the escrow directly once the
    /// deadline passes. The budget credit must still happen, and only once.
    function testAPayerReclaimFromTheEscrowStillCreditsTheBudgetOnce() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = _collect(seq);
        vm.warp(info.authorizationExpiry);
        vm.prank(payer);
        IEscrowReclaim(address(ESCROW)).reclaim(info);
        assertEq(USDC.balanceOf(payer), FUNDED);

        vault.reclaimExpired(goalId, seq);
        assertEq(_budget(), 200_000);
        vm.expectRevert(PolicyVault.AlreadyReclaimed.selector);
        vault.reclaimExpired(goalId, seq);
    }

    /// The loss bound through a reclaim: the restored authority can be spent, and
    /// what is paid in total never passes the budget.
    function testPaidNeverPassesTheBudgetAcrossAReclaim() public {
        uint64 first = _approved(200_000);
        IAuthCaptureEscrow.PaymentInfo memory info = _collect(first);
        vm.warp(info.authorizationExpiry);
        vault.reclaimExpired(goalId, first);

        uint64 second = _approved(200_000);
        _collect(second);
        vm.prank(VENDOR);
        vault.claim(goalId, second, KEY);
        assertEq(USDC.balanceOf(VENDOR), 200_000);

        uint64 third = _request(1);
        assertFalse(_finalize(third), "calls and budget are spent");
    }

    // ------------------------------------------------------------------- claiming

    function testOnlyTheVendorWithTheRightKeyCanClaim() public {
        uint64 seq = _approved(100_000);
        _collect(seq);

        vm.prank(STRANGER);
        vm.expectRevert(EscrowPolicyVault.NotVendor.selector);
        vault.claim(goalId, seq, KEY);

        vm.prank(VENDOR);
        vm.expectRevert(EscrowPolicyVault.WrongKey.selector);
        vault.claim(goalId, seq, keccak256("not the key"));

        assertEq(USDC.balanceOf(VENDOR), 0);
    }

    function testAClaimOnAnUncollectedOrPaidPaymentFails() public {
        uint64 seq = _approved(100_000);
        vm.prank(VENDOR);
        vm.expectRevert(); // the escrow's InsufficientAuthorization
        vault.claim(goalId, seq, KEY);

        _collect(seq);
        vm.prank(VENDOR);
        vault.claim(goalId, seq, KEY);
        vm.prank(VENDOR);
        vm.expectRevert();
        vault.claim(goalId, seq, KEY);
        assertEq(USDC.balanceOf(VENDOR), 100_000, "paid once");
    }

    function testTheCaptureDeadlineIsBounded() public {
        uint64 payBy = uint64(block.timestamp) + HOLD;
        vm.expectRevert(EscrowPolicyVault.InvalidCaptureDeadline.selector);
        vault.requestEscrowSpend(goalId, 100_000, VENDOR, RESOURCE, payBy, uint48(payBy) - 1, bytes32(0));
        vm.expectRevert(EscrowPolicyVault.InvalidCaptureDeadline.selector);
        vault.requestEscrowSpend(goalId, 100_000, VENDOR, RESOURCE, payBy, uint48(payBy) + 1 hours + 1, bytes32(0));
        assertEq(vault.attemptsRemaining(goalId), 4, "a refused request spends no attempt");
    }

    // ------------------------------------------------------------ closing a goal

    /// Closing was not an emergency stop in PolicyVault: a live authorization could
    /// still be collected. It is here.
    function testClosingAGoalStopsCollection() public {
        uint64 seq = _approved(100_000);
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bytes memory signature = _sign(info);

        vm.prank(alice);
        vault.closeGoal(goalId);

        vm.expectRevert(PolicyVault.GoalNotOpen.selector);
        vault.authorize(info, info.maxAmount, COLLECTOR, signature);
    }

    function _sweepInfo(address receiver, uint120 amount)
        internal
        view
        returns (IAuthCaptureEscrow.PaymentInfo memory)
    {
        uint48 deadline = uint48(block.timestamp + HOLD);
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(vault),
            payer: payer,
            receiver: receiver,
            token: address(USDC),
            maxAmount: amount,
            preApprovalExpiry: deadline,
            authorizationExpiry: deadline,
            refundExpiry: deadline,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: goalId << 64
        });
    }

    function testASweepGoesToTheOwnerOnlyAndOnlyAfterClosing() public {
        IAuthCaptureEscrow.PaymentInfo memory toOwner = _sweepInfo(alice, uint120(FUNDED));
        bytes memory ownerSignature = _sign(toOwner);
        vm.expectRevert(EscrowPolicyVault.GoalStillOpen.selector);
        vault.charge(toOwner, FUNDED, COLLECTOR, ownerSignature, 0, address(0));

        vm.prank(alice);
        vault.closeGoal(goalId);

        // What a lying RPC would get signed: the same sweep, to someone else.
        IAuthCaptureEscrow.PaymentInfo memory toThief = _sweepInfo(STRANGER, uint120(FUNDED));
        bytes memory thiefSignature = _sign(toThief);
        vm.expectRevert(EscrowPolicyVault.PaymentMismatch.selector);
        vault.charge(toThief, FUNDED, COLLECTOR, thiefSignature, 0, address(0));

        uint256 before = USDC.balanceOf(alice);
        vault.charge(toOwner, FUNDED, COLLECTOR, ownerSignature, 0, address(0));
        assertEq(USDC.balanceOf(alice), before + FUNDED);
        assertEq(USDC.balanceOf(payer), 0);
    }

    /// A sweep cannot take what is already held for a vendor.
    function testASweepDoesNotRaceAHeldPayment() public {
        uint64 seq = _approved(100_000);
        _collect(seq);
        vm.prank(alice);
        vault.closeGoal(goalId);

        uint120 rest = uint120(USDC.balanceOf(payer));
        IAuthCaptureEscrow.PaymentInfo memory sweep = _sweepInfo(alice, rest);
        vault.charge(sweep, rest, COLLECTOR, _sign(sweep), 0, address(0));

        vm.prank(VENDOR);
        vault.claim(goalId, seq, KEY);
        assertEq(USDC.balanceOf(VENDOR), 100_000, "the vendor is still paid");
    }
}
// forge-lint: disable-end(unsafe-typecast)
