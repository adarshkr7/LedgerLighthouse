// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";
import {inco} from "@inco/lightning/src/Lib.sol";
import {IncoSmokeTest} from "../src/IncoSmokeTest.sol";

contract IncoSmokeTestTest is IncoTest {
    IncoSmokeTest target;

    function setUp() public override {
        super.setUp();
        target = new IncoSmokeTest();
    }

    function test_setAndReveal() public {
        vm.deal(address(this), inco.getFee());
        target.set{value: inco.getFee()}(42);
        processAllOperations();
        assertEq(getUint256Value(target.value()), 42);
    }
}
