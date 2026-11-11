// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// forge-lint: disable-start(unsafe-typecast)

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {AccountingInvariantsTest} from "./AccountingInvariants.t.sol";

/// Records what the deployed escrow, collector and USDC read during the invariant
/// suite's setUp and a scripted flow through every transition, at the pinned block,
/// and writes it to test/fixtures/escrow-state.json: each account's code and the value
/// each slot had before the flow touched it. EscrowFixture installs it into a plain
/// local EVM, so the invariant campaign runs with no network.
///
/// Run only to refresh the fixture:
///   ESCROW_FORK_RPC=https://sepolia.base.org SNAPSHOT_ESCROW=1 \
///     forge test --match-contract SnapshotEscrowState -j 1
contract SnapshotEscrowStateTest is AccountingInvariantsTest {
    using stdJson for string;

    address[] internal seen;
    mapping(address => bool) internal isSeen;
    mapping(address => bytes32[]) internal slots;
    mapping(address => mapping(bytes32 => bool)) internal slotSeen;
    mapping(address => mapping(bytes32 => bytes32)) internal before;
    mapping(address => bool) internal created;
    mapping(address => bytes) internal codeAt;

    function setUp() public override {
        if (vm.envOr("SNAPSHOT_ESCROW", uint256(0)) == 0) {
            vm.skip(true);
            return;
        }
        vm.startStateDiffRecording();
        super.setUp();
    }

    function testWriteTheEscrowFixture() public {
        // Every transition, so every slot the deployed contracts read is in the fixture.
        handler.requestValid(100_000, 600, 300, true);
        handler.collectLatest();
        handler.claim(handler.maxSeq());
        handler.requestValid(50_000, 600, 300, true);
        handler.collectLatest();
        handler.warp(20 minutes);
        handler.warp(20 minutes);
        handler.payerReclaim(handler.maxSeq());
        handler.reclaim(handler.maxSeq());
        handler.requestValid(60_000, 60, 0, true);
        handler.warp(5 minutes);
        handler.reclaim(handler.maxSeq());
        handler.requestValid(70_000, 600, 300, true);
        handler.collectLatest();
        handler.warp(30 minutes);
        handler.reclaim(handler.maxSeq());
        handler.close(0);
        handler.sweep();

        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 live = vm.activeFork();

        // Accounts created during the run (the vault, the handler, Inco's test double,
        // the escrow's token stores) are rebuilt by the suite itself. Everything else
        // that was touched existed at the pinned block, and is what the fixture holds.
        for (uint256 i = 0; i < accesses.length; i++) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Create) created[accesses[i].account] = true;
        }
        for (uint256 i = 0; i < accesses.length; i++) {
            _note(accesses[i].account);
            for (uint256 j = 0; j < accesses[i].storageAccesses.length; j++) {
                Vm.StorageAccess memory st = accesses[i].storageAccesses[j];
                _note(st.account);
                if (created[st.account] || slotSeen[st.account][st.slot]) continue;
                slotSeen[st.account][st.slot] = true;
                slots[st.account].push(st.slot);
                before[st.account][st.slot] = st.previousValue;
            }
        }

        // Code from a clean fork at the same block, not from this one, where the suite
        // has etched over some addresses.
        uint256 clean = vm.createFork(vm.envString("ESCROW_FORK_RPC"), FORK_BLOCK);
        vm.selectFork(clean);
        for (uint256 i = 0; i < seen.length; i++) {
            codeAt[seen[i]] = seen[i].code;
        }
        vm.selectFork(live);

        string memory root = "fixture";
        string memory out;
        for (uint256 i = 0; i < seen.length; i++) {
            address acct = seen[i];
            string memory key = vm.toString(acct);
            string memory obj = key;
            if (codeAt[acct].length == 0 && slots[acct].length == 0) continue;
            vm.serializeBytes(obj, "code", codeAt[acct]);
            bytes32[] memory keys = slots[acct];
            bytes32[] memory values = new bytes32[](keys.length);
            for (uint256 k = 0; k < keys.length; k++) {
                values[k] = before[acct][keys[k]];
            }
            vm.serializeBytes32(obj, "slots", keys);
            string memory entry = vm.serializeBytes32(obj, "values", values);
            out = vm.serializeString(root, key, entry);
        }
        vm.serializeUint(root, "block", FORK_BLOCK);
        vm.selectFork(clean);
        vm.serializeUint(root, "timestamp", block.timestamp);
        vm.selectFork(live);
        out = vm.serializeUint(root, "chainId", block.chainid);
        vm.writeJson(out, "test/fixtures/escrow-state.json");
    }

    function _note(address acct) internal {
        if (created[acct] || isSeen[acct] || acct == address(vm) || acct == address(this)) return;
        isSeen[acct] = true;
        seen.push(acct);
    }
}
// forge-lint: disable-end(unsafe-typecast)
