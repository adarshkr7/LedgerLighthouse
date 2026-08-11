// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title TraceAnchor — 32 bytes of commitment per execution trace
///
/// @notice Anchors the Merkle root of an execution trace on chain.
///
/// ## Why the root and not the trace
///
/// Putting the full trace on chain would leak prompts, purchased data and
/// vendor relationships, and its cost would scale with volume. The root is 32
/// bytes and lets anyone *holding* the trace prove it has not been altered
/// since the anchor landed (ARCHITECTURE.md §8.4). Someone without the trace learns
/// nothing from the root — which is the point.
///
/// ## What anchoring does and does not prove
///
/// It proves the trace existed in this exact form no later than the anchoring
/// block. It does not prove the trace is *true* — that comes from the
/// attestations and approval records inside it, which the standalone verifier
/// checks against `PolicyVault` and the Inco verifier.
///
/// Anchors are immutable once written. Re-anchoring the same goal with a
/// different root would let the anchorer rewrite history after the fact, which
/// would make the commitment worthless.
contract TraceAnchor {
    struct Anchor {
        bytes32 root;
        address anchoredBy;
        uint64 anchoredAt;
        uint32 stepCount;
    }

    /// @dev Keyed by (vault, goalId) so anchors from different vaults cannot collide.
    mapping(address vault => mapping(uint256 goalId => Anchor)) internal _anchors;

    event TraceAnchored(
        address indexed vault,
        uint256 indexed goalId,
        bytes32 indexed root,
        address anchoredBy,
        uint32 stepCount,
        uint64 anchoredAt
    );

    error AlreadyAnchored(bytes32 existingRoot);
    error EmptyRoot();
    error EmptyTrace();

    /// @notice Records the Merkle root of a completed trace.
    ///
    /// @dev Permissionless on purpose. An anchor is a commitment, not a claim
    /// of authority: a forged anchor for a goal you do not own commits you to
    /// nothing, because the verifier checks the trace against `PolicyVault`
    /// rather than against whoever wrote the anchor. Gating this on the goal
    /// owner would add a signature requirement to the one step that runs after
    /// the user has gone home.
    function anchor(address vault, uint256 goalId, bytes32 root, uint32 stepCount) external {
        require(root != bytes32(0), EmptyRoot());
        require(stepCount > 0, EmptyTrace());

        Anchor storage existing = _anchors[vault][goalId];
        // First write wins. Anything else lets the anchorer revise history.
        require(existing.root == bytes32(0), AlreadyAnchored(existing.root));

        _anchors[vault][goalId] = Anchor({
            root: root,
            anchoredBy: msg.sender,
            anchoredAt: uint64(block.timestamp),
            stepCount: stepCount
        });

        emit TraceAnchored(vault, goalId, root, msg.sender, stepCount, uint64(block.timestamp));
    }

    function anchorOf(address vault, uint256 goalId) external view returns (Anchor memory) {
        return _anchors[vault][goalId];
    }

    /// @notice True when this exact root is the one anchored for the goal.
    /// The check a verifier makes after recomputing the root from the trace.
    function isAnchored(address vault, uint256 goalId, bytes32 root) external view returns (bool) {
        return root != bytes32(0) && _anchors[vault][goalId].root == root;
    }
}
