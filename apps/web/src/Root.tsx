/**
 * Chooses between the public landing page and the execution console.
 *
 * This exists so `App.tsx` — the console — needs no change at all. There is no
 * router in this app and the brief rules out new dependencies, so the split is
 * a single piece of state rather than a route. If routing is wanted later, this
 * is the one file that has to learn about it.
 *
 * The landing's CTA says "Connect with MetaMask", so it does exactly that
 * before handing over. A rejected or missing wallet still opens the console:
 * step 1 there is the connect step, which is a better place to recover than a
 * dead end on the marketing page.
 */

import { useState } from "react";
import { useConnect } from "wagmi";
import { injected } from "wagmi/connectors";

import App from "./App.js";
import { Landing } from "./landing/Landing.js";

export default function Root() {
  const [entered, setEntered] = useState(false);
  const { connectAsync } = useConnect();

  async function enter() {
    try {
      // Bounded, because "no injected wallet" is not always an error. With no
      // provider to answer the EIP-6963 announcement, `connectAsync` can simply
      // never settle — and an awaited promise that never settles means the CTA
      // does nothing, forever, with no feedback. A viewer without MetaMask
      // installed is exactly the person most likely to click it.
      await Promise.race([
        connectAsync({ connector: injected() }),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      // Declined. Not fatal — the console's first step is the connect prompt,
      // and it reports the reason properly.
    }
    setEntered(true);
  }

  if (entered) return <App />;
  return <Landing onConnect={() => void enter()} />;
}
