// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Test amounts and block times, all far below the sizes they are cast to.
// forge-lint: disable-start(unsafe-typecast)

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";
import {ebool, euint256, inco} from "@inco/lightning/src/Lib.sol";
import {CREATE_X_ADDRESS, CREATE_X_DEPLOYER} from "@inco/lightning/src/pasted-dependencies/CreateX.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {EscrowPolicyVault, IAuthCaptureEscrow} from "../src/EscrowPolicyVault.sol";

interface IUSDCLike {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IEscrowPayerReclaim {
    function reclaim(IAuthCaptureEscrow.PaymentInfo calldata info) external;
}

/// The Inco test double keeps its plaintexts in the test contract's storage, so the
/// handler reaches them through these.
interface IIncoHarness {
    function process() external;
    function boolValue(ebool handle) external view returns (bool);
    function uintValue(euint256 handle) external view returns (uint256);
    function attest(ebool handle) external returns (bytes[] memory);
}

/// The ghost model of the accounting proof. Each spend is in exactly one state:
///
///   Pending   requested, decision not yet recorded. Debit Q = amount if the hidden
///             decision is approve, else 0.
///   Rejected  finalized false. Debited nothing.
///   Approved  finalized true, not collected, not credited back.     counts in R
///   Held      funded into the escrow, not captured, not credited.   counts in R
///   Paid      captured by the vendor. Final.                         counts in D
///   Returned  credited back to the budget and the call count. Final.
///
/// The handler drives every transition that exists on chain, including the hostile
/// ones (collecting a spend that is not approved, claiming after the deadline,
/// crediting back something live), in any order the fuzzer picks.
contract AccountingHandler is Test {
    enum S {
        None,
        Pending,
        Rejected,
        Approved,
        Held,
        Paid,
        Returned
    }

    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    EscrowPolicyVault public immutable vault;
    IAuthCaptureEscrow public immutable escrow;
    address public immutable collector;
    IUSDCLike public immutable usdc;
    IIncoHarness public immutable harness;
    uint256 public immutable goalId;
    uint256 public immutable payerKey;
    address public immutable payer;
    address public immutable owner;
    address public immutable vendor;
    uint256 public immutable b0;

    mapping(uint64 seq => S) public state;
    mapping(uint64 seq => uint256) public amountOf;
    uint64 public maxSeq;

    /// Ghosts, summed by the handler as transitions happen.
    uint256 public paid; // D
    uint256 public swept;
    uint256 public largestPayment;
    /// Hostile actions the vault had to refuse. A refusal that did not happen fails
    /// the run at once, so these only count.
    uint256 public refusals;
    mapping(bytes32 => uint256) public calls;
    /// The first transition that went against the model. A revert in the handler would
    /// be discarded with fail_on_revert off, so a violation is recorded here instead,
    /// and an invariant fails the run on it.
    string public violation;

    function _expect(bool ok, string memory what) internal {
        if (!ok && bytes(violation).length == 0) violation = what;
    }
    /// Transitions that took effect, by name, so a run that never reached a state shows.
    mapping(bytes32 => uint256) public done;

    constructor(
        EscrowPolicyVault vault_,
        IAuthCaptureEscrow escrow_,
        address collector_,
        IUSDCLike usdc_,
        IIncoHarness harness_,
        uint256 goalId_,
        uint256 payerKey_,
        address owner_,
        address vendor_,
        uint256 b0_
    ) {
        vault = vault_;
        escrow = escrow_;
        collector = collector_;
        usdc = usdc_;
        harness = harness_;
        goalId = goalId_;
        payerKey = payerKey_;
        payer = vm.addr(payerKey_);
        owner = owner_;
        vendor = vendor_;
        b0 = b0_;
    }

    // ------------------------------------------------------------------ helpers

    function _pick(uint256 seed) internal view returns (uint64) {
        if (maxSeq == 0) return 0;
        return uint64(bound(seed, 1, maxSeq));
    }

    function _sign(IAuthCaptureEscrow.PaymentInfo memory info) internal view returns (bytes memory) {
        address actualPayer = info.payer;
        info.payer = address(0);
        bytes32 nonce = escrow.getHash(info);
        info.payer = actualPayer;
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, actualPayer, collector, uint256(info.maxAmount), 0, info.preApprovalExpiry, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _open() internal view returns (bool open, uint64 expiry) {
        (,,,,, expiry,, open) = vault.goals(goalId);
    }

    /// Reads the escrow state for a spend: collected, held, captured.
    function _escrowState(uint64 seq) internal view returns (bool, uint120, uint120) {
        return escrow.paymentState(escrow.getHash(vault.escrowPayment(goalId, seq)));
    }

    // -------------------------------------------------------------- transitions

    /// Hostile: a second request while one is pending must revert.
    function secondRequest(uint256 amountSeed) external {
        calls["secondRequest"]++;
        if (vault.pendingSeq(goalId) == 0) return;
        uint64 payBy = uint64(block.timestamp) + 60;
        try vault.requestEscrowSpend(
            goalId, bound(amountSeed, 1, b0), vendor, "r", payBy, uint48(payBy), bytes32(0)
        ) {
            _expect(false, "a second request went through while one was pending");
        } catch {
            refusals++;
        }
    }

    /// requestEscrowSpend with any amount up to 1.5 times the budget, any hold up to
    /// two hours and any valid capture deadline.
    function requestValid(uint256 amountSeed, uint256 holdSeed, uint256 deliverySeed, bool finalizeNow) external {
        calls["requestValid"]++;
        (bool open, uint64 expiry) = _open();
        if (!open || block.timestamp >= expiry) return;
        if (vault.pendingSeq(goalId) != 0 || vault.attemptsRemaining(goalId) == 0) return;
        // Mostly amounts the limits can approve, sometimes up to 1.5 times the budget.
        uint256 amount = amountSeed % 4 == 0 ? bound(amountSeed, 1, b0 + b0 / 2) : bound(amountSeed, 1, b0 / 3);
        uint64 payBy = uint64(block.timestamp) + uint64(bound(holdSeed, 60, 2 hours));
        if (payBy > expiry) return;
        // validBefore is min(payBy, now + 1 h, expiry); the deadline must follow it.
        uint64 validBefore = payBy;
        if (validBefore > uint64(block.timestamp) + 1 hours) validBefore = uint64(block.timestamp) + 1 hours;
        uint48 captureDeadline = uint48(validBefore + bound(deliverySeed, 0, 1 hours));
        if (captureDeadline > expiry) captureDeadline = uint48(expiry);
        uint64 seq = vault.requestEscrowSpend(goalId, amount, vendor, "r", payBy, captureDeadline, bytes32(0));
        harness.process();
        state[seq] = S.Pending;
        amountOf[seq] = amount;
        maxSeq = seq;
        done["request"]++;
        if (vault.pendingSeq(goalId) != seq) _expect(false, "not pending");
        // Half the time at once, so more of each run is spent past the decision; the
        // other half leaves the request pending across other transitions.
        if (finalizeNow) finalize();
    }

    /// The same transition again, so the fuzzer picks requests twice as often.
    function requestAgain(uint256 amountSeed, uint256 holdSeed, uint256 deliverySeed, bool finalizeNow) external {
        this.requestValid(amountSeed, holdSeed, deliverySeed, finalizeNow);
    }

    /// Collection of the newest spend, the one most likely to be approved and live.
    function collectLatest() external {
        this.collect(maxSeq);
    }

    /// finalizeDecision with the attested plaintext, and a wrong plaintext first.
    function finalize() public {
        calls["finalize"]++;
        uint64 seq = vault.pendingSeq(goalId);
        if (seq == 0) return;
        ebool handle = vault.decisionHandle(goalId, seq);
        bool approved = harness.boolValue(handle);
        bytes[] memory signatures = harness.attest(handle);
        try vault.finalizeDecision(goalId, seq, !approved, signatures) {
            _expect(false, "a false plaintext was accepted");
        } catch {
            refusals++;
        }
        vault.finalizeDecision(goalId, seq, approved, signatures);
        state[seq] = approved ? S.Approved : S.Rejected;
        done[approved ? bytes32("approve") : bytes32("reject")]++;
    }

    /// The vault's authorize, which pulls the funds into the escrow. Tried on any
    /// spend; only an approved, live, uncredited one on an open goal may succeed.
    function collect(uint256 seqSeed) external {
        calls["collect"]++;
        uint64 seq = _pick(seqSeed);
        if (seq == 0) return;
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bytes memory signature = _sign(info);
        (bool open,) = _open();
        bool shouldWork = state[seq] == S.Approved && open && block.timestamp < info.preApprovalExpiry
            && usdc.balanceOf(payer) >= info.maxAmount;
        try vault.authorize(info, info.maxAmount, collector, signature) {
            _expect(shouldWork, "collected a spend that must not be collectable");
            state[seq] = S.Held;
            done["collect"]++;
        } catch {
            _expect(!shouldWork, "refused a collection that should have worked");
            refusals++;
        }
    }

    /// The vendor's claim. Only a held spend before its capture deadline pays.
    function claim(uint256 seqSeed) external {
        calls["claim"]++;
        uint64 seq = _pick(seqSeed);
        if (seq == 0) return;
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        bool shouldWork = state[seq] == S.Held && block.timestamp < info.authorizationExpiry;
        uint256 before = usdc.balanceOf(vendor);
        vm.prank(vendor);
        try vault.claim(goalId, seq, bytes32(0)) {
            _expect(shouldWork, "claimed what must not be claimable");
            uint256 got = usdc.balanceOf(vendor) - before;
            _expect(got == amountOf[seq], "paid a different amount");
            state[seq] = S.Paid;
            done["claim"]++;
            paid += got;
            if (got > largestPayment) largestPayment = got;
        } catch {
            _expect(!shouldWork, "refused a claim that should have worked");
            refusals++;
        }
    }

    /// reclaimExpired, permissionless. Must succeed exactly when the spend can never
    /// be paid: approved and expired uncollected, or held past its deadline, or
    /// already returned to the payer by the escrow.
    function reclaim(uint256 seqSeed) external {
        calls["reclaim"]++;
        uint64 seq = _pick(seqSeed);
        if (seq == 0) return;
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        (bool collected, uint120 held, uint120 captured) = _escrowState(seq);
        S s = state[seq];
        bool shouldWork = (s == S.Approved && !collected && block.timestamp >= info.preApprovalExpiry)
            || (s == S.Held && held > 0 && block.timestamp >= info.authorizationExpiry)
            || (s == S.Held && collected && held == 0 && captured == 0);
        bool predicted = vault.isReclaimable(goalId, seq);
        _expect(predicted == shouldWork, "isReclaimable disagrees with the model");
        try vault.reclaimExpired(goalId, seq) {
            _expect(shouldWork, "credited back something that could still be paid");
            state[seq] = S.Returned;
            harness.process();
            done["reclaim"]++;
            // Reclaim of an older approval while a newer request is pending.
            if (vault.pendingSeq(goalId) != 0) done["reclaimWhilePending"]++;
        } catch {
            _expect(!shouldWork, "refused a credit that was due");
            refusals++;
        }
    }

    /// The payer takes a held payment back from the escrow directly, after the
    /// deadline. The vault learns of it only through reclaimExpired.
    function payerReclaim(uint256 seqSeed) external {
        calls["payerReclaim"]++;
        uint64 seq = _pick(seqSeed);
        if (seq == 0 || state[seq] != S.Held) return;
        IAuthCaptureEscrow.PaymentInfo memory info = vault.escrowPayment(goalId, seq);
        if (block.timestamp < info.authorizationExpiry) return;
        (, uint120 held,) = _escrowState(seq);
        if (held == 0) return;
        vm.prank(payer);
        IEscrowPayerReclaim(address(escrow)).reclaim(info);
        done["payerReclaim"]++;
    }

    function warp(uint256 secondsSeed) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(secondsSeed, 1, 20 minutes));
    }

