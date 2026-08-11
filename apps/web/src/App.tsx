/**
 * The demo, as a page.
 *
 * MetaMask signs exactly three things: `openGoal`, the USDC funding transfer,
 * and (optionally) goal closure. It signs **nothing inside the payment loop** —
 * that is what the ephemeral payer key is for, and what `e.reveal` makes
 * possible (plan §11.1). If a wallet prompt ever appears while a run is in
 * flight, the design has drifted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain, useWalletClient } from "wagmi";
import { createPublicClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes } from "@inco/lightning-js";
import { policyVaultAbi, usdcAbi } from "@ntux402/shared";

import { Card, Copyable, Dot, Field, Ring, truncate } from "./dashboard/primitives.js";
import { Timeline } from "./dashboard/Timeline.js";
import { Comparison, EvidenceDrawer, Guarantees, Outcome } from "./dashboard/panels.js";
import { TotemMark } from "./brand/Totem.js";
import "./dashboard/dashboard.css";
import {
  CHAIN,
  CHAIN_ID,
  explorer,
  fetchOrchestratorConfig,
  formatUsdc,
  type OrchestratorConfig,
} from "./lib/config.js";
import { streamRun, type PaymentEvent, type RunResult } from "./lib/run.js";

/** The encrypted budget, and a cap set deliberately above the malicious price. */
const BUDGET = 200_000n; // 0.20 USDC — confidential
const PER_CALL_CAP = 6_000_000n; // 6.00 USDC — public, above the 5.00 malicious ask
const CALLS_REMAINING = 5;
const PAYER_FUNDING = 300_000n; // 0.30 USDC — above the budget, on purpose

const HONEST_PAY_TO: Address = "0x1111111111111111111111111111111111111111";
const MALICIOUS_PAY_TO: Address = "0x2222222222222222222222222222222222222222";

