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

import { Badge, Hash, Step, type StepState } from "./components/Step.js";
import { RunLog } from "./components/RunLog.js";
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
  const run = () =>
    guard(`Running the ${mode} request…`, async () => {
      if (!goalId) throw new Error("no goal");
      setEvents([]);
      setResult(undefined);
      for await (const event of streamRun(goalId, mode)) {
        if (event.channel === "payment") setEvents((prior) => [...prior, event.data]);
        else if (event.channel === "result") setResult(event.data);
        else if (event.channel === "error") setError(event.data.message);
      }
    });

  const stepState = useMemo(
    () => ({
      connect: (isConnected && !wrongChain ? "done" : "ready") as StepState,
      payer: (payer ? "done" : isConnected && !wrongChain ? "ready" : "blocked") as StepState,
      goal: (goalId ? "done" : payer ? "ready" : "blocked") as StepState,
      fund: (funded ? "done" : goalId ? "ready" : "blocked") as StepState,
      run: (goalId ? "ready" : "blocked") as StepState,
    }),
    [isConnected, wrongChain, payer, goalId, funded],
  );

  return (
    <main className="page">
      <header className="masthead">
        <h1>Inco-Bound Agent Payment Flow</h1>
        <p>
          An autonomous agent that pays for API resources over x402, where the spending policy is
          enforced by confidential computation on Inco rather than by the agent itself.
        </p>
        <p className="claim">
          Compromise of the AI orchestrator must not confer arbitrary spending authority.
        </p>
      </header>

      {configError ? (
        <div className="notice" data-tone="error">
          Cannot reach the orchestrator: {configError}. Start it with{" "}
          <code>pnpm --filter @ntux402/orchestrator run serve</code>.
        </div>
      ) : null}

      {config?.settlement === "stub" ? (
        <div className="notice" data-tone="warn">
          <strong>Stub settlement.</strong> No facilitator is configured, so payments are validated
          but no USDC moves. Everything else — the encrypted policy, the decision, the bounce — is
          real and on chain.
        </div>
      ) : null}

      {error ? (
        <div className="notice" data-tone="error">
          {error}
        </div>
      ) : null}

      <Step
        n={1}
        title="Connect a wallet"
        blurb="Base Sepolia. The wallet signs the goal and the funding transfer, and nothing else."
        state={stepState.connect}
      >
        {!isConnected ? (
          <div className="row">
            {connectors.map((connector) => (
              <button key={connector.uid} onClick={() => connect({ connector })}>
                Connect {connector.name}
              </button>
            ))}
          </div>
        ) : wrongChain ? (
          <div className="row">
            <span>
              Connected to chain {chainId}. This demo writes only to Base Sepolia ({CHAIN_ID}).
            </span>
            <button onClick={() => switchChain({ chainId: CHAIN_ID })}>Switch network</button>
          </div>
        ) : (
          <div className="row">
            <code className="handle" style={{ flex: 1, minWidth: "18rem" }}>
              {address}
            </code>
            <button className="secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </Step>

      <Step
        n={2}
        title="Mint the ephemeral payer key"
        blurb="The Authorization Signer generates a per-goal key and returns only its address. This must happen before the goal is opened, because the payer address is a field of the goal record — a mutable payer field would let whoever can write it redirect every future signature."
        state={stepState.payer}
      >
        {payer ? (
          <>
            <Hash value={payer} />
            <p className="hint">
              The private key never left the signer. Nothing else in the system can produce a
              signature for this address.
            </p>
          </>
        ) : (
          <button disabled={!isConnected || wrongChain || !!busy} onClick={mintPayer}>
            Mint payer address
          </button>
        )}
      </Step>

      <Step
        n={3}
        title="Open the goal"
        blurb="The budget is encrypted in your browser, bound to your address, and converted to a handle on chain. Your wallet sends this — the orchestrator structurally cannot."
        state={stepState.goal}
      >
        <dl className="facts">
          <dt>remaining budget</dt>
          <dd>{formatUsdc(BUDGET)} USDC — encrypted</dd>
          <dt>per-call cap</dt>
          <dd>{formatUsdc(PER_CALL_CAP)} USDC — public</dd>
          <dt>calls</dt>
          <dd>{CALLS_REMAINING}</dd>
        </dl>
        <p className="hint">
          The cap sits deliberately <em>above</em> the malicious vendor’s 5.00 USDC ask, and both
          vendors are allowlisted. The bounce has to come from the encrypted budget, not from a
          public <code>require()</code> — otherwise it proves nothing about Inco.
        </p>
        {goalId ? (
          <>
            <dl className="facts" style={{ marginTop: "1rem" }}>
              <dt>goal</dt>
              <dd>#{goalId}</dd>
            </dl>
            {budgetHandle ? <Hash value={budgetHandle} /> : null}
            <p className="hint">
              That is the entire on-chain representation of the budget: an opaque{" "}
              <code>bytes32</code>.{" "}
              {config ? (
                <a href={explorer.address(config.vaultAddress)} target="_blank" rel="noreferrer">
                  Check it on Basescan
                </a>
              ) : null}
              .
            </p>
          </>
        ) : (
          <>
            <button disabled={!payer || !!busy} onClick={openGoal}>
              Encrypt budget and open goal
            </button>
            {/*
              Opening a goal costs a transaction and a wallet prompt, so a page
              reload mid-demo should not force another one. Resuming also lets
              the run steps be exercised without a wallet at all.
            */}
            <div className="row" style={{ marginTop: "1rem" }}>
              <label className="hint" style={{ margin: 0 }} htmlFor="resume">
                Already opened one?
              </label>
              <input
                id="resume"
                inputMode="numeric"
                placeholder="goal id"
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && resumeId) setGoalId(resumeId);
                }}
                style={{
                  font: "inherit",
                  fontSize: "0.9rem",
                  padding: "0.45rem 0.6rem",
                  width: "7rem",
                  background: "var(--paper-raised)",
                  color: "var(--ink)",
                  border: "1px solid var(--rule-strong)",
                  borderRadius: "2px",
                }}
              />
              <button
                className="secondary"
                disabled={resumeId === ""}
                onClick={() => setGoalId(resumeId)}
              >
                Resume
              </button>
            </div>
          </>
        )}
      </Step>

      <Step
        n={4}
        title="Fund the payer"
        blurb="A second, independent spending bound. The ephemeral account holds only what you send it, so even if the Inco policy were bypassed entirely, the loss ceiling is this number."
        state={stepState.fund}
      >
        {funded ? (
          <p>
            <Badge tone="approve">funded</Badge> {formatUsdc(PAYER_FUNDING)} USDC sent to the payer.
          </p>
        ) : (
          <>
            {underfunded ? (
              <div className="notice" data-tone="warn">
                <strong>No test USDC.</strong> This account holds{" "}
                {formatUsdc(usdcBalance ?? 0n)} USDC and needs {formatUsdc(PAYER_FUNDING)}. Get some
                from the{" "}
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  Circle faucet
                </a>{" "}
                — pick <em>USDC</em> and <em>Base Sepolia</em>, then reload.
                <br />
                <br />
                You can skip this and run the <strong>malicious</strong> request now: it bounces off
                the confidential policy long before any money would move. Only the honest run needs
                funding.
              </div>
            ) : null}
            <button disabled={!goalId || !!busy || underfunded} onClick={fundPayer}>
              Send {formatUsdc(PAYER_FUNDING)} USDC
            </button>
            <p className="hint">
              Deliberately more than the {formatUsdc(BUDGET)} USDC encrypted budget, so the Inco
              policy binds first. If the two numbers were equal, nobody could tell which control
              stopped the payment.
            </p>
          </>
        )}
      </Step>

      <Step
        n={5}
        title="Hand off to the agent"
        blurb="From here the orchestrator runs unattended. No further wallet prompts — if one appears, something is wrong."
        state={stepState.run}
      >
        <div className="row" style={{ marginBottom: "1rem" }}>
          <div className="tabs">
            <button aria-pressed={mode === "honest"} onClick={() => setMode("honest")}>
              Honest 402
            </button>
            <button aria-pressed={mode === "malicious"} onClick={() => setMode("malicious")}>
              Malicious 402
            </button>
          </div>
          <button disabled={!goalId || !!busy} onClick={run}>
            {busy ?? `Run ${mode} request`}
          </button>
          {config ? (
            <Badge tone="neutral">
              agent: {config.agent === "llm" ? "live model" : "scripted"}
            </Badge>
          ) : null}
        </div>

        {mode === "malicious" ? (
          <p className="hint">
            This vendor charges ~500× and embeds a prompt injection claiming the spend is
            pre-approved. Expect the agent to be convinced. Watch the money anyway.
          </p>
        ) : null}

        <RunLog events={events} />

        {result ? <Verdict result={result} /> : null}
      </Step>
    </main>
  );
}