    function close(uint256 seed) external {
        calls["close"]++;
        // Rare, so most runs keep the goal open long enough to do something.
        if (seed % 400 != 0) return;
        vm.prank(owner);
        vault.closeGoal(goalId);
        done["close"]++;
    }

    /// The owner's sweep, only possible once closed, and only of what the payer holds.
    function sweep() external {
        calls["sweep"]++;
        (bool open,) = _open();
        uint256 balance = usdc.balanceOf(payer);
        if (balance == 0) return;
        uint48 deadline = uint48(block.timestamp + 10 minutes);
        IAuthCaptureEscrow.PaymentInfo memory info = IAuthCaptureEscrow.PaymentInfo({
            operator: address(vault),
            payer: payer,
            receiver: owner,
            token: address(usdc),
            maxAmount: uint120(balance),
            preApprovalExpiry: deadline,
            authorizationExpiry: deadline,
            refundExpiry: deadline,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: goalId << 64
        });
        bytes memory signature = _sign(info);
        uint256 before = usdc.balanceOf(owner);
        try vault.charge(info, balance, collector, signature, 0, address(0)) {
            _expect(!open, "swept an open goal");
            swept += usdc.balanceOf(owner) - before;
            done["sweep"]++;
        } catch {
            _expect(open, "refused the owner's sweep of a closed goal");
            refusals++;
        }
    }

