// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {euint256, e, inco} from "@inco/lightning/src/Lib.sol";

// M0 toolchain smoke test — confirms the inco-lightning remapping, solc version and Foundry
// cheatcode infra resolve correctly end to end. Remove once PolicyVault (M3) exercises the
// same import path and cheatcodes for real.
contract IncoSmokeTest {
    using e for euint256;
    using e for uint256;

    euint256 public value;

    constructor() {
        value = uint256(0).asEuint256();
        value.allowThis();
    }

    function set(uint256 v) external payable {
        require(msg.value == inco.getFee(), "IncoSmokeTest: fee not paid");
        euint256 newValue = uint256(v).asEuint256();
        newValue.allowThis();
        newValue.allow(msg.sender);
        value = newValue;
    }
}
