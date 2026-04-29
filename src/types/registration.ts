/**
 * A registration row keyed by (tournamentId, gameTokenId).
 *
 * Note: there is intentionally no `playerAddress` field. The contract keys
 * registrations by token id only — once the underlying NFT transfers, any
 * stored "registrant" address is the wrong signal for current ownership.
 * Callers that need the current owner of an entry should resolve it via
 * `denshokan-sdk.useTokens` (filtering by minterAddress + contextId).
 * See Provable-Games/budokan#241.
 */
export interface Registration {
  tournamentId: string;
  gameTokenId: string;
  gameAddress: string;
  entryNumber: number;
  hasSubmitted: boolean;
  isBanned: boolean;
}
