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
      await connectAsync({ connector: injected() });
    } catch {
      // Declined, or no injected wallet. Not fatal — the console's first step
      // is the connect prompt, and it reports the reason properly.
    }
    setEntered(true);
  }

  if (entered) return <App />;
  return <Landing onConnect={() => void enter()} />;
}
