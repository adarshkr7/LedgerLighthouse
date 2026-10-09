/**
 * A local-key account for code that sends transactions.
 *
 * Without a nonce manager viem asks the RPC for the account's pending nonce
 * before every send. Public Base endpoints are load balanced, and the node that
 * answers can be a block behind the one that just returned a receipt. The
 * adversary campaign hit exactly that on 9 October 2026: `openGoal` confirmed
 * at nonce 42, and the next `openGoal` was built with nonce 42 again and
 * rejected as "nonce too low".
 *
 * viem's `nonceManager` keeps the last nonce this process used and takes the
 * next one past it when the RPC reports a stale count. It is keyed by address
 * and chain and shared across accounts, so two clients holding the same key in
 * one process (the relay and the trace anchor) draw from one sequence instead
 * of racing. When a send fails before broadcast, viem resets the entry, so a
 * call that reverts at gas estimation leaves no gap.
 *
 * It does not help across processes. Two processes sending from one key still
 * race; keep each sending key in one process at a time.
 */

import type { Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

export function sendingAccount(key: Hex) {
  return privateKeyToAccount(key, { nonceManager });
}
