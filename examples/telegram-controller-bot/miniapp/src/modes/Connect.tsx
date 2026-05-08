// Connect-mode flow. See ../../../ARCHITECTURE.md "Flow 1 — Onboarding (sessioned)".
//
// 1. Fetch policy bundle from bot via the one-time token.
// 2. Initialize Cartridge SessionProvider in the browser.
// 3. provider.connect() opens Cartridge auth in a new tab, returns when the
//    user completes auth (Cartridge streams the result back over a WS, no
//    redirect required).
// 4. Read sessionSigner + session from localStorage (where SessionProvider
//    persists them), POST the bundle back to the bot.
// 5. Tell Telegram to close the Mini App.

import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { constants } from "starknet";
import SessionProvider from "@cartridge/controller/session";

import { fetchConnectInfo, postConnectSession } from "../api.ts";
import { tgClose, tgExpand } from "../telegram.ts";
import type { ConnectInfoResponse, ConnectPostBody } from "../types.ts";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; info: ConnectInfoResponse }
  | { kind: "authorizing" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

interface Props {
  token: string;
}

export function Connect({ token }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    tgExpand();
    fetchConnectInfo(token)
      .then((info) => setStatus({ kind: "ready", info }))
      .catch((error: unknown) =>
        setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  }, [token]);

  const onAuthorize = useCallback(async () => {
    if (status.kind !== "ready") return;
    const info = status.info;
    setStatus({ kind: "authorizing" });

    try {
      const provider = new SessionProvider({
        rpc: info.rpcUrl,
        chainId: chainIdConstant(info.chain),
        policies: info.policies,
        // Cartridge resolves auth via WebSocket, but redirectUrl must be a
        // real URL — just send it back to ourselves with the same token.
        redirectUrl: window.location.href,
      });

      // connect() blocks until the user completes Cartridge auth in the
      // popup. SessionProvider stores results in localStorage as a
      // side-effect; we read them out below.
      const account = await provider.connect();
      if (!account) throw new Error("Cartridge did not return a connected account.");

      const body = readSessionFromStorage();
      if (!body) throw new Error("Session bundle missing after authorization. Try again.");

      setStatus({ kind: "submitting" });
      await postConnectSession(token, body);
      setStatus({ kind: "success" });
      // Brief beat so the user sees the success state, then close.
      setTimeout(() => tgClose(), 600);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ kind: "error", message });
    }
  }, [status, token]);

  const policySummary = useMemo(() => {
    if (status.kind !== "ready") return null;
    return summarizePolicies(status.info);
  }, [status]);

  if (status.kind === "loading") {
    return <Page title="Connecting…">Loading authorization details…</Page>;
  }

  if (status.kind === "error") {
    return (
      <Page title="Authorization failed">
        <p style={{ color: "#c00" }}>{status.message}</p>
        <p style={{ marginTop: 16, fontSize: 14, opacity: 0.7 }}>
          Close this window and run /connect again from the chat.
        </p>
      </Page>
    );
  }

  if (status.kind === "authorizing") {
    return (
      <Page title="Authorizing…">
        Cartridge has opened in a new tab. Sign in there and approve the policies. This window will update automatically.
      </Page>
    );
  }

  if (status.kind === "submitting") {
    return <Page title="Saving session…">Almost done.</Page>;
  }

  if (status.kind === "success") {
    return <Page title="Connected">You can close this window.</Page>;
  }

  return (
    <Page title="Authorize bot">
      <p style={{ marginBottom: 16 }}>
        The bot will gain permission to call the following Budokan methods on your behalf, signed
        with a session key that lives only on the bot's server. Token approvals are NOT included —
        any tournament with an entry fee will require an additional confirmation here.
      </p>
      {policySummary}
      <button onClick={onAuthorize} style={primaryButton}>
        Open Cartridge to authorize
      </button>
      <p style={{ marginTop: 16, fontSize: 13, opacity: 0.7 }}>
        Chain: {status.info.chain}
      </p>
    </Page>
  );
}

function chainIdConstant(chain: "mainnet" | "sepolia"): constants.StarknetChainId {
  return chain === "mainnet"
    ? constants.StarknetChainId.SN_MAIN
    : constants.StarknetChainId.SN_SEPOLIA;
}

// Read the session bundle SessionProvider just persisted to localStorage.
// Keys (`sessionSigner`, `session`) are set by
// controller/packages/controller/src/session/provider.ts:connect.
function readSessionFromStorage(): ConnectPostBody | null {
  const signerRaw = localStorage.getItem("sessionSigner");
  const sessionRaw = localStorage.getItem("session");
  if (!signerRaw || !sessionRaw) return null;
  try {
    const signer = JSON.parse(signerRaw) as { privKey: string; pubKey: string };
    const session = JSON.parse(sessionRaw) as {
      username: string;
      address: string;
      ownerGuid: string;
      expiresAt: string;
      guardianKeyGuid?: string;
      metadataHash?: string;
      sessionKeyGuid?: string;
    };
    if (!signer.privKey || !signer.pubKey) return null;
    if (!session.username || !session.address || !session.ownerGuid || !session.expiresAt) return null;
    return {
      address: session.address,
      username: session.username,
      ownerGuid: session.ownerGuid,
      expiresAt: String(session.expiresAt),
      guardianKeyGuid: session.guardianKeyGuid ?? "0x0",
      metadataHash: session.metadataHash ?? "0x0",
      sessionKeyGuid: session.sessionKeyGuid ?? "",
      signer,
    };
  } catch {
    return null;
  }
}

function summarizePolicies(info: ConnectInfoResponse): ReactElement {
  const entries: Array<{ contract: string; method: string; description: string }> = [];
  for (const [contract, group] of Object.entries(info.policies.contracts)) {
    for (const method of group.methods) {
      entries.push({ contract, method: method.entrypoint, description: method.description });
    }
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
      {entries.map((e, i) => (
        <li
          key={i}
          style={{
            padding: "10px 12px",
            background: "rgba(0,0,0,0.04)",
            borderRadius: 8,
            marginBottom: 8,
          }}
        >
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{e.method}</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{e.description}</div>
        </li>
      ))}
    </ul>
  );
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
