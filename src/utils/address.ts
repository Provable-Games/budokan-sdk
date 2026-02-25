/**
 * Normalize a Starknet address to a 0x-prefixed, 66-character lowercase hex string.
 */
export function normalizeAddress(address: string): string {
  const stripped = address.replace(/^0x0*/i, "");
  return ("0x" + stripped.padStart(64, "0")).toLowerCase();
}
