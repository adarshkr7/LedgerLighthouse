// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {inco} from "@inco/lightning/src/Lib.sol";

import {EscrowPolicyVault, IAuthCaptureEscrow} from "../src/EscrowPolicyVault.sol";

interface ITokenCollector {
    function authCaptureEscrow() external view returns (address);
}

/// Deploys EscrowPolicyVault to Base Sepolia, or to Base when given a Base RPC.
///
/// Without --broadcast this only simulates, which sends nothing and is the way to read
/// the gas and see the checks pass first.
///
///   forge script script/DeployEscrowPolicyVault.s.sol:DeployEscrowPolicyVault --sig "run()" \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL"
///   forge script script/DeployEscrowPolicyVault.s.sol:DeployEscrowPolicyVault --sig "run()" \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
///
/// To verify the source afterwards:
///
///   forge verify-contract <vault> src/EscrowPolicyVault.sol:EscrowPolicyVault --chain 84532 \
///     --constructor-args $(cast abi-encode "constructor(address,address,address)" <escrow> <collector> <enrollment>) \
///     --etherscan-api-key "$BASESCAN_API_KEY" --watch
///
/// ENROLLMENT_SIGNER is the signer's enrollment address, as its GET /health reports it.
/// For an enclave signer it is derived inside the enclave, so read it from the running
/// enclave whose measurements you have checked, never from a laptop's copy of the code.
///
/// It prints what to do afterwards. The vault keeps both addresses for good, so a wrong
/// one here means a new vault and new goals, which is why they are checked before the
/// transaction and not found out from the first payment.
contract DeployEscrowPolicyVault is Script {
    uint256 private constant BASE_SEPOLIA = 84532;
    uint256 private constant BASE = 8453;

    /// The same constants as packages/shared/src/chain/escrow.ts. The signer refuses to
    /// boot on a vault using any others, so the two cannot drift apart unnoticed.
    address public constant ESCROW = 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c;
    address public constant COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88;

    error WrongChain(uint256 actual);
    error IncoNotDeployed(address expected);
    error EscrowNotDeployed(address expected);
    error CollectorNotDeployed(address expected);
    error CollectorServesAnotherEscrow(address collector, address escrow);
    error DeployedWithOtherAddresses(address escrow, address collector);
    error NoEnrollmentSigner();

    function run() external returns (EscrowPolicyVault vault) {
        return run(vm.envOr("ENROLLMENT_SIGNER", address(0)));
    }

    /// The same, with the enrollment address passed in. Tests call this one, since
    /// an environment variable is shared by every test running in parallel.
    function run(address enrollment) public returns (EscrowPolicyVault vault) {
        // Assert the chain rather than infer it. The Inco singleton address is baked
        // into Lib.sol and deployed there on these two chains only, so deploying anywhere
        // else yields a vault whose encrypted operations point at nothing.
        require(block.chainid == BASE_SEPOLIA || block.chainid == BASE, WrongChain(block.chainid));
        require(address(inco).code.length > 0, IncoNotDeployed(address(inco)));

        // A contract with no code answers every call with success and no data, so the
        // vault would take its first payment before anything looked wrong.
        require(ESCROW.code.length > 0, EscrowNotDeployed(ESCROW));
        require(COLLECTOR.code.length > 0, CollectorNotDeployed(COLLECTOR));
        // The collector only takes calls from its own escrow.
        address served = ITokenCollector(COLLECTOR).authCaptureEscrow();
        require(served == ESCROW, CollectorServesAnotherEscrow(COLLECTOR, served));

        require(enrollment != address(0), NoEnrollmentSigner());

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        vault = new EscrowPolicyVault(IAuthCaptureEscrow(ESCROW), COLLECTOR, enrollment);
        vm.stopBroadcast();

        require(
            address(vault.escrow()) == ESCROW && vault.collector() == COLLECTOR
                && vault.enrollmentSigner() == enrollment,
            DeployedWithOtherAddresses(address(vault.escrow()), vault.collector())
        );

        console.log("chainId             :", block.chainid);
        console.log("Inco singleton      :", address(inco));
        console.log("Inco fee (wei)      :", inco.getFee());
        console.log("Escrow              :", ESCROW);
        console.log("Collector           :", COLLECTOR);
        console.log("Enrollment signer   :", enrollment);
        console.log("EscrowPolicyVault   :", address(vault));
        console.log("AUTHORIZATION_WINDOW:", vault.AUTHORIZATION_WINDOW());
        console.log("MAX_CAPTURE_WINDOW  :", vault.MAX_CAPTURE_WINDOW());
        console.log("");
        console.log("Set these to the vault's address, then restart the services and rebuild the console:");
        console.log("  POLICY_VAULT_ADDRESS, FACILITATOR_ESCROW_OPERATORS, VITE_POLICY_VAULT_ADDRESS");
        console.log("Set VITE_ENROLLMENT_SIGNER to the enrollment address above.");
        console.log("For the enclave: set POLICY_VAULT_ADDRESS in its ROFL secrets, restart it, and check");
        console.log("  that /health reports escrow settlement and this enrollment address.");
    }
}
