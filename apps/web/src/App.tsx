/**
 * The demo, as a page.
 *
 * MetaMask signs exactly three things: `openGoal`, the USDC funding transfer,
 * and goal closure when the user asks for their money back. It signs
 * **nothing inside the payment loop** —
 * that is what the ephemeral payer key is for, and what `e.reveal` makes
 * possible (ARCHITECTURE.md §5.5). If a wallet prompt ever appears while a run is in
 * flight, the design has drifted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain, useWalletClient } from "wagmi";
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";
import { DEMO_GOALS, DEMO_PAYEES, policyVaultAbi, usdcAbi, type DemoGoal } from "@ntux402/shared";

import { Copyable, Dot, Field, Ring, truncate } from "./dashboard/primitives.js";
import { Timeline } from "./dashboard/Timeline.js";
import { EvidenceBody, GuaranteeList, Outcome, evidenceCount } from "./dashboard/panels.js";
import { Modal } from "./dashboard/Modal.js";
import { ModelInput } from "./dashboard/ModelInput.js";
import { GoalPicker } from "./dashboard/GoalPicker.js";
import "./dashboard/dashboard.css";
import {
  CHAIN,
  CHAIN_ID,
  ORCHESTRATOR_URL,
  explorer,
  fetchOrchestratorConfig,
  formatUsdc,
  type OrchestratorConfig,
} from "./lib/config.js";
import { streamRun, type PaymentEvent, type RunResult } from "./lib/run.js";

/**
 * Budget bounds, and why they are these numbers.
 *
 * The floor is the smallest budget that still lets both honest calls settle
 * (0.01 + 0.12) with headroom left over, so a viewer always gets to watch two
 * real debits before anything is refused.
 *
 * The ceiling exists so `premium-feed` stays hostile. Its 5.00 ask is fixed, so
 * a budget above that would make the injection call *affordable* — the agent
 * would be deceived, comply, and the payment would go through. Capping the
 * budget below 5.00 keeps that case a refusal no matter what is chosen.
 */
const MIN_BUDGET = 300_000n; // 0.30 USDC
const MAX_BUDGET = 4_000_000n; // 4.00 USDC — below the 5.00 injection ask
const DEFAULT_BUDGET = MIN_BUDGET;

/** Funded above the budget on purpose, so Inco binds before the balance does. */
const FUNDING_HEADROOM = 100_000n; // 0.10 USDC

/**
 * Public, and deliberately above every price in the catalog — including the
 * 5.00 injection ask and the largest possible overcharge (MAX_BUDGET + 0.05).
 * A hostile call must fail the *confidential* check, never this one.
 */
const PER_CALL_CAP = 6_000_000n; // 6.00 USDC
const CALLS_REMAINING = 5;

/** How far over the chosen budget the overcharge vendor asks. */
const OVERCHARGE_MARGIN = 50_000n; // 0.05 USDC

/**
 * What a vendor asks for this run.
 *
 * Fixed for three of the four. The overcharge vendor is the exception: its
 * entire purpose is to sit *just* above the confidential budget while staying
 * far below the public cap, and the budget is now chosen by the viewer — so a
 * hardcoded 0.35 would simply be affordable at any budget above it, and the
 * case it exists to demonstrate would silently stop demonstrating anything.
 *
 * Returns undefined when the catalog price already stands, so the request
 * carries no override and the vendor's own number is used.
 */
function priceFor(goal: DemoGoal, budget: bigint): string | undefined {
  if (goal.tactic !== "overcharge") return undefined;
  return (budget + OVERCHARGE_MARGIN).toString();
}

/** Decimal USDC to atomic units. Undefined for anything unparseable. */
function parseUsdc(text: string): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return undefined;
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}

const clampBudget = (value: bigint) =>
  value < MIN_BUDGET ? MIN_BUDGET : value > MAX_BUDGET ? MAX_BUDGET : value;

/** Opened on first render so the console is never in a no-resource state. */
const DEFAULT_GOAL = DEMO_GOALS[0] as DemoGoal;

