// Tx-mode flow. See ../../../ARCHITECTURE.md "Flow 2 — Paid action (per-tx)".
//
// 1. Fetch the call payload from the bot via the one-time token.
// 2. Initialize Cartridge ControllerProvider in the browser. This uses the
//    keychain iframe loaded from x.cartridge.gg — that origin IS on
//    Cartridge's CORS allowlist for /query, which is why this path works
//    where the SessionProvider browser flow doesn't.
// 3. controller.connect() ensures the user is logged in (auto-resumes if
//    they have a prior Cartridge session in this browser).
// 4. controller.openExecute(calls) opens the keychain modal for explicit
//    confirmation; on submit it returns { transactionHash }.
// 5. POST the tx hash back to the bot. Bot relays to the chat.
// 6. Tell Telegram to close the Mini App.

import { useCallback, useEffect, useMemo, useState } from "react";
import { constants } from "starknet";
import ControllerProvider from "@cartridge/controller";

import { fetchTxInfo, postTxResult } from "../api.ts";
import { tgClose, tgExpand } from "../telegram.ts";
import type { TxInfoResponse } from "../types.ts";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; info: TxInfoResponse }
  | { kind: "executing" }
  | { kind: "submitting"; txHash: string }
  | { kind: "success"; txHash: string }
  | { kind: "error"; message: string };

interface Props {
  token: string;
}

export function Tx({ token }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    tgExpand();
    fetchTxInfo(token)
      .then((info) => setStatus({ kind: "ready", info }))
      .catch((error: unknown) =>
        setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, [token]);

  const onConfirm = useCallback(async () => {
    if (status.kind !== "ready") return;
    const info = status.info;
    setStatus({ kind: "executing" });

    try {
      // No `policies` — we want explicit per-tx confirmation in the keychain
      // modal, not a session that auto-signs.
      const provider = new ControllerProvider({
        chains: [{ rpcUrl: info.rpcUrl }],
        defaultChainId: chainIdConstant(info.chain),
      });

      // Ensure connected. If the user already has a Cartridge session in this
      // browser, this resumes silently. Otherwise it prompts.
      const account = await provider.connect();
      if (!account) throw new Error("Cartridge did not return a connected account.");

      // openExecute opens the keychain modal with the calls. User confirms,
      // signs, and the tx is submitted. Returns { status, transactionHash }.
      const result = await provider.openExecute(info.calls, chainIdConstant(info.chain));
      if (!result || !result.status) {
        // User cancelled or execute returned a non-success status.
        await postTxResult(token, { error: "User cancelled or execute failed" }).catch(() => {});
        setStatus({ kind: "error", message: "Transaction not submitted." });
        return;
      }

      setStatus({ kind: "submitting", txHash: result.transactionHash });
      await postTxResult(token, { txHash: result.transactionHash });
      setStatus({ kind: "success", txHash: result.transactionHash });
      setTimeout(() => tgClose(), 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Best-effort: tell the bot the user bailed so the chat gets a notice.
      await postTxResult(token, { error: message }).catch(() => {});
      setStatus({ kind: "error", message });
    }
  }, [status, token]);

  const summary = useMemo(() => {
    if (status.kind === "ready") return status.info.summary;
    return null;
  }, [status]);

  if (status.kind === "loading") {
    return <Page title="Loading…">Fetching transaction details…</Page>;
  }
  if (status.kind === "error") {
    return (
      <Page title="Transaction failed">
        <p style={{ color: "#c00" }}>{status.message}</p>
        <p style={{ marginTop: 16, fontSize: 14, opacity: 0.7 }}>
          Close this window and try again from the chat.
        </p>
      </Page>
    );
  }
  if (status.kind === "executing") {
    return <Page title="Awaiting Cartridge…">Confirm in the keychain dialog. This window will update automatically.</Page>;
  }
  if (status.kind === "submitting") {
    return (
      <Page title="Submitting…">
        <p>Tx hash: <code style={{ fontFamily: "ui-monospace, monospace" }}>{shortTx(status.txHash)}</code></p>
      </Page>
    );
  }
  if (status.kind === "success") {
    return (
      <Page title="Submitted ✓">
        <p>The bot will confirm in chat shortly.</p>
        <p style={{ fontSize: 13, opacity: 0.6, marginTop: 12 }}>
          tx: <code>{shortTx(status.txHash)}</code>
        </p>
      </Page>
    );
  }

  // ready
  return (
    <Page title="Confirm transaction">
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "rgba(0,0,0,0.04)",
          borderRadius: 8,
          padding: 12,
          fontSize: 13,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {summary}
      </pre>
      <button onClick={onConfirm} style={primaryButton}>
        Confirm in Cartridge
      </button>
      <p style={{ marginTop: 16, fontSize: 13, opacity: 0.7 }}>
        Cartridge will open a confirmation dialog. The transaction is signed in your browser — the bot can't sign it without you.
      </p>
    </Page>
  );
}

function chainIdConstant(chain: "mainnet" | "sepolia"): constants.StarknetChainId {
  return chain === "mainnet"
    ? constants.StarknetChainId.SN_MAIN
    : constants.StarknetChainId.SN_SEPOLIA;
}

function shortTx(hash: string): string {
  if (!hash || hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function Page(props: { title: string; children: React.ReactNode }) {
  return (
    <main style={{ fontFamily: "system-ui", padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>{props.title}</h1>
      {props.children}
    </main>
  );
}

const primaryButton: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  fontSize: 16,
  fontWeight: 600,
  background: "#0066ff",
  color: "white",
  border: "none",
  borderRadius: 12,
  cursor: "pointer",
};
