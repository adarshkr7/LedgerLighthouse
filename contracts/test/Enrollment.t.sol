// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";
import {inco} from "@inco/lightning/src/Lib.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {EscrowPolicyVault, IAuthCaptureEscrow} from "../src/EscrowPolicyVault.sol";

/// Authenticated setup. Opening a goal touches neither the escrow nor the token, so
/// this runs offline with placeholder addresses for both.
///
/// The attacker throughout is the orchestrator: it relays the enrollment statement
/// from the signer to the console, and it would like the user to fund an address it
/// holds the key for.
contract EnrollmentTest is IncoTest {
    IAuthCaptureEscrow constant ESCROW = IAuthCaptureEscrow(address(0xE5C));
    address constant COLLECTOR = address(0xC011);
    address constant ASSET = address(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    address constant VENDOR = address(0x1111111111111111111111111111111111111111);

    uint256 constant ENROLLMENT_KEY = 0xE11;
    /// A key the attacker holds: its own "enrollment signer".
    uint256 constant ATTACKER_KEY = 0xBAD;

    EscrowPolicyVault vault;
    address payer = address(0x4444444444444444444444444444444444444444);
    address attackerPayer = address(0xBADBAD);
    bytes32 constant ENROLLMENT_ID = keccak256("fresh from the console");

    function setUp() public override {
        super.setUp();
        vault = new EscrowPolicyVault(ESCROW, COLLECTOR, vm.addr(ENROLLMENT_KEY));
    }

    function _params(address goalPayer) internal returns (PolicyVault.OpenGoalParams memory) {
        address[] memory allowlist = new address[](1);
        allowlist[0] = VENDOR;
        return PolicyVault.OpenGoalParams({
            budgetCiphertext: fakePrepareEuint256Ciphertext(300_000, alice, address(vault)),
            perCallCapCiphertext: fakePrepareEuint256Ciphertext(200_000, alice, address(vault)),
            callsRemaining: 5,
            maxAttempts: 10,
            payer: goalPayer,
            relay: address(this),
            asset: ASSET,
            expiry: uint64(block.timestamp + 7 days),
            allowlist: allowlist
        });
    }

    function _statement(uint256 key, address goalPayer, address owner, bytes32 id)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.enrollmentDigest(goalPayer, owner, id));
        return abi.encodePacked(r, s, v);
    }

    function _open(address opener, address goalPayer, bytes32 id, bytes memory statement)
        internal
        returns (uint256 goalId)
    {
        PolicyVault.OpenGoalParams memory params = _params(goalPayer);
        uint256 fee = 2 * inco.getFee();
        vm.deal(opener, fee);
        vm.prank(opener);
        goalId = vault.openEnrolledGoal{value: fee}(params, id, statement);
    }

    function _expectOpenFails(address opener, address goalPayer, bytes32 id, bytes memory statement, bytes4 err)
        internal
    {
        PolicyVault.OpenGoalParams memory params = _params(goalPayer);
        uint256 fee = 2 * inco.getFee();
        vm.deal(opener, fee);
        vm.prank(opener);
        vm.expectRevert(err);
        vault.openEnrolledGoal{value: fee}(params, id, statement);
    }

    // ----------------------------------------------------------------- accepted

    function testAGoalOpensWithTheSignersStatementForItsOwner() public {
        uint256 goalId = _open(alice, payer, ENROLLMENT_ID, _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID));
        (address owner, address goalPayer,,,,,,) = vault.goals(goalId);
        assertEq(owner, alice);
        assertEq(goalPayer, payer);
        assertEq(vault.goalEnrollment(goalId), ENROLLMENT_ID, "the id is on chain, so the key can be found again");
        assertEq(vault.payerGoal(payer), goalId);
    }

    // ------------------------------------------------------- payer substitution

    /// The attack the statement exists for: the orchestrator names a payer whose key
    /// it holds. Without the signer's statement the goal does not open, so the
    /// console never reaches the funding step.
    function testAnAttackerPayerWithoutTheSignersStatementIsRefused() public {
        _expectOpenFails(
            alice,
            attackerPayer,
            ENROLLMENT_ID,
            _statement(ATTACKER_KEY, attackerPayer, alice, ENROLLMENT_ID),
            EscrowPolicyVault.InvalidEnrollment.selector
        );
        _expectOpenFails(alice, attackerPayer, ENROLLMENT_ID, "", EscrowPolicyVault.InvalidEnrollment.selector);
    }

    /// A genuine statement for the signer's payer, presented with another payer.
    function testAStatementCannotBeMovedToAnotherPayer() public {
        _expectOpenFails(
            alice,
            attackerPayer,
            ENROLLMENT_ID,
            _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID),
            EscrowPolicyVault.InvalidEnrollment.selector
        );
    }

    /// The orchestrator asks the signer for a payer enrolled to itself and hands that
    /// statement to the user. The vault reads the owner from msg.sender, so it fails.
    function testAStatementForAnotherOwnerIsRefused() public {
        address mallory = makeAddr("mallory");
        _expectOpenFails(
            alice,
            payer,
            ENROLLMENT_ID,
            _statement(ENROLLMENT_KEY, payer, mallory, ENROLLMENT_ID),
            EscrowPolicyVault.InvalidEnrollment.selector
        );
    }

    /// Front-running: someone who sees the user's statement in the mempool cannot use
    /// it to bind the payer to a goal of their own.
    function testAnotherSenderCannotUseTheUsersStatement() public {
        bytes memory statement = _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID);
        _expectOpenFails(
            makeAddr("front-runner"), payer, ENROLLMENT_ID, statement, EscrowPolicyVault.InvalidEnrollment.selector
        );
        _open(alice, payer, ENROLLMENT_ID, statement);
    }

    function testTheEnrollmentIdIsBound() public {
        _expectOpenFails(
            alice,
            payer,
            keccak256("another id"),
            _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID),
            EscrowPolicyVault.InvalidEnrollment.selector
        );
    }

    /// The domain carries the chain and the vault: a statement for one vault opens
    /// nothing on another, even one trusting the same enrollment key.
    function testAStatementForAnotherVaultOrChainIsRefused() public {
        EscrowPolicyVault other = new EscrowPolicyVault(ESCROW, COLLECTOR, vm.addr(ENROLLMENT_KEY));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ENROLLMENT_KEY, other.enrollmentDigest(payer, alice, ENROLLMENT_ID));
        _expectOpenFails(
            alice, payer, ENROLLMENT_ID, abi.encodePacked(r, s, v), EscrowPolicyVault.InvalidEnrollment.selector
        );

        bytes memory here = _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID);
        vm.chainId(block.chainid + 1);
        _expectOpenFails(alice, payer, ENROLLMENT_ID, here, EscrowPolicyVault.InvalidEnrollment.selector);
    }

    function testAStatementOpensOneGoalOnly() public {
        bytes memory statement = _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID);
        _open(alice, payer, ENROLLMENT_ID, statement);
        _expectOpenFails(alice, payer, ENROLLMENT_ID, statement, PolicyVault.PayerAlreadyBound.selector);
    }

    function testTheUncheckedOpenIsClosed() public {
        PolicyVault.OpenGoalParams memory params = _params(payer);
        uint256 fee = 2 * inco.getFee();
        vm.deal(alice, fee);
        vm.prank(alice);
        vm.expectRevert(EscrowPolicyVault.UseOpenEnrolledGoal.selector);
        vault.openGoal{value: fee}(params);
    }

    function testAMalformedSignatureIsRefusedWithTheSameError() public {
        _expectOpenFails(alice, payer, ENROLLMENT_ID, hex"deadbeef", EscrowPolicyVault.InvalidEnrollment.selector);
        bytes memory statement = _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID);
        statement[64] = bytes1(uint8(statement[64]) ^ 0x01); // v = 27 <-> 28
        _expectOpenFails(alice, payer, ENROLLMENT_ID, statement, EscrowPolicyVault.InvalidEnrollment.selector);
    }

    function testTheConstructorRefusesNoEnrollmentSigner() public {
        vm.expectRevert(EscrowPolicyVault.InvalidEnrollmentSigner.selector);
        new EscrowPolicyVault(ESCROW, COLLECTOR, address(0));
    }

    // -------------------------------------------------------------- setup finality

    /// The setup transaction is dropped by a reorganization after the console saw it.
    /// The payer is unbound again, but no statement for it names anyone but its
    /// owner, so the attacker cannot bind it, and the owner can open it again with
    /// the same statement. Funding sent in between is never exposed to another goal.
    function testADroppedSetupLeavesThePayerBindableOnlyByItsOwner() public {
        bytes memory statement = _statement(ENROLLMENT_KEY, payer, alice, ENROLLMENT_ID);
        uint256 snapshot = vm.snapshotState();
        _open(alice, payer, ENROLLMENT_ID, statement);
        vm.revertToState(snapshot);
        assertEq(vault.payerGoal(payer), 0, "the setup is gone");

        address mallory = makeAddr("mallory");
        _expectOpenFails(mallory, payer, ENROLLMENT_ID, statement, EscrowPolicyVault.InvalidEnrollment.selector);
        _expectOpenFails(
            mallory,
            payer,
            ENROLLMENT_ID,
            _statement(ATTACKER_KEY, payer, mallory, ENROLLMENT_ID),
            EscrowPolicyVault.InvalidEnrollment.selector
        );

        uint256 goalId = _open(alice, payer, ENROLLMENT_ID, statement);
        (address owner,,,,,,,) = vault.goals(goalId);
        assertEq(owner, alice);
    }
}