export default function App() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: wallet } = useWalletClient();

  const [config, setConfig] = useState<OrchestratorConfig>();
  const [configError, setConfigError] = useState<string>();
  const [payer, setPayer] = useState<Address>();
  const [goalId, setGoalId] = useState<string>();
  const [resumeId, setResumeId] = useState("");
  const [budgetHandle, setBudgetHandle] = useState<Hex>();
  /** False for a goal resumed by id: its budget was chosen in another session. */
  const [openedHere, setOpenedHere] = useState(false);
  const [funded, setFunded] = useState(false);
  const [resource, setResource] = useState<DemoGoal>(DEFAULT_GOAL);
  /** Chosen before the goal is opened; immutable afterwards, like the goal. */
  const [budget, setBudget] = useState<bigint>(DEFAULT_BUDGET);
  const [budgetDraft, setBudgetDraft] = useState("0.30");
  /**
   * Cumulative across every run in this session, not per run.
   *
   * `events` is cleared at the start of each run, so deriving spend from it
   * showed only the latest call and the ring sprang back to full after a second
   * purchase — reporting money as unspent that had genuinely left the payer.
   */
  const [sessionSpent, setSessionSpent] = useState(0n);
  const [approvedCalls, setApprovedCalls] = useState(0);
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [result, setResult] = useState<RunResult>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  /** Undefined until read. Checked so the UI never offers a transaction that must revert. */
  const [usdcBalance, setUsdcBalance] = useState<bigint>();
  /*
   * Which dialog is up, or none.
   *
   * A single slot rather than four booleans: only one native modal can hold
   * the focus trap at a time, and encoding that in the type removes the state
   * where two are open and fighting over it.
   */
  const [modal, setModal] = useState<"setup" | "goal" | "guarantees" | "evidence" | null>(null);
  /**
   * The goal is closed, so no further run is possible.
   *
   * Tracked separately from `goalId` because the goal record stays readable
   * after closure — the trace, the evidence and the balance all still resolve.
   * What changes is that the vault will refuse a new spend, and the console
   * should say so before someone presses a button that must revert.
   */
  const [closed, setClosed] = useState(false);
  /** What came back, once it has. */
  const [returned, setReturned] = useState<{ amount: string; tx: string | undefined }>();

  useEffect(() => {
    fetchOrchestratorConfig().then(setConfig, (e: unknown) =>
      setConfigError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  // Read the connected account's USDC. Without this the UI happily offers a
  // transfer the account cannot cover, and the user's first sign of trouble is
  // MetaMask's "likely to fail" — which reads as a broken demo rather than a
  // missing faucet trip.
  useEffect(() => {
    if (!config || !address) {
      setUsdcBalance(undefined);
      return;
    }
    let cancelled = false;
    void reader
      .readContract({
        address: config.usdcAddress,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      })
      .then((balance) => {
        if (!cancelled) setUsdcBalance(balance);
      })
      .catch(() => {
        if (!cancelled) setUsdcBalance(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [config, address, funded]);

  const wrongChain = isConnected && chainId !== CHAIN_ID;
  const funding = budget + FUNDING_HEADROOM;
  const underfunded = usdcBalance !== undefined && usdcBalance < funding;
  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setError(undefined);
      setBusy(label);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(undefined);
      }
    },
    [],
  );

  // --- step 2: mint the payer ---------------------------------------------
  // Before openGoal, because the payer address is a field of the goal record.
  const mintPayer = () =>
    guard("Minting payer key…", async () => {
      if (!config) throw new Error("orchestrator config not loaded");
      const response = await fetch(`${config.signerUrl}/payer`, { method: "POST" });
      if (!response.ok) throw new Error(`signer /payer returned ${response.status}`);
      const body = (await response.json()) as { address: Address };
      setPayer(body.address);
    });

  // --- step 3: encrypt, then open ------------------------------------------
  const openGoal = () =>
    guard("Encrypting budget and opening the goal…", async () => {
      if (!config || !wallet || !address || !payer) throw new Error("not ready");

      // Re-read the chain rather than trusting connection-time state: MetaMask
      // caches a stale chainId after a manual network change (IMPLEMENTATION.md §5.2).
      const live = await wallet.getChainId();
      if (live !== CHAIN_ID) throw new Error(`Wallet is on chain ${live}, expected ${CHAIN_ID}`);

      const zap = await Lightning.baseSepoliaTestnet();
      // Bound to (this address, this vault). A ciphertext prepared for anyone
      // else yields a handle openGoal cannot use — which is why the user, not
      // the orchestrator, has to send this transaction.
      const budgetCiphertext = (await zap.encrypt(budget, {
        accountAddress: address,
        dappAddress: config.vaultAddress,
        handleType: handleTypes.euint256,
      })) as Hex;

      // Converting a client ciphertext into a handle is the one operation here
      // that charges the Inco fee, which is why `openGoal` is payable.
      const fee = await readIncoFee();

      const hash = await wallet.writeContract({
        address: config.vaultAddress,
        abi: policyVaultAbi,
        functionName: "openGoal",
        args: [
          {
            budgetCiphertext,
            perCallCap: PER_CALL_CAP,
            callsRemaining: CALLS_REMAINING,
            payer,
            relay: config.relayAddress,
            asset: config.usdcAddress,
            expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
            // Every vendor in the catalog is allowlisted on purpose: the
            // hostile ones must fail the *confidential* check, not a public
            // precondition. An unallowlisted payee would revert in `require`,
            // which proves nothing about Inco.
            allowlist: [...DEMO_PAYEES],
          },
        ],
        chain: CHAIN,
        account: address,
        value: fee,
      });

      const receipt = await waitForReceipt(hash);
      const opened = parseEventLogs({
        abi: policyVaultAbi,
        eventName: "GoalOpened",
        logs: receipt.logs,
      })[0];
      if (!opened) throw new Error("GoalOpened was not emitted");
      const args = opened.args as unknown as { goalId: bigint; budgetHandle: Hex };
      setGoalId(args.goalId.toString());
      setBudgetHandle(args.budgetHandle);
      setOpenedHere(true);
    });

  // --- step 4: fund the payer ----------------------------------------------
  const fundPayer = () =>
    guard("Funding the ephemeral payer…", async () => {
      if (!config || !wallet || !address || !payer) throw new Error("not ready");
      const hash = await wallet.writeContract({
        address: config.usdcAddress,
        abi: usdcAbi,
        functionName: "transfer",
        args: [payer, funding],
        chain: CHAIN,
        account: address,
      });
      await waitForReceipt(hash);
      setFunded(true);
    });

  // --- step 6: take the remaining balance back ------------------------------
  /**
   * Closes the goal, then returns whatever the ephemeral payer still holds.
   *
   * Two steps in one action on purpose. The signer refuses to sweep an open
   * goal — a sweep and a spend draw on the same balance, so emptying the payer
   * while a spend can still be approved would turn an approved payment into a
   * failed transfer. Closing first is therefore a precondition, not a courtesy,
   * and making the user perform it as a separate step would only invite them to
   * do the second half and wonder why it was refused.
   *
   * `closeGoal` is the user's own signature because only the goal owner may
   * close a goal. The sweep itself needs no signature from them at all: the
   * payer key lives in the signer, and the destination is read from the goal
   * record rather than supplied here — this component could not redirect the
   * money if it tried.
   *
   * Idempotent enough to retry: closing an already-closed goal is skipped, and
   * the sweep authorization is deterministic in `(goalId, amount)`, so a retry
   * after a dropped response reproduces the same authorization rather than a
   * second one that could also execute.
   */
  const returnFunds = () =>
    guard("Closing the goal and returning the balance…", async () => {
      if (!config || !wallet || !address || !goalId) throw new Error("not ready");

      // Same reasoning as openGoal: MetaMask caches a stale chainId.
      const live = await wallet.getChainId();
      if (live !== CHAIN_ID) throw new Error(`Wallet is on chain ${live}, expected ${CHAIN_ID}`);

      const goal = (await reader.readContract({
        address: config.vaultAddress,
        abi: policyVaultAbi,
        functionName: "goals",
        args: [BigInt(goalId)],
      })) as readonly [Address, Address, Address, Address, number, bigint, bigint, boolean];

      const isOpen = goal[7];
      if (isOpen) {
        const hash = await wallet.writeContract({
          address: config.vaultAddress,
          abi: policyVaultAbi,
          functionName: "closeGoal",
          args: [BigInt(goalId)],
          chain: CHAIN,
          account: address,
        });
        await waitForReceipt(hash);
      }
      setClosed(true);

      const response = await fetch(`${ORCHESTRATOR_URL}/sweeps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId }),
      });
      const body = (await response.json()) as {
        amount?: string;
        settlement?: { transaction?: string };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `orchestrator /sweeps returned ${response.status}`);
      }
      setReturned({ amount: body.amount ?? "0", tx: body.settlement?.transaction });
    });

  // --- step 5: hand off ------------------------------------------------------
  // Takes the resource explicitly, defaulting to state. Selecting from the
  // picker and running in one gesture would otherwise read the *previous*
  // selection — state updates are not visible to the closure that scheduled
  // them, so "buy this one" would quietly buy the last one.
  const run = (which: DemoGoal = resource) =>
    guard(`Running ${which.label}…`, async () => {
      if (!goalId) throw new Error("no goal");
      setEvents([]);
      setResult(undefined);

      // Also collected locally: `events` is state, so it is not readable at its
      // final value inside this closure, and the accounting below needs the
      // whole run rather than whatever React has committed so far.
      const collected: PaymentEvent[] = [];

      for await (const event of streamRun(goalId, which.key, priceFor(which, budget))) {
        if (event.channel === "payment") {
          collected.push(event.data);
          setEvents((prior) => [...prior, event.data]);
        } else if (event.channel === "result") setResult(event.data);
        else if (event.channel === "error") setError(event.data.message);
      }

      // Accumulate once, at the end. Only a real settlement counts — a stubbed
      // one validated a payload and moved nothing.
      const settled = collected.find((e) => e.type === "settled");
      const signed = collected.find((e) => e.type === "signed");
      if (
        settled?.type === "settled" &&
        !settled.settlement.simulated &&
        signed?.type === "signed"
      ) {
        setSessionSpent((total) => total + BigInt(signed.value));
      }
      if (collected.some((e) => e.type === "decision-finalized" && e.approved)) {
        setApprovedCalls((n) => n + 1);
      }
    });

  // --- presentational derivations -------------------------------------------
  // Read-only projections of the event stream. No chain reads, no new state
  // beyond what the run already produces.

  const running = busy !== undefined && busy.startsWith("Running");
  const started = events.length > 0;

  /**
   * What the selected resource will actually be billed, not what the catalog
   * lists. `priceFor` overrides the overcharge tactic to `budget + 0.05` —
   * deliberately always just past whatever budget is chosen — so a display
   * still showing the catalog's static price would tell a viewer the request
   * is affordable right up until the encrypted budget disagrees. That gap is
   * exactly what confused a viewer who set 0.40 and expected a listed 0.35 to
   * clear; the real request was 0.45.
   */
  const requestedPrice = BigInt(priceFor(resource, budget) ?? resource.priceAtomic);

  /**
   * The five acts, and where the viewer is in them.
   *
   * Rendered as the rail under the status bar. Keeping it as one derivation
   * means the rail and the per-control hints below can never disagree about
   * what is blocked — they read the same source.
   */
  const steps = useMemo(
    () =>
      [
        { key: "connect", label: "Connect", state: isConnected && !wrongChain ? "done" : "ready" },
        {
          key: "payer",
          label: "Mint payer",
          state: payer ? "done" : isConnected && !wrongChain ? "ready" : "blocked",
        },
        { key: "goal", label: "Open goal", state: goalId ? "done" : payer ? "ready" : "blocked" },
        { key: "fund", label: "Fund", state: funded ? "done" : goalId ? "ready" : "blocked" },
        { key: "run", label: "Run", state: started ? "done" : goalId ? "ready" : "blocked" },
      ] as const,
    [isConnected, wrongChain, payer, goalId, funded, started],
  );

  /** Public, and the honest basis for the ring: what actually left the payer. */
  const spent = sessionSpent;

  /*
   * Clears the run view only.
   *
   * `sessionSpent` and `approvedCalls` survive deliberately: they describe money
   * that actually moved and calls the vault actually counted. Zeroing them on a
   * button labelled "reset" would make the console disagree with the chain.
   */
  const resetDemo = () => {
    setEvents([]);
    setResult(undefined);
    setError(undefined);
  };

  const closeModal = () => setModal(null);
  const evidence = evidenceCount(events);

  return (
    <div className="dash">
      {/* ============================================================ TOPBAR
          Status, progress and every dialog trigger, in one strip. The rail
          moved up here from its own row: it is five words of state, and it
          was costing the frame below it a whole band of height. */}
      <header className="d-top">
        <span className="d-top-brand">LedgerLighthouse</span>

        <span className="d-top-live">
          <Dot tone={isConnected && !wrongChain ? "live" : "idle"} />
          {isConnected && !wrongChain ? "Live" : "Idle"}
        </span>

        <ol className="d-rail" aria-label="Demo progress">
          {steps.map((step) => (
            <li key={step.key} className="d-rail-step" data-state={step.state}>
              <span className="d-rail-label">{step.label}</span>
              {/* The bar carries the state: filled when done, sweeping while
                  this is the step you can act on, empty when still blocked.
                  Decorative — `.d-sr` below is what assistive tech reads. */}
              <span className="d-rail-bar" aria-hidden="true">
                <i />
              </span>
              <span className="d-sr">{step.state}</span>
            </li>
          ))}
        </ol>

        <span className="d-top-meta">
          <span className="d-top-item">
            <i>Wallet</i>
            {address ? truncate(address, 6, 4) : "—"}
          </span>
          <span className="d-top-item">
            <i>Network</i>
            {wrongChain ? `chain ${chainId}` : "Base Sepolia"}
          </span>
          {config ? (
            <span className="d-top-item">
              <i>Vault</i>
              <Copyable
                value={config.vaultAddress}
                display={truncate(config.vaultAddress, 6, 4)}
                href={explorer.address(config.vaultAddress)}
              />
            </span>
          ) : null}
        </span>

        <span className="d-top-actions">
          <button type="button" className="d-btn d-btn-ghost" onClick={() => setModal("guarantees")}>
            Guarantees
          </button>
          <button
            type="button"
            className="d-btn d-btn-ghost"
            onClick={() => setModal("evidence")}
            disabled={evidence === 0}
          >
            Evidence{evidence > 0 ? ` · ${evidence}` : ""}
          </button>
          {isConnected ? (
            <button type="button" className="d-btn d-btn-ghost" onClick={() => disconnect()}>
              Disconnect
            </button>
          ) : null}
        </span>
      </header>

      {/* ============================================================= FRAME
          Exactly one viewport tall, and it never scrolls. Each pane owns its
          own overflow, so a long timeline scrolls inside its column instead
          of pushing the goal state or the controls off screen. */}
      <div className="d-frame">
        {/* -------------------------------------------------- goal & payer */}
        <section className="d-pane">
          <header className="d-pane-head">
            <h2>Goal &amp; payer</h2>
            {goalId ? (
              <button type="button" className="d-link" onClick={() => setModal("goal")}>
                Details
              </button>
            ) : null}
          </header>

          <div className="d-pane-body">
            {goalId ? (
              <>
                <Ring
                  spent={spent}
                  funded={funding}
                  caption="Share of the funded payer balance already spent"
                />
                <p className="d-caption d-centre">
                  Of the funded payer balance. The encrypted budget itself is not readable — by
                  anyone, including this page.
                </p>

                <Field label="Goal">#{goalId}</Field>
                <Field label="Remaining budget">
                  <span className="d-cipher">encrypted · </span>
                  {budgetHandle ? (
                    <Copyable value={budgetHandle} display={truncate(budgetHandle, 8, 6)} />
                  ) : (
                    <span className="d-muted">unavailable on a resumed goal</span>
                  )}
                </Field>
                <Field label="Payer">
                  {payer ? (
                    <Copyable
                      value={payer}
                      display={truncate(payer, 8, 6)}
                      href={explorer.address(payer)}
                    />
                  ) : (
                    <span className="d-muted">not minted</span>
                  )}
                </Field>
                <Field label="Spent this session">{formatUsdc(spent)} USDC</Field>

                {/*
                  The way out. Placed here rather than in the goal dialog
                  because it is about the balance shown directly above it, and
                  because "how do I get my money back" should not require
                  finding a dialog first.
                */}
                {returned ? (
                  <div className="d-returned">
                    <span className="d-label">Returned to your wallet</span>
                    <strong>{formatUsdc(BigInt(returned.amount))} USDC</strong>
                    {returned.tx ? (
                      <Copyable
                        value={returned.tx}
                        display={truncate(returned.tx, 8, 6)}
                        href={explorer.tx(returned.tx)}
                      />
                    ) : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="d-btn d-btn-ghost d-btn-block"
                    disabled={!!busy || !isConnected || wrongChain}
                    onClick={returnFunds}
                  >
                    {closed ? "Return remaining funds" : "Close goal · return funds"}
                  </button>
                )}

                {!funded ? (
                  underfunded ? (
                    <div className="d-notice">
                      No test USDC — this account holds {formatUsdc(usdcBalance ?? 0n)}. Get some
                      from the{" "}
                      <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                        Circle faucet
                      </a>
                      . The malicious run works without it.
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="d-btn d-btn-block"
                      disabled={!!busy}
                      onClick={fundPayer}
                    >
                      Fund {formatUsdc(funding)} USDC
                    </button>
                  )
                ) : null}
              </>
            ) : (
              /* No goal yet. Everything it takes to open one is a dialog away
                 rather than inline: it is four controls used once, and it
                 would otherwise be the largest thing in the frame for the
                 entire rest of the session. */
              <div className="d-empty">
                <p className="d-empty-lead">No goal open.</p>
                <p className="d-caption">
                  A run spends against an encrypted budget. Open one to begin — it costs one wallet
                  signature.
                </p>
                <button
                  type="button"
                  className="d-btn d-btn-block"
                  onClick={() => setModal("setup")}
                >
                  Set up a goal
                </button>
              </div>
            )}

            {configError ? (
              <div className="d-notice" data-tone="error">
                <strong>No orchestrator on {ORCHESTRATOR_URL}.</strong>
                <p>
                  The web dev server does not start the backing services. Run{" "}
                  <code>pnpm dev</code> from the repo root — it brings up the signer, mock API and
                  orchestrator alongside this page.
                </p>
                <p className="d-notice-detail">{configError}</p>
              </div>
            ) : null}
          </div>
        </section>

        {/* ------------------------------------------------ live execution */}
        <section className="d-pane d-pane-main">
          <header className="d-pane-head">
            <h2>Live execution</h2>
            {running ? (
              <span className="d-running">
                <span className="t-eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                running
              </span>
            ) : null}
          </header>

          <div className="d-pane-body">
            <div className="d-launch">
              <GoalPicker
                selected={resource}
                disabled={!!busy}
                onSelect={(goal) => {
                  setResource(goal);
                  resetDemo();
                }}
              />
              <p className="d-expectation" data-kind={resource.kind}>
                {resource.expectation}
              </p>
              <div className="d-controls">
                <button
                  type="button"
                  className="d-btn"
                  disabled={!goalId || closed || !!busy}
                  onClick={() => run(resource)}
                >
                  Buy {resource.label} · {formatUsdc(requestedPrice)} USDC
                </button>
                <button
                  type="button"
                  className="d-btn d-btn-ghost"
                  disabled={!started || !!busy}
                  onClick={resetDemo}
                >
                  Reset
                </button>
              </div>
              {!goalId ? (
                <p className="d-hint">Open a goal first — a run spends against its budget.</p>
              ) : null}

              {closed ? (
                <p className="d-hint">
                  Goal closed. The vault will refuse any further spend against it.
                </p>
              ) : null}

              {/*
                An honest resource is meant to settle, and settling needs USDC
                in the payer. Without it the run still costs a real debit
                against the confidential budget and roughly twenty seconds,
                then fails at the last stage — which reads as a broken demo
                rather than as an empty wallet.

                A hint, not a block: `funded` only records what *this session*
                did, so a goal resumed by id may well be funded already and
                this must not refuse to run it. The wording says what is known
                rather than asserting the payer is empty. Malicious resources
                are exempt because the policy refuses them long before
                settlement — funding changes nothing there, and the copy in
                the goal pane already says so.
              */}
              {goalId && !funded && resource.kind !== "malicious" ? (
                <p className="d-hint" data-tone="warn">
                  Payer not funded in this session — settlement may be refused at the last stage.
                </p>
              ) : null}
              {busy ? <p className="d-caption">{busy}</p> : null}
              {error ? (
                <p className="d-notice" data-tone="error">
                  {error}
                </p>
              ) : null}
            </div>

            <Outcome result={result} events={events} />

            {/* Rendered from the first paint, not on the first event. The
                stages are a fixed list precisely so the shape of the flow is
                legible before anything has happened. */}
            <Timeline events={events} running={running} />

            {!started ? (
              <p className="d-tl-legend">
                Nine stages, fixed. Run a request and watch them resolve — or run the malicious one
                and watch it stop at the confidential evaluation.
              </p>
            ) : null}
          </div>
        </section>

        {/* -------------------------------------------- what the model read */}
        <section className="d-pane">
          <header className="d-pane-head">
            <h2>Model input</h2>
          </header>
          <div className="d-pane-body">
            {started ? (
              <ModelInput events={events} running={running} />
            ) : (
              <p className="d-caption">
                The vendor&apos;s own words land here once a run starts — including the ones written
                to talk the agent into paying.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* =========================================================== DIALOGS */}

      <Modal
        open={modal === "setup"}
        onClose={closeModal}
        title="Set up a goal"
        tag="Connect · mint · encrypt · fund"
      >
        <div className="d-setup">
          {!isConnected ? (
            connectors.map((connector) => (
              <button
                key={connector.uid}
                type="button"
                className="d-btn d-btn-block"
                onClick={() => connect({ connector })}
              >
                Connect {connector.name}
              </button>
            ))
          ) : wrongChain ? (
            <>
              <p className="d-notice">This demo writes only to Base Sepolia.</p>
              <button
                type="button"
                className="d-btn d-btn-block"
                onClick={() => switchChain({ chainId: CHAIN_ID })}
              >
                Switch network
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="d-btn d-btn-block"
                data-kind={payer ? "outline" : undefined}
                disabled={!!payer || !!busy}
                onClick={mintPayer}
              >
                {payer ? "Payer minted" : "Mint ephemeral payer"}
              </button>

              {/* Chosen here, encrypted in the next step, and immutable
                  afterwards. Shown before `openGoal` because that is the only
                  moment it can be set — the whole point is that nothing
                  downstream, including this page, can change it. */}
              <div className="d-budget">
                <label className="d-label" htmlFor="budget">
                  Confidential budget
                </label>
                <div className="d-inline">
                  <input
                    id="budget"
                    className="d-input"
                    inputMode="decimal"
                    value={budgetDraft}
                    disabled={!!busy}
                    onChange={(e) => {
                      const text = e.target.value.replace(/[^0-9.]/g, "");
                      setBudgetDraft(text);
                      const parsed = parseUsdc(text);
                      if (parsed !== undefined) setBudget(clampBudget(parsed));
                    }}
                    onBlur={() => {
                      // Normalise on blur rather than per keystroke, so
                      // clearing the field to retype does not fight back.
                      const parsed = parseUsdc(budgetDraft);
                      const next = clampBudget(parsed ?? DEFAULT_BUDGET);
                      setBudget(next);
                      setBudgetDraft(formatUsdc(next));
                    }}
                  />
                  <span className="d-budget-unit">USDC</span>
                </div>
                <p className="d-caption">
                  Minimum {formatUsdc(MIN_BUDGET)}, maximum {formatUsdc(MAX_BUDGET)}. You will fund
                  the payer with {formatUsdc(funding)} — a little above the budget, so the
                  confidential check binds before the balance does.
                </p>
              </div>

              <button
                type="button"
                className="d-btn d-btn-block"
                disabled={!payer || !!busy}
                onClick={() => {
                  void openGoal();
                  closeModal();
                }}
              >
                Encrypt {formatUsdc(budget)} USDC and open goal
              </button>
              {!payer ? (
                <p className="d-hint">
                  Mint the payer first — its address is a field of the goal record.
                </p>
              ) : null}
            </>
          )}

          {/* Outside the connection branch on purpose. Opening a goal costs a
              transaction and a wallet prompt, so a reload mid-demo should not
              force another — and the run itself is driven server-side, so an
              already-open goal can be exercised with no wallet at all. */}
          <div className="d-advanced">
            <span className="d-label">Already have a goal?</span>
            <div className="d-inline">
              <input
                className="d-input"
                id="resume"
                inputMode="numeric"
                placeholder="goal id"
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && resumeId) {
                    setGoalId(resumeId);
                    closeModal();
                  }
                }}
              />
              <button
                type="button"
                className="d-btn d-btn-ghost"
                disabled={resumeId === ""}
                onClick={() => {
                  setGoalId(resumeId);
                  closeModal();
                }}
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={modal === "goal"}
        onClose={closeModal}
        title="Goal detail"
        tag={goalId ? `Goal #${goalId}` : undefined}
      >
        {/* TODO(needs backend): the vault exposes no goal title, and the live
            `callsRemaining` / `expiry` would each need a `goals()` read that
            does not exist in this component. Shown values are the ones this
            session actually set. */}
        <Field label="Opened with">
          {openedHere ? (
            `${formatUsdc(budget)} USDC`
          ) : (
            // A resumed goal was opened elsewhere; this session never saw its
            // budget and must not imply otherwise.
            <span className="d-muted">set in another session</span>
          )}
        </Field>
        <Field label="Per-call cap">{formatUsdc(PER_CALL_CAP)} USDC · public</Field>
        <Field label="Calls remaining">
          {Math.max(0, CALLS_REMAINING - approvedCalls)} of {CALLS_REMAINING}
        </Field>
        <Field label="Expiry">7 days from opening</Field>
        <Field label="Last funded">
          {funded ? `${formatUsdc(funding)} USDC` : <span className="d-muted">—</span>}
        </Field>
        <p className="d-caption">
          The funded payer balance is the maximum autonomous spend. The encrypted budget bounds it
          further, and nobody — including this page — can read that number.
        </p>
        <p className="d-caption">
          Returning the balance closes the goal first, because a sweep and a spend draw on the same
          money. The destination is the goal owner recorded on chain — this page cannot redirect it,
          and the signer has no field in which to be told a different one.
        </p>
      </Modal>

      <Modal
        open={modal === "guarantees"}
        onClose={closeModal}
        title="Guarantees"
        tag="What holds regardless of the agent"
      >
        <GuaranteeList />
      </Modal>

      <Modal
        open={modal === "evidence"}
        onClose={closeModal}
        title="Evidence"
        tag="Checkable without trusting this page"
        wide
      >
        <EvidenceBody events={events} goalId={goalId} />
      </Modal>
    </div>
  );
}

// --- small chain helpers, kept out of the component body --------------------

/** Baked into @inco/lightning's Lib.sol. Same address on Base and Base Sepolia. */
const INCO_SINGLETON: Address = "0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624";

const INCO_FEE_ABI = [
  {
    type: "function",
    name: "getFee",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** Reads go through a public transport; only writes need the wallet. */
const reader = createPublicClient({ chain: CHAIN, transport: http() });

function readIncoFee(): Promise<bigint> {
  return reader.readContract({
    address: INCO_SINGLETON,
    abi: INCO_FEE_ABI,
    functionName: "getFee",
  });
}

function waitForReceipt(hash: Hex) {
  return reader.waitForTransactionReceipt({ hash });
}

