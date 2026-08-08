// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {inco} from "@inco/lightning/src/Lib.sol";

import {PolicyVault} from "../src/PolicyVault.sol";

/// Deploys PolicyVault to Base Sepolia.
///
///   forge script script/DeployPolicyVault.s.sol:DeployPolicyVault \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --verify
contract DeployPolicyVault is Script {
    uint256 constant BASE_SEPOLIA = 84532;

    error WrongChain(uint256 actual);
    error IncoNotDeployed(address expected);

    function run() external returns (PolicyVault vault) {
        // Assert the chain rather than infer it. The Inco singleton address is
        // baked into Lib.sol, so deploying against anything else yields a vault
        // whose encrypted operations silently point at nothing.
        require(block.chainid == BASE_SEPOLIA, WrongChain(block.chainid));
        require(address(inco).code.length > 0, IncoNotDeployed(address(inco)));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        vault = new PolicyVault();
        vm.stopBroadcast();

        console.log("chainId            :", block.chainid);
        console.log("Inco singleton     :", address(inco));
        console.log("Inco fee (wei)     :", inco.getFee());
        console.log("PolicyVault        :", address(vault));
        console.log("AUTHORIZATION_WINDOW:", vault.AUTHORIZATION_WINDOW());
    }
}
