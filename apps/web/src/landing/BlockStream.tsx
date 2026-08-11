/**
 * Hero visual: blocks being appended to a chain.
 *
 * Chosen over repeating the step diagram, which appears in full one section
 * later — a hero that previews the section below it is just the same picture
 * twice. This says "blockchain" immediately and structurally differs from the
 * flow: that one is a fixed sequence with a travelling highlight, this one is a
 * moving list with fixed styling.
 *
 * Motion budget is one transition every ~2.4s, each 180ms. Nothing loops
 * continuously, nothing scrolls, and under `prefers-reduced-motion` the list is
 * rendered once and left alone.
 *
 * The numbers are illustrative, not live. It is a landing page, so it reads no
 * chain and claims no state — the height simply counts up from a fixed base.
 */

import { useEffect, useRef, useState } from "react";

interface Block {
  readonly height: number;
  readonly hash: string;
  readonly txs: number;
}

/** How many rows are visible. Five fills the hero without becoming a wall. */
const DEPTH = 5;
const TICK_MS = 2400;

/** A Base Sepolia height around the time this was built — plausible, not fetched. */
const BASE_HEIGHT = 45_229_926;

const HEX = "0123456789abcdef";

function randomHash(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += HEX[Math.floor(Math.random() * 16)];
  let tail = "";
  for (let i = 0; i < 4; i++) tail += HEX[Math.floor(Math.random() * 16)];
  return `0x${out}…${tail}`;
}

function makeBlock(height: number): Block {
  return { height, hash: randomHash(), txs: 2 + Math.floor(Math.random() * 40) };
}

function seed(): Block[] {
  return Array.from({ length: DEPTH }, (_, i) => makeBlock(BASE_HEIGHT - i));
}

export function BlockStream() {
  const [blocks, setBlocks] = useState<Block[]>(seed);
  const next = useRef(BASE_HEIGHT + 1);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduce.matches) return;

    const timer = window.setInterval(() => {
      // Built outside the updater on purpose. `makeBlock` advances a ref and
      // calls Math.random(), and React deliberately double-invokes updaters to
      // catch impurity — doing this inline made the height jump by two per
      // tick, so the chain rendered with gaps in its sequence.
      const block = makeBlock(next.current++);
      setBlocks((prior) => [block, ...prior.slice(0, DEPTH - 1)]);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="bs" aria-hidden="true">
      <div className="bs-head">
        <span className="bs-dot" />
        <span>Base Sepolia</span>
      </div>
      <ul className="bs-list">
        {blocks.map((block, i) => (
          // Keyed by height so React animates the entering row rather than
          // recycling the topmost node and animating nothing.
          <li key={block.height} className="bs-block" data-lead={i === 0 ? "true" : undefined}>
            <span className="bs-height">#{block.height.toLocaleString("en-US")}</span>
            <span className="bs-hash">{block.hash}</span>
            <span className="bs-txs">{block.txs} tx</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