function Verdict({ result }: { result: RunResult }) {
  switch (result.kind) {
    case "paid":
      return (
        <div className="notice" style={{ marginTop: "1.25rem" }}>
          <Badge tone="approve">paid</Badge> The policy approved, the signer signed against the
          finalized record, and the resource returned its data.
        </div>
      );
    case "policy-rejected":
      return (
        <div className="notice" data-tone="warn" style={{ marginTop: "1.25rem" }}>
          <Badge tone="reject">bounced</Badge> The confidential policy rejected this spend.
          Counters unchanged, no authorization exists to sign against, and the signer was never
          asked. The agent was manipulated and the money still did not move.
        </div>
      );
    case "decision-unavailable":
      return (
        <div className="notice" data-tone="warn" style={{ marginTop: "1.25rem" }}>
          <Badge tone="pending">decision unavailable</Badge> The debit committed at{" "}
          <code>requestSpend</code>, but the reveal never resolved after {result.attempts}{" "}
          attempts. This is the Inco liveness case, not a rejection.
        </div>
      );
    case "free":
      return (
        <div className="notice" style={{ marginTop: "1.25rem" }}>
          The resource returned 200 without demanding payment.
        </div>
      );
    case "failed":
      return (
        <div className="notice" data-tone="error" style={{ marginTop: "1.25rem" }}>
          {result.reason}
        </div>
      );
  }
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
