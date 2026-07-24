/**
 * Normalize a Starknet address to a 0x-prefixed, 66-character lowercase hex string.
 *
 * Surrounding whitespace is trimmed, but the input must otherwise be hex digits
 * with an optional `0x` prefix. A malformed value (a stray space or other non-hex
 * character from a copy/paste, an over-wide string) throws here — where the
 * offending value can be named — rather than surviving normalization and
 * detonating later as an opaque "Failed to parse String to BigInt" deep in
 * calldata encoding.
 */
export function normalizeAddress(address: string): string {
  const trimmed = typeof address === "string" ? address.trim() : "";
  // Prefix is case-insensitive ("0X01" is a valid representation), like the digits.
  const match = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid Starknet address ${JSON.stringify(address)}: expected hex digits with an optional "0x" prefix`,
    );
  }
  const hex = match[1]!.replace(/^0+/, "");
  if (hex.length > 64) {
    throw new Error(
      `Invalid Starknet address ${JSON.stringify(address)}: ${hex.length} hex digits exceed the 64-digit field element width`,
    );
  }
  return ("0x" + hex.padStart(64, "0")).toLowerCase();
}
