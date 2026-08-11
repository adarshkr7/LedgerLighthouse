// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {TraceAnchor} from "../src/TraceAnchor.sol";

contract TraceAnchorTest is Test {
    TraceAnchor anchorContract;
    address constant VAULT = address(0x1234567890123456789012345678901234567890);
    uint256 constant GOAL_ID = 1;
    bytes32 constant ROOT = keccak256("test-merkle-root");
    uint32 constant STEP_COUNT = 9;

    function setUp() public {
        anchorContract = new TraceAnchor();
    }

    function testAnchorRecordsCommitment() public {
        anchorContract.anchor(VAULT, GOAL_ID, ROOT, STEP_COUNT);

        TraceAnchor.Anchor memory a = anchorContract.anchorOf(VAULT, GOAL_ID);
        assertEq(a.root, ROOT);
        assertEq(a.anchoredBy, address(this));
        assertEq(a.stepCount, STEP_COUNT);
        assertEq(a.anchoredAt, uint64(block.timestamp));

        assertTrue(anchorContract.isAnchored(VAULT, GOAL_ID, ROOT));
        assertFalse(anchorContract.isAnchored(VAULT, GOAL_ID, keccak256("wrong-root")));
    }

    function testCannotReAnchorSameGoal() public {
        anchorContract.anchor(VAULT, GOAL_ID, ROOT, STEP_COUNT);

        vm.expectRevert(abi.encodeWithSelector(TraceAnchor.AlreadyAnchored.selector, ROOT));
        anchorContract.anchor(VAULT, GOAL_ID, keccak256("different-root"), 10);
    }

    function testCannotAnchorEmptyRootOrTrace() public {
        vm.expectRevert(TraceAnchor.EmptyRoot.selector);
        anchorContract.anchor(VAULT, GOAL_ID, bytes32(0), STEP_COUNT);

        vm.expectRevert(TraceAnchor.EmptyTrace.selector);
        anchorContract.anchor(VAULT, GOAL_ID, ROOT, 0);
    }
}
