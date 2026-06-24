// Mini App entry. Routes by ?mode=connect|tx and forwards the ?token=<uuid>
// query param into the chosen flow.
//
// See ../../ARCHITECTURE.md for the design overview. Each mode's component
// has its own header comment describing the flow.

import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { Connect } from "./modes/Connect.tsx";
import { Tx } from "./modes/Tx.tsx";
import { tgReady } from "./telegram.ts";

type Mode = "connect" | "tx";

function App() {
  const params = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      token: p.get("token") ?? "",
      mode: (p.get("mode") ?? "") as Mode | "",
    };
  }, []);

  useEffect(() => {
    tgReady();
  }, []);

  if (!params.token) {
    return (
      <ErrorPage
        title="Missing token"
        message="This page must be opened from a /connect button in the bot. The URL is missing a `token` parameter."
      />
    );
  }

  if (params.mode === "connect") {
    return <Connect token={params.token} />;
  }

  if (params.mode === "tx") {
    return <Tx token={params.token} />;
  }

  return (
    <ErrorPage
      title="Unknown mode"
      message={`The URL specifies mode='${params.mode}', which this Mini App doesn't recognize. Expected 'connect' or 'tx'.`}
    />
  );
}

function ErrorPage(props: { title: string; message: string }) {
  return (
    <main style={{ fontFamily: "system-ui", padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>{props.title}</h1>
      <p>{props.message}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
