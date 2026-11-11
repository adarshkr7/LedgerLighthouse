// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IAuthCaptureEscrow} from "../../src/EscrowPolicyVault.sol";

/// A stand-in operator for services/facilitator's fork test. It has the permissionless
/// entry points x402's custom operator type requires and none of the vault's checks,
/// because that test is about whether the x402 SDK can relay our signer's signature.
/// The vault's checks are in EscrowPolicyVault.t.sol. Never deployed outside a fork.
contract ForwardingOperator {
    IAuthCaptureEscrow public immutable escrow;

    constructor(IAuthCaptureEscrow escrow_) {
        escrow = escrow_;
    }

    function authorize(
        IAuthCaptureEscrow.PaymentInfo calldata info,
        uint256 amount,
        address collector,
        bytes calldata collectorData
    ) external {
        escrow.authorize(info, amount, collector, collectorData);
    }

    function capture(IAuthCaptureEscrow.PaymentInfo calldata info, uint256 amount) external {
        escrow.capture(info, amount, 0, address(0));
    }
}
