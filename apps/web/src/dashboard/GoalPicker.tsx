/**
 * The goal picker — a search field that opens the catalog.
 *
 * Interaction model adapted from the Beautiful UI prompt bar: a menu that grows
 * from the field, one *gliding* highlight rather than a background toggled per
 * row, keyboard ↑↓/Enter/Escape, and a pop-in on open. The original is Next.js
 * + Tailwind and pulls in `glimm` for a shader sweep; this project has none of
 * those, so the behaviour is reproduced against the local token set and the
 * shader is dropped rather than adding a dependency.
 *
 * The single gliding highlight is the detail worth keeping. Toggling a
 * background on each row makes the selection blink from place to place; one
 * element that animates its `top` reads as a cursor moving down a list, which
 * is what it actually is.
 *
 * Typing filters. Clicking the field opens the full catalog, because a viewer
 * who has never seen this before does not know what to type.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEMO_GOALS, type DemoGoal } from "@ntux402/shared";

import { formatUsdc } from "../lib/config.js";

export function GoalPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: DemoGoal | undefined;
  onSelect: (goal: DemoGoal) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /* The highlight stays hidden until a row is actually pointed at or arrowed
     to, so an opened menu does not assert a selection nobody made. */
  const [engaged, setEngaged] = useState(false);
  const [box, setBox] = useState<{ top: number; height: number }>();

  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const matches = DEMO_GOALS.filter(
    (g) =>
      needle === "" ||
      g.label.toLowerCase().includes(needle) ||
      g.blurb.toLowerCase().includes(needle) ||
      g.kind.includes(needle),
  );

  /*
   * Opening starts the cursor on whatever is already selected, so arrowing
   * continues from there rather than jumping back to the top of the list.
   * Typing resets it, because the old selection may not even be in the results.
   */
  const selectedIndex = matches.findIndex((g) => g.key === selected?.key);
  useEffect(() => {
    setActive(selectedIndex === -1 ? 0 : selectedIndex);
    setEngaged(false);
    // Deliberately not keyed on selectedIndex: this should fire when the menu
    // opens or the query changes, not every time the selection does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  /*
   * Glide the highlight to the active row.
   *
   * The row is read out of the DOM rather than kept in an array of refs. An
   * inline `ref` callback has a new identity on every render, so React detaches
   * and reattaches the whole array each pass; querying at effect time sidesteps
   * that lifecycle entirely and is no more expensive at four rows.
   */
  useLayoutEffect(() => {
    const target = menu.current?.querySelectorAll<HTMLElement>(".gp-row")[active];
    if (target) setBox({ top: target.offsetTop, height: target.offsetHeight });
  }, [active, query, open, matches.length]);

  // Close on outside pointer or Escape. Registered only while open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function choose(goal: DemoGoal) {
    onSelect(goal);
    setOpen(false);
    setQuery("");
    input.current?.blur();
  }

  return (
    <div className="gp" ref={wrap}>
      <div className="gp-field" data-open={open ? "" : undefined}>
        <SearchIcon />
        <input
          ref={input}
          className="gp-input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="gp-menu"
          aria-autocomplete="list"
          placeholder={selected ? selected.label : "Search resources to buy…"}
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!open) {
              if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (matches.length === 0) return;
              setEngaged(true);
              setActive(
                (c) => (c + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length,
              );
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const pick = matches[active];
              if (pick) choose(pick);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {selected && query === "" ? (
          <span className="gp-price" aria-hidden="true">
            {formatUsdc(BigInt(selected.priceAtomic))} USDC
          </span>
        ) : null}
        <ChevronIcon open={open} />
      </div>

      {open ? (
        <div
          id="gp-menu"
          ref={menu}
          className="gp-menu"
          role="listbox"
          onMouseLeave={() => setEngaged(false)}
        >
          <span
            aria-hidden="true"
            className="gp-glide"
            style={{
              top: box?.top ?? 0,
              height: box?.height ?? 0,
              opacity: box && engaged && matches.length > 0 ? 1 : 0,
            }}
          />

          {matches.map((goal, i) => (
            <button
              key={goal.key}
              type="button"
              role="option"
              aria-selected={goal.key === selected?.key}
              className="gp-row"
              data-kind={goal.kind}
              // Prevent the input losing focus before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => {
                setActive(i);
                setEngaged(true);
              }}
              onClick={() => choose(goal)}
            >
              <span className="gp-row-dot" aria-hidden="true" />
              <span className="gp-row-text">
                <span className="gp-row-name">{goal.label}</span>
                <span className="gp-row-blurb">{goal.blurb}</span>
              </span>
              <span className="gp-row-price">{formatUsdc(BigInt(goal.priceAtomic))}</span>
              <span className="gp-row-tag">{TACTIC_LABEL[goal.tactic]}</span>
            </button>
          ))}

          {matches.length === 0 ? (
            <p className="gp-empty">No resource matches “{query}”.</p>
          ) : null}

          <p className="gp-foot">
            Four resources. Two settle, two are refused — for different reasons.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const TACTIC_LABEL: Record<DemoGoal["tactic"], string> = {
  none: "fair price",
  overcharge: "over budget",
  injection: "injection",
};

function SearchIcon() {
  return (
    <svg
      className="gp-icon"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="gp-chevron"
      data-open={open ? "" : undefined}
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
