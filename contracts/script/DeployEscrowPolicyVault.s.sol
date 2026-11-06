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
///   forge script script/DeployEscrowPolicyVault.s.sol:DeployEscrowPolicyVault \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL"
///   forge script script/DeployEscrowPolicyVault.s.sol:DeployEscrowPolicyVault \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
///
/// To verify the source afterwards:
///
///   forge verify-contract <vault> src/EscrowPolicyVault.sol:EscrowPolicyVault --chain 84532 \
///     --constructor-args $(cast abi-encode "constructor(address,address)" <escrow> <collector>) \
///     --etherscan-api-key "$BASESCAN_API_KEY" --watch
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

    function run() external returns (EscrowPolicyVault vault) {
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

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        vault = new EscrowPolicyVault(IAuthCaptureEscrow(ESCROW), COLLECTOR);
        vm.stopBroadcast();

        require(
            address(vault.escrow()) == ESCROW && vault.collector() == COLLECTOR,
            DeployedWithOtherAddresses(address(vault.escrow()), vault.collector())
        );

        console.log("chainId             :", block.chainid);
        console.log("Inco singleton      :", address(inco));
        console.log("Inco fee (wei)      :", inco.getFee());
        console.log("Escrow              :", ESCROW);
        console.log("Collector           :", COLLECTOR);
        console.log("EscrowPolicyVault   :", address(vault));
        console.log("AUTHORIZATION_WINDOW:", vault.AUTHORIZATION_WINDOW());
        console.log("MAX_CAPTURE_WINDOW  :", vault.MAX_CAPTURE_WINDOW());
        console.log("");
        console.log("Set both of these to the vault's address, then restart the services:");
        console.log("  POLICY_VAULT_ADDRESS");
        console.log("  FACILITATOR_ESCROW_OPERATORS");
        console.log("Then rebind the enclave signer, which reads goals from one vault:");
        console.log("  update POLICY_VAULT_ADDRESS in its ROFL secrets and redeploy it.");
    }
}
