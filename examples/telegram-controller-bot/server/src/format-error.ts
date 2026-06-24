// Robust user-facing error formatter. `String(err)` produces "[object Object]"
// for plain objects, which is what starknet.js / Cartridge often throw.
// This unwraps common shapes so the chat reply has something meaningful.
//
// Also logs the error to stderr (Railway logs) — but Cartridge/session/account
// errors can carry secrets (signer.privKey, session keys, auth URLs, request
// bodies), so EVERYTHING that gets logged or echoed to chat goes through
// `replacer`, which redacts sensitive keys. Never log the raw object directly.

// Keys whose values may carry a private key, session secret, or auth token.
const SENSITIVE_KEY = /priv|secret|seed|mnemonic|password|passwd|signer|session|authorization|cookie|bearer|api[-_]?key|access[-_]?token/i;

export function formatError(error: unknown): string {
  // Log (redacted) for the server, and redact the returned string too — an
  // error *message* can embed an auth URL / token that the object-key
  // redaction in `replacer` wouldn't catch.
  try {
    console.error("formatError:", redactString(shortObject(error, 2000)));
  } catch {
    // Some error objects throw on toString — ignore.
  }
  return redactString(buildMessage(error));
}

// Free-text redaction: scrub secret-looking substrings (sensitive URL query
// params, bearer tokens) before a message is logged or sent to chat. Leaves
// revert reasons intact ("Budokan: …" + decoded hex).
function redactString(s: string): string {
  return s
    .replace(
      /([?&](?:startapp|code|token|access_token|authorization|api[-_]?key|key|secret|signature|sig)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

function buildMessage(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);

  if (error instanceof Error) {
    // Error.message is usually enough, but include cause if present.
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      return `${error.message} (cause: ${shortObject(cause)})`;
    }
    return error.message || error.toString();
  }

  // Plain object — try the common message-bearing fields in order of
  // specificity, then fall back to JSON.
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const message = typeof obj.message === "string" ? obj.message : undefined;
    const inner = typeof obj.error === "string" ? obj.error : undefined;
    const code = obj.code !== undefined ? String(obj.code) : undefined;
    // Starknet RPC code-41 errors stuff the actual revert reason into
    // `data.execution_error`. Surface that first; without it the user
    // just sees a generic "Transaction execution error".
    const revertReason = extractRevertReason(obj.data);
    const data = obj.data !== undefined && obj.data !== null ? shortObject(obj.data) : undefined;

    const parts: string[] = [];
    if (code !== undefined) parts.push(`code ${code}`);
    if (message) parts.push(message);
    else if (inner) parts.push(inner);
    if (revertReason) {
      parts.push(revertReason);
    } else if (data && !message && !inner) {
      parts.push(data);
    }

    if (parts.length > 0) return parts.join(": ");
    return shortObject(error);
  }

  return String(error);
}

/**
 * Pull a human-readable revert reason out of starknet.js's error.data.
 *
 * Shapes seen in the wild:
 *   - data.execution_error: "Contract returned: 0x4275646f6b616e..."
 *   - data.revert_reason: "..."
 *   - data: { execution_error: { ... } } when running on Pathfinder vs Juno
 *   - data is itself just a string for some Cartridge proxies
 *
 * Returns undefined if nothing useful is found.
 */
function extractRevertReason(data: unknown): string | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === "string") return decodeCairoBytes(data);
  if (typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  for (const key of ["execution_error", "revert_reason", "revertReason"]) {
    const raw = obj[key];
    if (typeof raw === "string" && raw.length > 0) return decodeCairoBytes(raw);
    if (raw && typeof raw === "object") {
      // Some RPCs wrap it again: { execution_error: { revert_reason: "..." } }
      const nested = extractRevertReason(raw);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Cairo assert! messages travel as ASCII bytes packed into felts. starknet.js
 * sometimes hands us "Contract returned: 0x4275646f6b616e..." — decode the hex
 * tail to ASCII so the user sees "Budokan: …" instead of a felt string.
 */
function decodeCairoBytes(raw: string): string {
  const m = raw.match(/0x[0-9a-fA-F]{2,}/g);
  if (!m) return raw;
  let decoded = raw;
  for (const hex of m) {
    const ascii = hexToAscii(hex);
    if (ascii && /[A-Za-z]/.test(ascii)) {
      decoded = decoded.replace(hex, `"${ascii}"`);
    }
  }
  return decoded;
}

function hexToAscii(hex: string): string {
  const body = hex.replace(/^0x/, "");
  if (body.length === 0 || body.length % 2 !== 0) return "";
  let out = "";
  for (let i = 0; i < body.length; i += 2) {
    const c = parseInt(body.slice(i, i + 2), 16);
    if (c === 0) continue;
    // Drop anything outside printable ASCII so we don't get gibberish for
    // hex values that just happen to look like ASCII but aren't.
    if (c < 0x20 || c > 0x7e) return "";
    out += String.fromCharCode(c);
  }
  return out;
}

// JSON.stringify with a length cap so we don't fire a 50KB Telegram message.
// Error objects don't serialize their own message/stack via JSON, so pull
// those out explicitly before stringifying.
function shortObject(value: unknown, cap = 500): string {
  let s: string;
  try {
    const seed =
      value instanceof Error
        ? { name: value.name, message: value.message, cause: (value as { cause?: unknown }).cause }
        : value;
    s = JSON.stringify(seed, replacer);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  if (s.length > cap) s = s.slice(0, cap - 3) + "…";
  return s;
}

// Redact secret-bearing fields and coerce BigInt (JSON.stringify throws on it),
// so nothing logged or echoed to chat leaks a key/session/token.
function replacer(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "bigint") return value.toString();
  return value;
}
