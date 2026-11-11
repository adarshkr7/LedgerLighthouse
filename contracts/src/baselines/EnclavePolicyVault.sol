// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAuthCaptureEscrow} from "../EscrowPolicyVault.sol";
import {BaselineEscrowVault} from "./BaselineEscrowVault.sol";

/// @title EnclavePolicyVault: limits held in the signer's enclave, state anchored on chain
///
/// @notice The enclave-only comparator. The budget and cap never reach the chain: the
/// enclave keeps them, decides each request, and signs the decision. What the chain
/// keeps is what stops the enclave's private state from being rolled back or forked:
///
///   - `stateRoot`, a commitment to the enclave's per-goal state (salted, so it says
///     nothing). A decision names the root it was made from and the root it leads to,
///     and is accepted only if the first is the current one. A restarted or cloned
///     enclave holding an old state cannot have a decision accepted from it.
///   - `credited`, the public sum of amounts reclaimed. Reclaim happens on chain
///     without the enclave, so a decision names the credit total it assumed, and is
///     accepted only if that is the current one. An RPC that lies to the enclave about
///     reclaims gets its decisions refused, never honoured.
///
/// So the chain enforces freshness and the enclave enforces the limits. Under the
/// paper's threat model this is what a single trusted system gives: if the enclave is
/// compromised it signs whatever it likes, here as in the payer key it already holds.
contract EnclavePolicyVault is BaselineEscrowVault {
    bytes32 public constant DECISION_TYPEHASH = keccak256(
        "Decision(uint256 goalId,uint64 seq,uint256 amount,address payTo,bool approved,bytes32 fromRoot,bytes32 toRoot,uint256 credited)"
    );

    /// The enclave's decision key, fixed at deployment like the enrollment key.
    address public immutable policySigner;

    mapping(uint256 goalId => bytes32) public stateRoot;
    mapping(uint256 goalId => uint256) public credited;

    error StaleState();

    constructor(IAuthCaptureEscrow escrow_, address collector_, address enrollmentSigner_, address policySigner_)
        BaselineEscrowVault(escrow_, collector_, enrollmentSigner_, "EnclavePolicyVault")
    {
        policySigner = policySigner_;
    }

    /// @param initialRoot The enclave's commitment to the goal's limits, which it
    /// returns with the enrollment. Nothing on chain says what the limits are.
    function openEnrolledGoal(
        GoalParams calldata params,
        bytes32 initialRoot,
        bytes32 enrollmentId,
        bytes calldata signature
    ) external returns (uint256 goalId) {
        goalId = _openGoal(params, enrollmentId, signature);
        stateRoot[goalId] = initialRoot;
    }

    /// The fields a decision signs, kept together to stay within the stack.
    struct Decision {
        uint256 goalId;
        uint64 seq;
        uint256 amount;
        address payTo;
        bool approved;
        bytes32 fromRoot;
        bytes32 toRoot;
        uint256 credited;
    }

    /// @param policyData abi.encode(bool approved, bytes32 toRoot, bytes signature)
    function _decide(uint256 goalId, uint64 seq, uint256 amount, address payTo, bytes calldata policyData)
        internal
        override
        returns (bool approved)
    {
        (bool claimed, bytes32 toRoot, bytes memory signature) = abi.decode(policyData, (bool, bytes32, bytes));
        bytes32 digest = _digest(
            Decision({
                goalId: goalId,
                seq: seq,
                amount: amount,
                payTo: payTo,
                approved: claimed,
                fromRoot: stateRoot[goalId],
                toRoot: toRoot,
                credited: credited[goalId]
            })
        );
        (address signer, ECDSA.RecoverError failure,) = ECDSA.tryRecover(digest, signature);
        // One error for both: a decision from a stale state verifies against no current
        // root, so it is indistinguishable from a forged one, and should be.
        require(failure == ECDSA.RecoverError.NoError && signer == policySigner, StaleState());
        stateRoot[goalId] = toRoot;
        return claimed;
    }

    function _digest(Decision memory d) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DECISION_TYPEHASH, d.goalId, d.seq, d.amount, d.payTo, d.approved, d.fromRoot, d.toRoot, d.credited
                )
            )
        );
    }

    function _credit(uint256 goalId, uint256 amount) internal override {
        credited[goalId] += amount;
    }

    function decisionDigest(Decision calldata d) external view returns (bytes32) {
        return _digest(d);
    }
}
