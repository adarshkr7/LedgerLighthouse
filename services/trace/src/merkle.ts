/**
 * Merkle accumulator over the step hashes.
 *
 * Anchoring the root rather than the trace is the point (ARCHITECTURE.md §8.4): the full
 * trace leaks prompts, purchased data and vendor relationships, and its cost
 * scales with volume. The root is 32 bytes and lets anyone holding the trace
 * verify it.
 *
 * Two details that are not decoration:
 *
 *  - **Leaves and internal nodes are domain-separated** (`0x00` / `0x01`
 *    prefixes). Without that, an internal node's hash could be presented as a
 *    leaf, which lets a forged proof pass — the classic Merkle second-preimage
 *    attack.
 *  - **An odd node is promoted, not duplicated.** Duplicating the last leaf
 *    makes an `n`-leaf tree and an `n+1`-leaf tree whose last two leaves are
 *    equal produce the same root — so two different traces would share a root.
 */

import { concatHex, keccak256, type Hex } from "viem";

const LEAF_PREFIX = "0x00" as const;
const NODE_PREFIX = "0x01" as const;

export const EMPTY_ROOT: Hex = keccak256(concatHex([LEAF_PREFIX]));

export function hashLeaf(value: Hex): Hex {
  return keccak256(concatHex([LEAF_PREFIX, value]));
}

export function hashNode(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([NODE_PREFIX, left, right]));
}

export function merkleRoot(values: readonly Hex[]): Hex {
  if (values.length === 0) return EMPTY_ROOT;

  let level = values.map(hashLeaf);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      // Promoted unchanged when unpaired — see the header note on duplication.
      next.push(right === undefined ? left : hashNode(left, right));
    }
    level = next;
  }
  return level[0]!;
}

export interface MerkleProof {
  readonly index: number;
  /** Sibling hashes from leaf to root, with the side each sits on. */
  readonly path: ReadonlyArray<{ readonly hash: Hex; readonly isLeft: boolean }>;
}

export function merkleProof(values: readonly Hex[], index: number): MerkleProof {
  if (index < 0 || index >= values.length) {
    throw new RangeError(`index ${index} out of range for ${values.length} leaves`);
  }

  const path: Array<{ hash: Hex; isLeft: boolean }> = [];
  let level = values.map(hashLeaf);
  let position = index;

  while (level.length > 1) {
    const isRight = position % 2 === 1;
    const siblingIndex = isRight ? position - 1 : position + 1;
    const sibling = level[siblingIndex];
    // No sibling means this node was promoted, so nothing joins the path.
    if (sibling !== undefined) path.push({ hash: sibling, isLeft: isRight });

    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashNode(left, right));
    }
    level = next;
    position = Math.floor(position / 2);
  }

  return { index, path };
}

export function verifyMerkleProof(value: Hex, proof: MerkleProof, root: Hex): boolean {
  let computed = hashLeaf(value);
  for (const { hash, isLeft } of proof.path) {
    computed = isLeft ? hashNode(hash, computed) : hashNode(computed, hash);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
