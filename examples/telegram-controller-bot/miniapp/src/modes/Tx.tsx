// Tx-mode flow stub. See ../../../ARCHITECTURE.md "Flow 2 — Paid action (per-tx)".
//
// Lands in stage 5 alongside the bot-side /api/tx/* routes and /enter command.
// For stage 3 we render a placeholder so the URL routing in main.tsx is
// exhaustive.

interface Props {
  token: string;
}

export function Tx({ token }: Props) {
  return (
    <main style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Sign transaction</h1>
      <p>Per-tx confirmation flow lands in stage 5.</p>
      <p style={{ fontSize: 13, opacity: 0.6 }}>token: {token}</p>
    </main>
  );
}
