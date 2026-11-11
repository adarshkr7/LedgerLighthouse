// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IAuthCaptureEscrow} from "../EscrowPolicyVault.sol";
import {BaselineEscrowVault} from "./BaselineEscrowVault.sol";

/// @title PlaintextEscrowVault: the same policy with public limits
///
/// @notice The budget and the per-call cap are plain storage, readable by anyone,
/// and a request is decided in the transaction that makes it. Integrity is the same as
/// EscrowPolicyVault's; the difference is that every observer, every vendor included,
/// reads the limits directly instead of probing for them. A comparator for the paper.
contract PlaintextEscrowVault is BaselineEscrowVault {
    mapping(uint256 goalId => uint256) public remainingBudget;
    mapping(uint256 goalId => uint256) public perCallCap;

    constructor(IAuthCaptureEscrow escrow_, address collector_, address enrollmentSigner_)
        BaselineEscrowVault(escrow_, collector_, enrollmentSigner_, "PlaintextEscrowVault")
    {}

    function openEnrolledGoal(
        GoalParams calldata params,
        uint256 budget,
        uint256 cap,
        bytes32 enrollmentId,
        bytes calldata signature
    ) external returns (uint256 goalId) {
        goalId = _openGoal(params, enrollmentId, signature);
        remainingBudget[goalId] = budget;
        perCallCap[goalId] = cap;
    }

    function _decide(uint256 goalId, uint64, uint256 amount, address, bytes calldata)
        internal
        override
        returns (bool approved)
    {
        approved = amount <= perCallCap[goalId] && amount <= remainingBudget[goalId];
        if (approved) remainingBudget[goalId] -= amount;
    }

    function _credit(uint256 goalId, uint256 amount) internal override {
        remainingBudget[goalId] += amount;
    }
}
