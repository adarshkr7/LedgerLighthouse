// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";
import {ebool, euint256, e, inco} from "@inco/lightning/src/Lib.sol";

import {PolicyVault} from "../src/PolicyVault.sol";

/// Tests for the on-chain policy vault.
///
/// Written before the contract, because the properties they pin down are the
/// ones that are expensive to retrofit: a frozen authorization tuple, a
/// monotonic sequence, and counters that do not move on a rejected spend.
contract PolicyVaultTest is IncoTest {
    PolicyVault vault;

    // 6-decimal USDC units throughout.
    uint256 constant BUDGET = 300_000; // 0.30 USDC
    uint256 constant PER_CALL_CAP = 200_000; // 0.20 USDC
    uint32 constant CALLS = 5;

    address constant VENDOR = address(0x1111111111111111111111111111111111111111);
    address constant OTHER_VENDOR = address(0x3333333333333333333333333333333333333333);
    address constant ASSET = address(0x036CbD53842c5426634e7929541eC2318f3dCF7e); // Base Sepolia USDC
    address constant PAYER = address(0x4444444444444444444444444444444444444444);

    string constant RESOURCE = "https://api.example.com/resource/honest";

    uint256 goalId;
    uint64 expiry;

    function setUp() public override {
        super.setUp();
        vault = new PolicyVault();
        expiry = uint64(block.timestamp + 7 days);
        goalId = _openGoal(BUDGET, PER_CALL_CAP, CALLS);
    }

    // ---------------------------------------------------------------- helpers

    function _openGoal(uint256 budget, uint256 cap, uint32 calls) internal returns (uint256 id) {
        address[] memory allowlist = new address[](1);
        allowlist[0] = VENDOR;

        // The ciphertext is bound to the address that produced it, so the goal
        // must be opened by the user's own transaction (ARCHITECTURE.md §5.2).
        bytes memory ciphertext = fakePrepareEuint256Ciphertext(budget, alice, address(vault));

        // Hoist the fee: `vm.prank` applies to the very next call, and an
        // `inco.getFee()` sitting inside the `{value: ...}` expression would
        // consume it — leaving `openGoal` to run as the test runner and the
        // ciphertext binding to mismatch.
        uint256 fee = inco.getFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        id = vault.openGoal{value: fee}(
            PolicyVault.OpenGoalParams({
                budgetCiphertext: ciphertext,
                perCallCap: cap,
                callsRemaining: calls,
                payer: PAYER,
                relay: address(this),
                asset: ASSET,
                expiry: expiry,
                allowlist: allowlist
            })
        );
        processAllOperations();
    }

    function _requestSpend(uint256 amount) internal returns (uint64 seq) {
        seq = vault.requestSpend(goalId, amount, VENDOR, RESOURCE);
        processAllOperations();
    }

    /// Mimics the off-chain loop: read the revealed decision, fetch covalidator
    /// signatures for it, and submit them to `finalizeDecision`.
    function _finalize(uint64 seq) internal returns (bool approved) {
        ebool handle = vault.decisionHandle(goalId, seq);
        approved = getBoolValue(handle);

        (, bytes[] memory signatures) = getDecryptionAttestation(
            address(this),
            HandleWithProof({handle: ebool.unwrap(handle), proof: _emptyAllowanceProof()})
        );
        vault.finalizeDecision(goalId, seq, approved, signatures);
    }

    function _spendAndFinalize(uint256 amount) internal returns (uint64 seq, bool approved) {
        seq = _requestSpend(amount);
        approved = _finalize(seq);
    }

    function _budget() internal view returns (uint256) {
        return getUint256Value(vault.remainingBudgetHandle(goalId));
    }

    function _callsRemaining() internal view returns (uint32) {
        (,,,, uint32 calls,,,) = vault.goals(goalId);
        return calls;
    }

    function _isOpen() internal view returns (bool) {
        (,,,,,,, bool open) = vault.goals(goalId);
        return open;
    }

    // ------------------------------------------- the seven required properties

    /// The retry test IMPLEMENTATION.md §7 calls "the one that matters most".
    ///
    /// EIP-3009 marks the whole *authorization* used, not just the nonce. If the
    /// signer regenerates `validAfter`/`validBefore` from the clock on retry, the
    /// retry is a different authorization and the token contract will happily
    /// execute it a second time. Freezing the window at requestSpend time is what
    /// makes a byte-identical resubmission possible.
    function testValidityWindowFrozenAcrossRetries() public {
        uint64 seq = _requestSpend(100_000);

        (uint64 validAfter, uint64 validBefore) = vault.validityWindow(goalId, seq);
        bytes32 nonce = vault.spendNonce(goalId, seq);
        assertGt(validBefore, validAfter, "window must be non-empty");

        // Time passes: a facilitator timed out, the outcome is unknown, we retry.
        vm.warp(block.timestamp + 45 minutes);

        (uint64 afterWarpValidAfter, uint64 afterWarpValidBefore) = vault.validityWindow(goalId, seq);
        assertEq(afterWarpValidAfter, validAfter, "validAfter drifted with the clock");
        assertEq(afterWarpValidBefore, validBefore, "validBefore drifted with the clock");
        assertEq(vault.spendNonce(goalId, seq), nonce, "nonce drifted");

        // And the whole tuple the signer would rebuild is unchanged.
        (address payer, uint256 amount, address payTo,,) = vault.authorization(goalId, seq);
        assertEq(payer, PAYER);
        assertEq(amount, 100_000);
        assertEq(payTo, VENDOR);
    }

    function testTermsHashFrozen() public {
        uint64 seq = _requestSpend(100_000);

        bytes32 stored = vault.termsHash(goalId, seq);
        (uint64 validAfter, uint64 validBefore) = vault.validityWindow(goalId, seq);

        bytes32 expected = keccak256(
            abi.encode(goalId, seq, PAYER, uint256(100_000), VENDOR, ASSET, RESOURCE, validAfter, validBefore)
        );
        assertEq(stored, expected, "termsHash does not commit to the recorded tuple");

        // Surviving both a clock change and a later spend is the point.
        vm.warp(block.timestamp + 3 hours);
        assertEq(vault.termsHash(goalId, seq), stored, "termsHash mutated after the fact");

        _finalize(seq);
        uint64 seq2 = _requestSpend(100_000);
        assertEq(vault.termsHash(goalId, seq), stored, "an unrelated spend rewrote a frozen record");

        // Identical terms at a different seq must hash differently, or two
        // spends would be indistinguishable in the trace.
        assertTrue(vault.termsHash(goalId, seq2) != stored, "termsHash does not bind seq");
    }

    function testSeqMonotonic() public {
        (uint64 first,) = _spendAndFinalize(50_000);
        (uint64 second,) = _spendAndFinalize(50_000);
        (uint64 third,) = _spendAndFinalize(50_000);

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(third, 3);

        // A rejected attempt still burns a sequence number, so it stays visible
        // in the trace (ARCHITECTURE.md §7.2). A policy that never fires is
        // indistinguishable from a policy that does not work.
        (uint64 fourth, bool approved) = _spendAndFinalize(PER_CALL_CAP + 1);
        assertFalse(approved, "over-cap spend should not approve");
        assertEq(fourth, 4, "a rejected spend must still consume a seq");

        (uint64 fifth,) = _spendAndFinalize(10_000);
        assertEq(fifth, 5, "seq regressed after a rejection");
    }

    function testCannotFinalizeTwice() public {
        uint64 seq = _requestSpend(50_000);

        ebool handle = vault.decisionHandle(goalId, seq);
        bool approved = getBoolValue(handle);
        (, bytes[] memory signatures) = getDecryptionAttestation(
            address(this),
            HandleWithProof({handle: ebool.unwrap(handle), proof: _emptyAllowanceProof()})
        );

        vault.finalizeDecision(goalId, seq, approved, signatures);

        // Replaying a genuine attestation must not double-decrement the counters.
        vm.expectRevert(PolicyVault.AlreadyFinalized.selector);
        vault.finalizeDecision(goalId, seq, approved, signatures);
    }

    /// `perCallCap` is public in the hackathon-v1 simplification, so it *could*
    /// be a `require`. It deliberately is not: an over-cap request must land on
    /// chain and bounce, not revert. The visible bounce is the product.
    function testPublicCapEnforced() public {
        uint256 over = PER_CALL_CAP + 1;
        uint256 budgetBefore = _budget();
        uint32 callsBefore = _callsRemaining();

        (uint64 seq, bool approved) = _spendAndFinalize(over);

        assertEq(seq, 1, "the commit transaction must still land");
        assertFalse(approved, "amount above perCallCap must not approve");
        assertEq(_budget(), budgetBefore, "rejected spend moved the budget");
        assertEq(_callsRemaining(), callsBefore, "rejected spend consumed a call");
        assertTrue(vault.isFinalized(goalId, seq), "the bounce must be recorded");

        // And the vault must not have produced an approved authorization.
        assertFalse(vault.isApproved(goalId, seq));
    }

    function testCallsRemainingDecrementsOnApprovedSpend() public {
        assertEq(_callsRemaining(), CALLS);

        (, bool approved) = _spendAndFinalize(50_000);
        assertTrue(approved);
        assertEq(_callsRemaining(), CALLS - 1, "approved spend did not consume a call");

        (, bool approved2) = _spendAndFinalize(50_000);
        assertTrue(approved2);
        assertEq(_callsRemaining(), CALLS - 2);

        // A rejection must leave it alone.
        (, bool rejected) = _spendAndFinalize(PER_CALL_CAP + 1);
        assertFalse(rejected);
        assertEq(_callsRemaining(), CALLS - 2, "rejected spend consumed a call");
    }

    /// The encrypted conjunct: `amount <= perCallCap` passes publicly, but the
    /// encrypted budget is too small. Nobody — including the caller — can know
    /// the outcome until the reveal resolves, yet the counters must be untouched.
    function testRejectedSpendLeavesEncryptedBudgetUnchanged() public {
        // Spend down to 100_000, under the 200_000 cap the whole way.
        (, bool ok1) = _spendAndFinalize(200_000);
        assertTrue(ok1);
        assertEq(_budget(), BUDGET - 200_000, "approved debit did not apply");

        uint256 budgetBefore = _budget();
        uint32 callsBefore = _callsRemaining();
        assertEq(budgetBefore, 100_000);

        // Under the cap, within the call count — but over the remaining budget.
        (uint64 seq, bool approved) = _spendAndFinalize(200_000);

        assertFalse(approved, "spend exceeding the encrypted budget must reject");
        assertEq(_budget(), budgetBefore, "rejected spend debited the encrypted budget");
        assertEq(_callsRemaining(), callsBefore, "rejected spend consumed a call");
        assertTrue(vault.isFinalized(goalId, seq));
        assertFalse(vault.isApproved(goalId, seq));
    }

    // ------------------------------- handle-match verification (ARCHITECTURE.md §7.5)

    /// Verifying the signature alone is not enough. A genuine attestation for a
    /// *different* handle must be rejected, or it could simply be substituted.
    function testFinalizeRejectsAttestationForDifferentHandle() public {
        uint64 seq = _requestSpend(50_000);

        // A real, correctly-signed attestation — for an unrelated handle.
        ebool decoy = e.asEbool(true);
        e.reveal(decoy);
        processAllOperations();

        (, bytes[] memory decoySignatures) = getDecryptionAttestation(
            address(this),
            HandleWithProof({handle: ebool.unwrap(decoy), proof: _emptyAllowanceProof()})
        );

        vm.expectRevert(PolicyVault.InvalidAttestation.selector);
        vault.finalizeDecision(goalId, seq, true, decoySignatures);
    }

    /// The claimed plaintext is covered by the signature, so claiming the
    /// opposite of what the handle decrypts to must not verify.
    function testFinalizeRejectsWrongDecisionValue() public {
        uint64 seq = _requestSpend(PER_CALL_CAP + 1); // will resolve false

        ebool handle = vault.decisionHandle(goalId, seq);
        assertFalse(getBoolValue(handle));

        (, bytes[] memory signatures) = getDecryptionAttestation(
            address(this),
            HandleWithProof({handle: ebool.unwrap(handle), proof: _emptyAllowanceProof()})
        );

        vm.expectRevert(PolicyVault.InvalidAttestation.selector);
        vault.finalizeDecision(goalId, seq, true, signatures);
    }

    // --------------------------------------------- structural preconditions

    function testRequestSpendRejectsUnallowlistedPayee() public {
        vm.expectRevert(PolicyVault.PayeeNotAllowlisted.selector);
        vault.requestSpend(goalId, 50_000, OTHER_VENDOR, RESOURCE);
    }

    function testRequestSpendRejectsAfterExpiry() public {
        vm.warp(uint256(expiry) + 1);
        vm.expectRevert(PolicyVault.GoalExpired.selector);
        vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);
    }

    function testRequestSpendRequiresPreviousSpendFinalized() public {
        _requestSpend(50_000);
        vm.expectRevert(PolicyVault.SpendPending.selector);
        vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);
    }

    /// Only the registered relay may drive the spend loop. Without this, any
    /// address could burn the goal's budget to an allowlisted payee — the same
    /// loss ceiling the design accepts for the orchestrator, but open to the
    /// whole world rather than to one known component.
    function testOnlyRelayCanRequestSpend() public {
        // The relay (this contract, registered at openGoal) succeeds.
        uint64 seq = vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);
        assertEq(seq, 1, "the registered relay must be able to request a spend");

        // Nobody else does.
        address[3] memory strangers =
            [address(0xBEEF), address(0xCAFE), VENDOR];
        for (uint256 i = 0; i < strangers.length; i++) {
            vm.prank(strangers[i]);
            vm.expectRevert(PolicyVault.NotRelay.selector);
            vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);
        }
    }

    /// Separation of duties. The goal owner holds the strongest privilege in the
    /// system — they opened the goal, funded the payer, and may close it — but
    /// that authority deliberately does not extend to driving spends. Owning a
    /// goal and relaying for it are distinct roles, and the check is on the
    /// relay field specifically, not "some privileged address".
    function testOwnerCannotRequestSpendIfNotRelay() public {
        (address owner,,,,,,,) = vault.goals(goalId);
        assertEq(owner, alice, "alice should own the goal");

        (, , address relay,,,,,) = vault.goals(goalId);
        assertTrue(relay != alice, "this test is meaningless if owner == relay");

        vm.prank(alice);
        vm.expectRevert(PolicyVault.NotRelay.selector);
        vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);

        // The owner's actual privilege still works, so the refusal above is
        // about the relay role and not a broken goal.
        vm.prank(alice);
        vault.closeGoal(goalId);
        assertFalse(_isOpen(), "owner should still be able to close the goal");
    }

    function testClosedGoalRejectsSpend() public {
        vm.prank(alice);
        vault.closeGoal(goalId);

        vm.expectRevert(PolicyVault.GoalNotOpen.selector);
        vault.requestSpend(goalId, 50_000, VENDOR, RESOURCE);
    }

    function testOnlyOwnerMayCloseGoal() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(PolicyVault.NotGoalOwner.selector);
        vault.closeGoal(goalId);
    }

    function testPayerIsImmutableAfterOpen() public view {
        (, address payer,,,,,,) = vault.goals(goalId);
        assertEq(payer, PAYER);
        // There is deliberately no setter: a mutable payer field would let
        // whoever can write it redirect every future signature.
    }

    function testNonceIsDerivedFromGoalAndSeq() public {
        uint64 seq = _requestSpend(50_000);
        assertEq(
            vault.spendNonce(goalId, seq),
            keccak256(abi.encode(goalId, seq)),
            "nonce must be deterministic so a retry can reuse it"
        );
    }

    function testCallsExhaustedRejectsRatherThanReverts() public {
        // Exhaust the call count while staying well inside the budget, so the
        // call counter is unambiguously the binding constraint.
        for (uint256 i = 0; i < CALLS; i++) {
            (, bool approved) = _spendAndFinalize(50_000);
            assertTrue(approved, "in-policy spend should approve");
        }
        assertEq(_callsRemaining(), 0);
        assertGt(_budget(), 0, "budget must not be the binding constraint here");

        (uint64 seq, bool afterExhaustion) = _spendAndFinalize(10_000);
        assertFalse(afterExhaustion, "spend with no calls left must reject");
        assertEq(seq, uint64(CALLS) + 1, "and must still land on chain");
    }
}
