// Turn starknet.js / RPC errors into something an agent can act on.
//
// A failed fee estimation throws the entire JSON-RPC request back as the
// error message (several KB of calldata) with the actual Cairo revert
// reason buried inside `execution_error`. Surfacing that blob verbatim
// buries the fix; this module extracts the revert sentence and, for
// known Budokan validation failures, appends the tool call that resolves
// them.

const HINTS: Array<[RegExp, string]> = [
  [
    /does not support IGame/i,
    "The game address is not a live IGame contract on this chain. Pick a game from " +
      "list_games and prefer one that recent tournaments on this chain actually use " +
      "(list_tournaments shows gameAddress per tournament).",
  ],
  [
    /Settings id .* not found/i,
    "The settings id is not registered for this game. Call list_game_settings and use one " +
      "of the returned ids.",
  ],
  [
    /share|distribution/i,
    "Check the entry-fee shares: basis points must leave room for the winners' pool, and " +
      "some games enforce a minimum gameCreatorShareBps on-chain (retry with the game's " +
      "defaultGameFeePercentage × 100 from list_games).",
  ],
];

/** Best-effort extraction of the Cairo revert sentence from an RPC error. */
function extractRevertReason(message: string): string | undefined {
  // Revert strings are the quoted human sentences inside execution_error —
  // escaped quotes (\"Budokan: …\") since execution_error is JSON embedded
  // in a JSON string. Calldata hex and JSON keys never look like multi-word
  // sentences.
  const sentences = [...message.matchAll(/\\?"([A-Za-z][^"\\]{10,300})\\?"/g)]
    .map((m) => m[1]!)
    .filter((s) => /\s/.test(s) && !/^https?:/.test(s) && !s.startsWith("0x"));
  if (sentences.length === 0) return undefined;
  // The longest quoted sentence is essentially always the revert reason.
  return sentences.sort((a, b) => b.length - a.length)[0];
}

export function formatToolError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  // Redact bearer tokens (RPC_API_KEY) in case the RPC echo carries headers.
  const message = raw.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");

  const isRpcBlob = /execution_error|starknet_estimateFee|starknet_addInvoke/i.test(message);
  const reason = isRpcBlob ? extractRevertReason(message) : undefined;

  let out: string;
  if (reason) {
    out = `Transaction rejected on-chain: ${reason}`;
  } else if (message.length > 600) {
    out = `${message.slice(0, 600)} …[truncated]`;
  } else {
    out = message;
  }

  const hint = HINTS.find(([re]) => re.test(out))?.[1];
  return hint ? `${out}\n\nHint: ${hint}` : out;
}
