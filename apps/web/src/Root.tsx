/**
 * Chooses between the public landing page and the execution console.
 *
 * This exists so `App.tsx` — the console — needs no change at all. There is no
 * router in this app and a router would be a new dependency for two routes, so
 * the split is a single piece of state rather than a route.
 *
 * ## Why there is no timeout here
 *
 * An earlier version raced `connectAsync` against a 2.5s timer, to survive the
 * case where no injected provider exists and the promise therefore never
 * settles. That conflated two very different situations — "there is no wallet"
 * and "the human has not decided yet" — and approving a MetaMask prompt
 * routinely takes longer than 2.5 seconds. The timer would win and the console
 * would open behind the still-open popup.
 *
 * So provider *presence* is now checked directly, and the connection itself is
 * awaited with no deadline. A person reading the permission dialog is not a
 * timeout, and treating them as one is how a wallet app loses trust.
 */

import { useState } from "react";
import { useConnect } from "wagmi";
import { injected } from "wagmi/connectors";

import App from "./App.js";
import { Landing } from "./landing/Landing.js";

export type ConnectPhase = "idle" | "connecting" | "declined";

/**
 * True when something has injected an EIP-1193 provider. Deliberately a
 * presence check rather than a capability probe: any answer at all means a
 * prompt will appear, and the prompt is what we are waiting on.
 */
function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && "ethereum" in window;
}

export default function Root() {
  const [entered, setEntered] = useState(false);
  const [phase, setPhase] = useState<ConnectPhase>("idle");
  const { connectAsync } = useConnect();

  async function enter(): Promise<void> {
    if (!hasInjectedProvider()) {
      // Nothing to prompt. The console's first step explains what to install,
      // which is a better place to recover than a dead end on the landing page.
      setEntered(true);
      return;
    }

    setPhase("connecting");
    try {
      await connectAsync({ connector: injected() });
      setEntered(true);
    } catch {
      // Declined, or dismissed. Stay put and say so — silently advancing into
      // the console would imply a connection that does not exist.
      setPhase("declined");
    }
  }

  if (entered) return <App />;
  return <Landing onConnect={() => void enter()} phase={phase} />;
}
