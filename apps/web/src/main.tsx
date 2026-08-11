// Must be first: the Inco SDK touches Node globals at import time.
import "./polyfills.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import Root from "./Root.js";
import { wagmiConfig } from "./lib/config.js";
import "./styles.css";

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