    // ------------------------------------------------------------- model sums

    /// R: approved or held, neither paid nor returned.
    function reserved() public view returns (uint256 total) {
        for (uint64 seq = 1; seq <= maxSeq; seq++) {
            if (state[seq] == S.Approved || state[seq] == S.Held) total += amountOf[seq];
        }
    }

    /// Q: the debit a pending request already made, read from its hidden decision.
    function pendingDebit() public view returns (uint256) {
        uint64 seq = vault.pendingSeq(goalId);
        if (seq == 0) return 0;
        return harness.boolValue(vault.decisionHandle(goalId, seq)) ? amountOf[seq] : 0;
    }

    /// Finalized approvals not credited back: Approved, Held and Paid.
    function liveApprovals() public view returns (uint32 count) {
        for (uint64 seq = 1; seq <= maxSeq; seq++) {
            S s = state[seq];
            if (s == S.Approved || s == S.Held || s == S.Paid) count++;
        }
    }

    function held() public view returns (uint256 total) {
        for (uint64 seq = 1; seq <= maxSeq; seq++) {
            if (state[seq] == S.Held) {
                (, uint120 h,) = _escrowState(seq);
                total += h;
            }
        }
    }

    /// No spend is both paid and returned, and the chain agrees with the model.
    function checkStates() external {
        for (uint64 seq = 1; seq <= maxSeq; seq++) {
            S s = state[seq];
            bool reclaimed = vault.isReclaimed(goalId, seq);
            _expect(reclaimed == (s == S.Returned), "reclaimed flag disagrees with the model");
            if (s == S.None) continue;
            (,, uint120 captured) = _escrowState(seq);
            _expect((captured > 0) == (s == S.Paid), "captured disagrees with the model");
            _expect(!(captured > 0 && reclaimed), "paid and credited back");
        }
    }
}