type Mode = "honest" | "malicious";

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
  const [funded, setFunded] = useState(false);
  const [mode, setMode] = useState<Mode>("honest");
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [result, setResult] = useState<RunResult>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  /** Undefined until read. Checked so the UI never offers a transaction that must revert. */
  const [usdcBalance, setUsdcBalance] = useState<bigint>();

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
  const underfunded = usdcBalance !== undefined && usdcBalance < PAYER_FUNDING;
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
      // caches a stale chainId after a manual network change (brief §5.5).
      const live = await wallet.getChainId();
      if (live !== CHAIN_ID) throw new Error(`Wallet is on chain ${live}, expected ${CHAIN_ID}`);

      const zap = await Lightning.baseSepoliaTestnet();
      // Bound to (this address, this vault). A ciphertext prepared for anyone
      // else yields a handle openGoal cannot use — which is why the user, not
      // the orchestrator, has to send this transaction.
      const budgetCiphertext = (await zap.encrypt(BUDGET, {
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
            // Both vendors allowlisted on purpose: the malicious one must fail
            // the *confidential* check, not a public precondition.
            allowlist: [HONEST_PAY_TO, MALICIOUS_PAY_TO],
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
    });

  // --- step 4: fund the payer ----------------------------------------------
  const fundPayer = () =>
    guard("Funding the ephemeral payer…", async () => {
      if (!config || !wallet || !address || !payer) throw new Error("not ready");
      const hash = await wallet.writeContract({
        address: config.usdcAddress,
        abi: usdcAbi,
        functionName: "transfer",
        args: [payer, PAYER_FUNDING],
        chain: CHAIN,
        account: address,
      });
      await waitForReceipt(hash);
      setFunded(true);
    });

  // --- step 5: hand off ------------------------------------------------------
  // Takes the mode explicitly, defaulting to state. The dashboard has one
  // button per mode, and `setMode(x); run()` would read the *previous* mode —
  // state updates are not visible to the closure that scheduled them, so
  // "Run malicious" would quietly run the honest request.
  const run = (which: Mode = mode) =>
    guard(`Running the ${which} request…`, async () => {
      if (!goalId) throw new Error("no goal");
      setEvents([]);
      setResult(undefined);
      for await (const event of streamRun(goalId, which)) {
        if (event.channel === "payment") setEvents((prior) => [...prior, event.data]);
        else if (event.channel === "result") setResult(event.data);
        else if (event.channel === "error") setError(event.data.message);
      }
    });

  // --- presentational derivations -------------------------------------------
  // Read-only projections of the event stream. No chain reads, no new state
  // beyond what the run already produces.

  const running = busy !== undefined && busy.startsWith("Running");
  const started = events.length > 0;

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
  const spent = useMemo(
    () =>
      events.reduce((total, event) => {
        if (event.type !== "settled") return total;
        if (event.settlement.simulated) return total;
        const signed = events.find((e) => e.type === "signed");
        return signed && signed.type === "signed" ? total + BigInt(signed.value) : total;
      }, 0n),
    [events],
  );

  const finalizedEvent = events.find((e) => e.type === "decision-finalized");
  const approvedThisRun =
    finalizedEvent && finalizedEvent.type === "decision-finalized"
      ? finalizedEvent.approved
      : undefined;

  const resetDemo = () => {
    setEvents([]);
    setResult(undefined);
    setError(undefined);
  };

  return (
    <div className="dash">
      {/* 1 — STATUS BAR */}
      <header className="d-topbar">
        <span className="d-brand">
          <TotemMark size={16} spinning={running} />
          <span className="d-brand-name">Totem</span>
        </span>

        <span className="d-topbar-group">
          <Dot tone={isConnected && !wrongChain ? "live" : "idle"} />
          <strong>{isConnected && !wrongChain ? "LIVE" : "IDLE"}</strong>
        </span>

        <span className="d-topbar-group">
          Wallet <strong>{address ? truncate(address, 6, 4) : "not connected"}</strong>
        </span>

        <span className="d-topbar-group">
          Network <strong>{wrongChain ? `chain ${chainId}` : "Base Sepolia"}</strong>
        </span>

        {config ? (
          <span className="d-topbar-group">
            Vault{" "}
            <Copyable
              value={config.vaultAddress}
              display={truncate(config.vaultAddress, 6, 4)}
              href={explorer.address(config.vaultAddress)}
            />
          </span>
        ) : null}

        <span className="d-topbar-group d-spacer">
          Settlement <strong>{config?.settlement ?? "…"}</strong>
        </span>

        {isConnected ? (
          <button type="button" className="d-btn" data-kind="ghost" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : null}
      </header>

      {/* 2 — PROGRESS RAIL. The whole sequence, visible before it is walked. */}
      <ol className="d-rail" aria-label="Demo progress">
        {steps.map((step, i) => (
          <li key={step.key} className="d-rail-step" data-state={step.state}>
            {i > 0 ? <span className="d-rail-link" aria-hidden="true" /> : null}
            <span className="d-rail-num" aria-hidden="true">
              {step.state === "done" ? "✓" : i + 1}
            </span>
            <span className="d-rail-label">{step.label}</span>
            <span className="d-sr">{step.state}</span>
          </li>
        ))}
      </ol>

      {configError ? (
        <div className="d-notice" data-tone="error" style={{ margin: "0 1rem 1rem" }}>
          Cannot reach the orchestrator: {configError}
        </div>
      ) : null}

      <main className="d-main">
        {/* ============================ COLUMN 1 — GOAL & AUTHORITY */}
        <div className="d-col">
          <Card title="Goal &amp; authority">
            {/* TODO(needs backend): the vault exposes no goal title, and the live
                `callsRemaining` / `expiry` would each need a `goals()` read that
                does not exist in this component. Shown values are the ones this
                session actually set. */}
            {goalId ? (
              <>
                <Ring
                  spent={spent}
                  funded={PAYER_FUNDING}
                  caption="Share of the funded payer balance already spent"
                />
                <p className="d-caption" style={{ textAlign: "center", marginTop: 0 }}>
                  Of the funded payer balance. The encrypted budget itself is not readable —
                  by anyone, including this page.
                </p>

                <Field label="Goal">#{goalId}</Field>
                <Field label="Remaining budget">
                  <span className="d-cipher">encrypted · </span>
                  {budgetHandle ? (
                    <Copyable value={budgetHandle} display={truncate(budgetHandle, 10, 6)} />
                  ) : (
                    <span className="d-muted">handle unavailable on a resumed goal</span>
                  )}
                </Field>
                <Field label="Opened with">{formatUsdc(BUDGET)} USDC</Field>
                <Field label="Per-call cap">{formatUsdc(PER_CALL_CAP)} USDC · public</Field>
                <Field label="Calls remaining">
                  {CALLS_REMAINING - (approvedThisRun === true ? 1 : 0)} of {CALLS_REMAINING}
                </Field>
                <Field label="Expiry">7 days from opening</Field>
              </>
            ) : (
              <div className="d-setup">
                {!isConnected ? (
                  connectors.map((connector) => (
                    <button
                      key={connector.uid}
                      type="button"
                      className="d-btn"
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
                      className="d-btn"
                      onClick={() => switchChain({ chainId: CHAIN_ID })}
                    >
                      Switch network
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="d-btn"
                      data-kind={payer ? "outline" : undefined}
                      disabled={!!payer || !!busy}
                      onClick={mintPayer}
                    >
                      {payer ? "Payer minted" : "Mint ephemeral payer"}
                    </button>
                    <button
                      type="button"
                      className="d-btn"
                      disabled={!payer || !!busy}
                      onClick={openGoal}
                    >
                      Encrypt budget and open goal
                    </button>
                    {!payer ? (
                      <p className="d-hint">
                        Mint the payer first — its address is a field of the goal record.
                      </p>
                    ) : null}
                  </>
                )}

                {/*
                  Outside the connection branch on purpose. Opening a goal costs
                  a transaction and a wallet prompt, so a reload mid-demo should
                  not force another — and the run itself is driven server-side,
                  so an already-open goal can be exercised with no wallet at all.
                */}
                <div className="d-advanced">
                  <span className="d-label">Already have a goal?</span>
                  <div className="d-inline" style={{ marginTop: "0.4rem" }}>
                    <input
                      className="d-input"
                      id="resume"
                      inputMode="numeric"
                      placeholder="goal id"
                      value={resumeId}
                      onChange={(e) => setResumeId(e.target.value.replace(/[^0-9]/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && resumeId) setGoalId(resumeId);
                      }}
                    />
                    <button
                      type="button"
                      className="d-btn"
                      data-kind="ghost"
                      disabled={resumeId === ""}
                      onClick={() => setGoalId(resumeId)}
                    >
                      Resume
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* 3 — EPHEMERAL PAYER */}
          <Card title="Ephemeral payer">
            <Field label="Address">
              {payer ? (
                <Copyable
                  value={payer}
                  display={truncate(payer, 10, 6)}
                  href={explorer.address(payer)}
                />
              ) : (
                <span className="d-muted">not minted</span>
              )}
            </Field>
            {/* TODO(needs backend): a live payer balance needs a `balanceOf`
                read for the payer address; this component only reads the
                connected wallet's. Funded amount and session spend are exact. */}
            <Field label="Last funded">
              {funded ? `${formatUsdc(PAYER_FUNDING)} USDC` : <span className="d-muted">—</span>}
            </Field>
            <Field label="Spent this session">{formatUsdc(spent)} USDC</Field>
            <p className="d-caption">This balance is the maximum autonomous spend.</p>

            {!funded && goalId ? (
              underfunded ? (
                <div className="d-notice" style={{ marginTop: "0.75rem" }}>
                  No test USDC — this account holds {formatUsdc(usdcBalance ?? 0n)}. Get some from
                  the{" "}
                  <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                    Circle faucet
                  </a>
                  . The malicious run works without it.
                </div>
              ) : (
                <button
                  type="button"
                  className="d-btn"
                  data-kind="outline"
                  style={{ marginTop: "0.75rem", width: "100%" }}
                  disabled={!!busy}
                  onClick={fundPayer}
                >
                  Fund {formatUsdc(PAYER_FUNDING)} USDC
                </button>
              )
            ) : null}
          </Card>

          {/* 4 — CONTROLS */}
          <Card title="Execution">
            <div className="d-controls">
              <button
                type="button"
                className="d-btn"
                disabled={!goalId || !!busy}
                onClick={() => {
                  setMode("honest");
                  run("honest");
                }}
              >
                Run honest request
              </button>
              <button
                type="button"
                className="d-btn"
                data-kind="outline"
                disabled={!goalId || !!busy}
                onClick={() => {
                  setMode("malicious");
                  run("malicious");
                }}
              >
                Run malicious request
              </button>
              <button
                type="button"
                className="d-btn"
                data-kind="ghost"
                disabled={!started || !!busy}
                onClick={resetDemo}
              >
                Reset demo
              </button>
            </div>
            {!goalId ? (
              <p className="d-hint">Open a goal first — a run spends against its encrypted budget.</p>
            ) : null}
            {busy ? <p className="d-caption">{busy}</p> : null}
            {error ? (
              <p className="d-notice" data-tone="error" style={{ marginTop: "0.75rem" }}>
                {error}
              </p>
            ) : null}
          </Card>
        </div>

        {/* ============================ COLUMN 2 — LIVE EXECUTION */}
        <div className="d-col">
          <Card
            title="Live execution"
            aside={
              running ? (
                <span className="d-topbar-group">
                  <TotemMark size={13} spinning />
                  running
                </span>
              ) : null
            }
          >
            <Outcome result={result} events={events} />

            {/*
              Rendered from the first paint, not on the first event. The nine
              stages are a fixed list precisely so the shape of the flow is
              legible before anything has happened — an empty state in this slot
              threw that away and told the viewer nothing about what to expect.
            */}
            <Timeline events={events} running={running} />

            {!started ? (
              <p className="d-tl-legend">
                Nine stages, fixed. Run a request and watch them resolve — or run the malicious one
                and watch it stop at the confidential evaluation.
              </p>
            ) : null}
          </Card>

          {started ? <Comparison events={events} /> : null}
        </div>

        {/* ============================ COLUMN 3 — EVIDENCE & SECURITY */}
        <div className="d-col">
          <Guarantees />
          <EvidenceDrawer events={events} goalId={goalId} />
        </div>
      </main>
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

