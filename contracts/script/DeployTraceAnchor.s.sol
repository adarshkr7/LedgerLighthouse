// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {TraceAnchor} from "../src/TraceAnchor.sol";

/// Deploys TraceAnchor to Base Sepolia.
///
///   forge script script/DeployTraceAnchor.s.sol:DeployTraceAnchor \
///     --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --verify
///
/// Then put the address in `.env` as `TRACE_ANCHOR_ADDRESS`; the orchestrator
/// anchors every completed trace when it is set and skips anchoring when it is
/// not, so deploying is what turns the feature on.
///
/// Unlike `PolicyVault` this holds no funds, has no owner, and takes no
/// constructor arguments — it is a mapping and one guarded write. It is also
/// permissionless by design: anchoring is a commitment, not a claim of
/// authority, so nothing here needs to know who the deployer was.
contract DeployTraceAnchor is Script {
    uint256 constant BASE_SEPOLIA = 84532;

    error WrongChain(uint256 actual);

    function run() external returns (TraceAnchor anchorContract) {
        // Asserted rather than inferred, for the same reason the vault deploy
        // asserts it: an anchor on the wrong chain is one the verifier will
        // never find, and it fails silently at read time rather than loudly here.
        require(block.chainid == BASE_SEPOLIA, WrongChain(block.chainid));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        anchorContract = new TraceAnchor();
        vm.stopBroadcast();

        console.log("chainId     :", block.chainid);
        console.log("TraceAnchor :", address(anchorContract));
        console.log("");
        console.log("Add to .env:");
        console.log("  TRACE_ANCHOR_ADDRESS=%s", address(anchorContract));
    }
}
