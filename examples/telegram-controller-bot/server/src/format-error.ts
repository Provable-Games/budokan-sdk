// Robust user-facing error formatter. `String(err)` produces "[object Object]"
// for plain objects, which is what starknet.js / Cartridge often throw.
// This unwraps common shapes so the chat reply has something meaningful.
//
// Also logs the raw error to stderr — `String(err)` doesn't surface enough
// to debug from Railway logs alone, so we always dump the full thing.

export function formatError(error: unknown): string {
  // Always log first so the server has the full original object regardless
  // of what we return to the user.
  try {
    console.error("formatError raw:", error);
  } catch {
    // Some error objects throw on toString — ignore.
  }

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
    const data = obj.data !== undefined && obj.data !== null ? shortObject(obj.data) : undefined;

    const parts: string[] = [];
    if (code !== undefined) parts.push(`code ${code}`);
    if (message) parts.push(message);
    else if (inner) parts.push(inner);
    if (data && !message && !inner) parts.push(data);

    if (parts.length > 0) return parts.join(": ");
    return shortObject(error);
  }

  return String(error);
}

// JSON.stringify with a length cap so we don't fire a 50KB Telegram message.
function shortObject(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value, replacer);
  } catch {
    s = String(value);
  }
  if (s.length > 500) s = s.slice(0, 497) + "…";
  return s;
}

// JSON.stringify doesn't natively handle BigInt; coerce so a thrown
// starknet.js BigNumberish doesn't itself throw at format time.
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
