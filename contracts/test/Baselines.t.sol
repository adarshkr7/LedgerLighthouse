// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// forge-lint: disable-start(unsafe-typecast)

import {Test} from "forge-std/Test.sol";

import {IAuthCaptureEscrow} from "../src/EscrowPolicyVault.sol";
import {BaselineEscrowVault} from "../src/baselines/BaselineEscrowVault.sol";
import {PlaintextEscrowVault} from "../src/baselines/PlaintextEscrowVault.sol";
import {EnclavePolicyVault} from "../src/baselines/EnclavePolicyVault.sol";

interface IUSDCBaseline {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The two comparators on the real escrow, collector and USDC at a pinned block of
/// Base Sepolia. They share EscrowPolicyVault's escrow path; what is tested here is
/// the policy engine each puts in front of it, and that the escrow path still binds.
///
///   ESCROW_FORK_RPC=https://sepolia.base.org forge test --match-contract Baselines
contract BaselinesTest is Test {
    IAuthCaptureEscrow constant ESCROW = IAuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    IUSDCBaseline constant USDC = IUSDCBaseline(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    address constant VENDOR = address(uint160(uint256(keccak256("baseline vendor"))));
    address constant OWNER = address(0xA11CE);
    uint256 constant PAYER_KEY = 0xBA5E;
    uint256 constant ENROLLMENT_KEY = 0xE11;
    uint256 constant POLICY_KEY = 0x9011C1;
    uint256 constant BUDGET = 300_000;
    uint256 constant CAP = 200_000;

    PlaintextEscrowVault plain;
    EnclavePolicyVault enclave;
    address payer;

    function setUp() public {
        string memory rpc = vm.envOr("ESCROW_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envOr("ESCROW_FORK_BLOCK", uint256(56_480_000));
        // 0 means the node's latest block, for a local node loaded from a state snapshot.
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        plain = new PlaintextEscrowVault(ESCROW, COLLECTOR, vm.addr(ENROLLMENT_KEY));
        enclave = new EnclavePolicyVault(ESCROW, COLLECTOR, vm.addr(ENROLLMENT_KEY), vm.addr(POLICY_KEY));
        payer = vm.addr(PAYER_KEY);
        deal(address(USDC), payer, 1_000_000);
    }

    // ---------------------------------------------------------------- helpers

    function _params() internal view returns (BaselineEscrowVault.GoalParams memory) {
        address[] memory allowlist = new address[](1);
        allowlist[0] = VENDOR;
        return BaselineEscrowVault.GoalParams({
            callsRemaining: 3,
            maxAttempts: 6,
            payer: payer,
            relay: address(this),
            asset: address(USDC),
            expiry: uint64(block.timestamp + 1 days),
            allowlist: allowlist
        });
    }

    function _enrollment(BaselineEscrowVault vault) internal view returns (bytes32 id, bytes memory sig) {
        id = keccak256(abi.encode(address(vault)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENROLLMENT_KEY, vault.enrollmentDigest(payer, OWNER, id));
        sig = abi.encodePacked(r, s, v);
    }

    function _sign(IAuthCaptureEscrow.PaymentInfo memory info) internal view returns (bytes memory) {
        address actualPayer = info.payer;
        info.payer = address(0);
        bytes32 nonce = ESCROW.getHash(info);
        info.payer = actualPayer;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, actualPayer, COLLECTOR, uint256(info.maxAmount), 0, info.preApprovalExpiry, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(PAYER_KEY, keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _payBy() internal view returns (uint64) {
        return uint64(block.timestamp) + 10 minutes;
    }

    /// What the enclave keeps for one goal and the root it commits to.
    struct EnclaveState {
        uint256 approvedTotal;
        bytes32 salt;
    }

    function _root(uint256 goalId, EnclaveState memory st) internal pure returns (bytes32) {
        return keccak256(abi.encode(goalId, st.approvedTotal, st.salt));
    }

    /// The enclave's decision, made as the prototype signer makes it.
    function _decision(uint256 goalId, uint256 amount, EnclaveState memory st)
        internal
        view
        returns (bytes memory data, EnclaveState memory next, bool approved)
    {
        (,,,,,,, uint64 seq,) = enclave.goals(goalId);
        EnclavePolicyVault.Decision memory d;
        d.goalId = goalId;
        d.seq = seq + 1;
        d.amount = amount;
        d.payTo = VENDOR;
        d.credited = enclave.credited(goalId);
        approved = amount <= CAP && st.approvedTotal - d.credited + amount <= BUDGET;
        next = EnclaveState({approvedTotal: st.approvedTotal + (approved ? amount : 0), salt: keccak256(abi.encode(st.salt))});
        d.approved = approved;
        // The root of the state this enclave holds, which is stale if it was rolled back.
        d.fromRoot = _root(goalId, st);
        d.toRoot = _root(goalId, next);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(POLICY_KEY, enclave.decisionDigest(d));
        data = abi.encode(approved, d.toRoot, abi.encodePacked(r, s, v));
    }

    // -------------------------------------------------------------- plaintext

    function testPlaintextDecidesInOneTransactionAndPaysThroughTheEscrow() public {
        (bytes32 id, bytes memory sig) = _enrollment(plain);
        vm.prank(OWNER);
        uint256 goalId = plain.openEnrolledGoal(_params(), BUDGET, CAP, id, sig);
        // The point of the comparator: anyone reads the limits.
        assertEq(plain.perCallCap(goalId), CAP);

        uint64 payBy = _payBy();
        (uint64 seq, bool approved) = plain.requestEscrowSpend(goalId, 100_000, VENDOR, payBy, uint48(payBy), "");
        assertTrue(approved);
        (, bool rejected) = plain.requestEscrowSpend(goalId, CAP + 1, VENDOR, payBy, uint48(payBy), "");
        assertFalse(rejected);

        IAuthCaptureEscrow.PaymentInfo memory info = plain.escrowPayment(goalId, seq);
        plain.authorize(info, info.maxAmount, COLLECTOR, _sign(info));
        vm.prank(VENDOR);
        plain.claim(goalId, seq);
        assertEq(USDC.balanceOf(VENDOR), 100_000);
        assertEq(plain.remainingBudget(goalId), BUDGET - 100_000);
    }

    function testPlaintextReclaimCreditsTheBudgetOnce() public {
        (bytes32 id, bytes memory sig) = _enrollment(plain);
        vm.prank(OWNER);
        uint256 goalId = plain.openEnrolledGoal(_params(), BUDGET, CAP, id, sig);
        uint64 payBy = _payBy();
        (uint64 seq,) = plain.requestEscrowSpend(goalId, 150_000, VENDOR, payBy, uint48(payBy), "");
        vm.warp(payBy);
        plain.reclaimExpired(goalId, seq);
        assertEq(plain.remainingBudget(goalId), BUDGET);
        vm.expectRevert(BaselineEscrowVault.AlreadyReclaimed.selector);
        plain.reclaimExpired(goalId, seq);
    }

    // ---------------------------------------------------------------- enclave

    function testEnclaveDecisionsAreAcceptedFromTheCurrentStateOnly() public {
        (bytes32 id, bytes memory sig) = _enrollment(enclave);
        EnclaveState memory st = EnclaveState({approvedTotal: 0, salt: keccak256("salt")});
        vm.prank(OWNER);
        uint256 goalId = enclave.openEnrolledGoal(_params(), keccak256(abi.encode(uint256(1), st.approvedTotal, st.salt)), id, sig);

        uint64 payBy = _payBy();
        (bytes memory first, EnclaveState memory afterFirst, bool ok) = _decision(goalId, 100_000, st);
        assertTrue(ok);
        // The enclave's old state, kept by a clone or restored after a restart.
        EnclaveState memory stale = st;
        (uint64 seq,) = enclave.requestEscrowSpend(goalId, 100_000, VENDOR, payBy, uint48(payBy), first);

        (bytes memory fromStale,,) = _decision(goalId, 200_000, stale);
        vm.expectRevert(EnclavePolicyVault.StaleState.selector);
        enclave.requestEscrowSpend(goalId, 200_000, VENDOR, payBy, uint48(payBy), fromStale);

        // From the current state, 200_000 more would pass the budget, so it is refused.
        (bytes memory current,, bool second) = _decision(goalId, 200_001, afterFirst);
        assertFalse(second);
        (, bool approved) = enclave.requestEscrowSpend(goalId, 200_001, VENDOR, payBy, uint48(payBy), current);
        assertFalse(approved);

        IAuthCaptureEscrow.PaymentInfo memory info = enclave.escrowPayment(goalId, seq);
        enclave.authorize(info, info.maxAmount, COLLECTOR, _sign(info));
        vm.prank(VENDOR);
        enclave.claim(goalId, seq);
        assertEq(USDC.balanceOf(VENDOR), 100_000);
    }

    /// A reclaim moves the public credit total, so a decision made before it, which
    /// names the old total, is refused even from the current root.
    function testAnEnclaveDecisionThatMissedAReclaimIsRefused() public {
        (bytes32 id, bytes memory sig) = _enrollment(enclave);
        EnclaveState memory st = EnclaveState({approvedTotal: 0, salt: keccak256("salt")});
        vm.prank(OWNER);
        uint256 goalId = enclave.openEnrolledGoal(_params(), keccak256(abi.encode(uint256(1), st.approvedTotal, st.salt)), id, sig);
        uint64 payBy = _payBy();
        (bytes memory first, EnclaveState memory next,) = _decision(goalId, 150_000, st);
        (uint64 seq,) = enclave.requestEscrowSpend(goalId, 150_000, VENDOR, payBy, uint48(payBy), first);

        (bytes memory before,,) = _decision(goalId, 150_000, next);
        vm.warp(payBy);
        enclave.reclaimExpired(goalId, seq);
        assertEq(enclave.credited(goalId), 150_000);
        vm.expectRevert(EnclavePolicyVault.StaleState.selector);
        enclave.requestEscrowSpend(goalId, 150_000, VENDOR, uint64(block.timestamp) + 60, uint48(block.timestamp) + 60, before);
    }

    function testAForgedEnclaveDecisionIsRefused() public {
        (bytes32 id, bytes memory sig) = _enrollment(enclave);
        vm.prank(OWNER);
        uint256 goalId = enclave.openEnrolledGoal(_params(), bytes32(0), id, sig);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            0xBAD,
            enclave.decisionDigest(
                EnclavePolicyVault.Decision(goalId, 1, 1_000_000, VENDOR, true, bytes32(0), bytes32(uint256(1)), 0)
            )
        );
        uint64 payBy = _payBy();
        vm.expectRevert(EnclavePolicyVault.StaleState.selector);
        enclave.requestEscrowSpend(
            goalId, 1_000_000, VENDOR, payBy, uint48(payBy), abi.encode(true, bytes32(uint256(1)), abi.encodePacked(r, s, v))
        );
    }
}
// forge-lint: disable-end(unsafe-typecast)
