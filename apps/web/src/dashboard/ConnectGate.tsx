/**
 * The console's front door: connect a wallet, then use the console.
 *
 * The wallet signs three things here: opening a goal, funding it, and closing
 * it to take the money back. Nothing in the console works without it, so the
 * console is not offered until one is connected. The gate is a dialog that
 * cannot be dismissed, drawn over the console: the frame behind it is inert
 * while it is open and usable the moment a connection exists.
 *
 * It follows the account, not a click. Disconnecting from the top bar brings
 * it back, and a wallet that reconnects on load sees it only for as long as
 * the reconnect takes.
 */

import { useState } from "react";
import { ConnectorAlreadyConnectedError, useAccount, useConnect } from "wagmi";

import { Modal } from "./Modal.js";

/**
 * True when something has injected an EIP-1193 provider. A presence check and
 * not a capability probe: any answer at all means a prompt will appear.
 */
function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && "ethereum" in window;
}

export function ConnectGate() {
  const { status } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const [declined, setDeclined] = useState(false);

  /*
   * The first connector is the config's own `injected()`. Anything after it
   * was discovered over EIP-6963 and targets the same extension, so offering
   * both would be two buttons for one wallet.
   */
  const connector = connectors[0];
  const walletPresent = hasInjectedProvider() && connector !== undefined;
  const checking = status === "reconnecting" || status === "connecting";

  async function connect(): Promise<void> {
    if (!connector) return;
    setDeclined(false);
    try {
      await connectAsync({ connector });
    } catch (e) {
      /*
       * `WagmiProvider` reconnects on mount, and `connect` throws this when
       * handed the connector that is already live. The connection exists, so
       * this is the success path arriving by an unusual route.
       */
      if (e instanceof ConnectorAlreadyConnectedError) return;
      // Declined or dismissed. Say so, and leave the button where it was.
      setDeclined(true);
    }
  }

  return (
    <Modal open={status !== "connected"} title="Connect a wallet" tag="Base Sepolia · testnet">
      <p className="d-caption">
        Your wallet signs three things in this console: opening a goal, funding its budget, and
        closing it to take the money back. It signs nothing while the agent is paying.
      </p>

      {!walletPresent ? (
        <>
          <div className="d-notice" data-tone="error">
            <strong>No browser wallet found</strong>
            <p>
              Install{" "}
              <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                MetaMask
              </a>
              , then reload this page.
            </p>
          </div>
          <button
            type="button"
            className="d-btn d-btn-block"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </>
      ) : (
        <>
          {declined ? (
            <div className="d-notice" data-tone="error">
              <strong>Connection declined</strong>
              <p>The wallet did not connect. Try again when you are ready.</p>
            </div>
          ) : null}
          <button
            type="button"
            className="d-btn d-btn-block"
            disabled={checking}
            onClick={() => void connect()}
          >
            {checking ? "Waiting for the wallet…" : "Connect wallet"}
          </button>
        </>
      )}
    </Modal>
  );
}
