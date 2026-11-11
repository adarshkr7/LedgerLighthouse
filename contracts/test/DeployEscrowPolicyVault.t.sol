// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {inco} from "@inco/lightning/src/Lib.sol";

import {EscrowPolicyVault} from "../src/EscrowPolicyVault.sol";
import {DeployEscrowPolicyVault} from "../script/DeployEscrowPolicyVault.s.sol";

/// Answers the one question the script asks a collector.
contract StubCollector {
    address public immutable authCaptureEscrow;

    constructor(address escrow) {
        authCaptureEscrow = escrow;
    }
}

/// The refusals run with no network: each one is reached by giving the chain only what
/// the check before it needs. A deploy that succeeds needs the real contracts, so that
/// one runs on a fork.
///
///   ESCROW_FORK_RPC=https://sepolia.base.org forge test --match-contract DeployEscrowPolicyVault
contract DeployEscrowPolicyVaultTest is Test {
    uint256 private constant BASE_SEPOLIA = 84532;
    uint256 private constant BASE = 8453;
    /// Anvil's first key, public. Nothing here reaches a network that could spend it.
    uint256 private constant TEST_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address private constant ENROLLMENT = address(0xE1);

    DeployEscrowPolicyVault private script;
    address private escrow;
    address private collector;

    function setUp() public {
        script = new DeployEscrowPolicyVault();
        escrow = script.ESCROW();
        collector = script.COLLECTOR();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(TEST_KEY)));
    }

    function _stubCollector(address serves) private {
        vm.etch(collector, address(new StubCollector(serves)).code);
    }

    function test_RefusesAChainIncoIsNotOn() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowPolicyVault.WrongChain.selector, 1));
        script.run(ENROLLMENT);
    }

    function test_RefusesWithoutInco() public {
        vm.chainId(BASE_SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowPolicyVault.IncoNotDeployed.selector, address(inco)));
        script.run(ENROLLMENT);
    }

    function test_RefusesWithoutTheEscrow() public {
        vm.chainId(BASE);
        vm.etch(address(inco), hex"00");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowPolicyVault.EscrowNotDeployed.selector, escrow));
        script.run(ENROLLMENT);
    }

    function test_RefusesWithoutTheCollector() public {
        vm.chainId(BASE_SEPOLIA);
        vm.etch(address(inco), hex"00");
        vm.etch(escrow, hex"00");
        vm.expectRevert(abi.encodeWithSelector(DeployEscrowPolicyVault.CollectorNotDeployed.selector, collector));
        script.run(ENROLLMENT);
    }

    /// The collector takes calls only from its own escrow, so this pair could never collect.
    function test_RefusesACollectorServingAnotherEscrow() public {
        address other = makeAddr("another escrow");
        vm.chainId(BASE_SEPOLIA);
        vm.etch(address(inco), hex"00");
        vm.etch(escrow, hex"00");
        _stubCollector(other);
        vm.expectRevert(
            abi.encodeWithSelector(DeployEscrowPolicyVault.CollectorServesAnotherEscrow.selector, collector, other)
        );
        script.run(ENROLLMENT);
    }

    function test_RefusesWithoutAnEnrollmentSigner() public {
        vm.chainId(BASE_SEPOLIA);
        vm.etch(address(inco), hex"00");
        vm.etch(escrow, hex"00");
        _stubCollector(escrow);
        vm.expectRevert(DeployEscrowPolicyVault.NoEnrollmentSigner.selector);
        script.run(address(0));
    }

    /// Against the real contracts: what it deploys is wired to the pinned pair.
    function test_DeploysAVaultBoundToThePinnedEscrowAndCollector() public {
        string memory rpc = vm.envOr("ESCROW_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        // Before the fork: a fork has only its own state, so the script must come across.
        vm.makePersistent(address(script));
        vm.createSelectFork(rpc);

        EscrowPolicyVault vault = script.run(ENROLLMENT);

        assertEq(address(vault.escrow()), 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c);
        assertEq(vault.collector(), 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88);
        assertGt(address(vault).code.length, 0);
        assertEq(vault.enrollmentSigner(), ENROLLMENT);
        assertEq(vault.goalCount(), 0);
    }
}