/// Stateful invariants of the accounting argument (Proposition 2 in the paper), on the
/// real escrow, collector and USDC at a pinned block of Base Sepolia, with Inco's test
/// double for the encrypted arithmetic.
///
///   ESCROW_FORK_RPC=https://sepolia.base.org forge test --match-contract AccountingInvariants
///
/// It skips without the variable, and says so in the output.
contract AccountingInvariantsTest is IncoTest, IIncoHarness {
    IAuthCaptureEscrow constant ESCROW = IAuthCaptureEscrow(0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
    address constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;
    IUSDCLike constant USDC = IUSDCLike(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    /// Pinned so every run sees the same deployed code and state.
    uint256 constant FORK_BLOCK = 56_480_000;

    address constant VENDOR = address(uint160(uint256(keccak256("invariant vendor"))));
    uint256 constant PAYER_KEY = 0xA11CE5;
    uint256 constant ENROLLMENT_KEY = 0xE11;

    uint256 constant B0 = 300_000;
    uint256 constant CAP = 200_000;
    uint32 constant N0 = 6;
    uint32 constant M0 = 40;
    /// Independent of B0, as the console funds a fixed amount; above it, so the
    /// policy and not the balance is what binds.
    uint256 constant FUNDED = 1_000_000;

    EscrowPolicyVault vault;
    AccountingHandler handler;
    uint256 goalId;

    /// The deployed escrow, collector and USDC as they were at FORK_BLOCK, recorded by
    /// SnapshotEscrowState.t.sol. With no ESCROW_FORK_RPC the suite installs this into
    /// a plain local EVM and runs offline.
    string constant FIXTURE = "test/fixtures/escrow-state.json";

    function setUp() public virtual override {
        string memory rpc = vm.envOr("ESCROW_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            if (!vm.exists(FIXTURE)) {
                vm.skip(true);
                return;
            }
            _installFixture();
        } else {
            uint256 forkBlock = vm.envOr("ESCROW_FORK_BLOCK", FORK_BLOCK);
            // 0 means the node's latest block.
            if (forkBlock == 0) vm.createSelectFork(rpc);
            else vm.createSelectFork(rpc, forkBlock);
        }
        _clear(CREATE_X_ADDRESS);
        _clear(address(inco));
        _clear(0xad24561EE8f1f2C6309a5D5394523b0dFA43659a);
        _clear(0x867758FFe098fB0D74826A8DCf60127696440f09);
        _clear(0xbdB58BC3C9C50E751bDd4093076BDE9ADeb43fF9);
        vm.setNonceUnsafe(CREATE_X_DEPLOYER, 0);
        super.setUp();

        vault = new EscrowPolicyVault(ESCROW, COLLECTOR, vm.addr(ENROLLMENT_KEY));
        address payer = vm.addr(PAYER_KEY);
        deal(address(USDC), payer, FUNDED);

        address[] memory allowlist = new address[](1);
        allowlist[0] = VENDOR;
        PolicyVault.OpenGoalParams memory params = PolicyVault.OpenGoalParams({
            budgetCiphertext: fakePrepareEuint256Ciphertext(B0, alice, address(vault)),
            perCallCapCiphertext: fakePrepareEuint256Ciphertext(CAP, alice, address(vault)),
            callsRemaining: N0,
            maxAttempts: M0,
            payer: payer,
            relay: address(0), // replaced below, once the handler exists
            asset: address(USDC),
            expiry: uint64(block.timestamp + 1 days),
            allowlist: allowlist
        });
        // The handler is the relay, so it must exist before the goal names it.
        handler = new AccountingHandler(
            vault, ESCROW, COLLECTOR, USDC, this, vault.goalCount() + 1, PAYER_KEY, alice, VENDOR, B0
        );
        params.relay = address(handler);
        bytes32 enrollmentId = keccak256("invariants");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ENROLLMENT_KEY, vault.enrollmentDigest(payer, alice, enrollmentId));
        uint256 fee = 2 * inco.getFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        goalId = vault.openEnrolledGoal{value: fee}(params, enrollmentId, abi.encodePacked(r, s, v));
        processAllOperations();
        require(goalId == handler.goalId(), "handler points at another goal");

        targetContract(address(handler));
        // One fixed caller. A random sender per call makes the fork fetch a fresh
        // account from the RPC every time, which is most of the run's wall time.
        // The handler's transitions do not depend on who calls them.
        targetSender(address(0xCA11E5));
    }

    function _installFixture() internal {
        string memory json = vm.readFile(FIXTURE);
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        vm.roll(vm.parseJsonUint(json, ".block"));
        vm.warp(vm.parseJsonUint(json, ".timestamp"));
        string[] memory keys = vm.parseJsonKeys(json, "$");
        for (uint256 i = 0; i < keys.length; i++) {
            if (bytes(keys[i]).length != 42) continue; // block, chainId, timestamp
            address acct = vm.parseAddress(keys[i]);
            string memory at = string.concat(".", keys[i]);
            vm.etch(acct, vm.parseJsonBytes(json, string.concat(at, ".code")));
            bytes32[] memory slots = vm.parseJsonBytes32Array(json, string.concat(at, ".slots"));
            bytes32[] memory values = vm.parseJsonBytes32Array(json, string.concat(at, ".values"));
            for (uint256 k = 0; k < slots.length; k++) {
                vm.store(acct, slots[k], values[k]);
            }
        }
    }

    function _clear(address occupied) internal {
        vm.etch(occupied, hex"");
        vm.setNonceUnsafe(occupied, 0);
    }

    // ------------------------------------------------------------ IIncoHarness

    function process() external {
        processAllOperations();
    }

    function boolValue(ebool handle) external view returns (bool) {
        return getBoolValue(handle);
    }

    function uintValue(euint256 handle) external view returns (uint256) {
        return getUint256Value(handle);
    }

    function attest(ebool handle) external returns (bytes[] memory signatures) {
        (, signatures) = getDecryptionAttestation(
            address(this), HandleWithProof({handle: ebool.unwrap(handle), proof: _emptyAllowanceProof()})
        );
    }

    // -------------------------------------------------------------- invariants

    /// Every check below after every call. One campaign for all of them, so the
    /// fuzzer's depth goes into transitions and not into repeating the setup.
    function invariant_accounting() public {
        budgetConservation();
        callConservation();
        attemptsOnlyFall();
        lifetimePaymentsWithinTheLimits();
        fundsAreConserved();
        handler.checkStates();
        assertEq(handler.violation(), "", "a transition went against the model");
    }

    /// B_remaining + D + R + Q = B0.
    function budgetConservation() internal view {
        uint256 remaining = getUint256Value(vault.remainingBudgetHandle(goalId));
        assertEq(
            remaining + handler.paid() + handler.reserved() + handler.pendingDebit(), B0, "B_rem + D + R + Q != B0"
        );
    }

    /// callsRemaining + finalized approvals not returned = n0. The pending request is
    /// not in it: the count moves only at finalization.
    function callConservation() internal view {
        (,,,, uint32 calls,,,) = vault.goals(goalId);
        assertEq(uint256(calls) + handler.liveApprovals(), N0, "calls + live approvals != n0");
    }

    /// attemptsRemaining + requests made = m0. Nothing restores an attempt.
    function attemptsOnlyFall() internal view {
        (,,,,,, uint64 seq,) = vault.goals(goalId);
        assertEq(uint256(vault.attemptsRemaining(goalId)) + seq, M0, "attempts + seq != m0");
    }

    /// The loss bound itself, over the life of the goal: what the vendor received
    /// never passes B0, and no single payment passes the cap.
    function lifetimePaymentsWithinTheLimits() internal view {
        assertLe(handler.paid(), B0, "paid more than the budget");
        assertLe(handler.largestPayment(), CAP, "one payment passed the cap");
        assertEq(USDC.balanceOf(VENDOR), handler.paid(), "the vendor got money the model did not see");
    }

    /// Every unit of the payer's funding is in exactly one place.
    function fundsAreConserved() internal view {
        assertEq(
            USDC.balanceOf(vm.addr(PAYER_KEY)) + handler.held() + handler.paid() + handler.swept(),
            FUNDED,
            "payer + held + paid + swept != funded"
        );
    }

    /// Which transitions took effect in this run, printed with -vv.
    function afterInvariant() external {
        string[10] memory names = [
            "request",
            "approve",
            "reject",
            "collect",
            "claim",
            "reclaim",
            "reclaimWhilePending",
            "payerReclaim",
            "close",
            "sweep"
        ];
        string memory line = "";
        for (uint256 i = 0; i < names.length; i++) {
            uint256 count = handler.done(bytes32(bytes(names[i])));
            console.log(string.concat("reached ", names[i]), count);
            line = string.concat(line, names[i], "=", vm.toString(count), " ");
        }
        // One line per run, appended, so the transition mix of the whole campaign
        // can be summed afterwards (vm.writeLine needs fs_permissions in foundry.toml).
        string memory out = vm.envOr("INVARIANT_REACHED_LOG", string(""));
        if (bytes(out).length > 0) vm.writeLine(out, string.concat(line, "refusals=", vm.toString(handler.refusals())));
        console.log("refusals", handler.refusals());
    }

}
// forge-lint: disable-end(unsafe-typecast)
