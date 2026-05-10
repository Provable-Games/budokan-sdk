// Voyager API client — token balances for the prize-sponsorship picker.
// Mirrors budokan/client/src/hooks/useVoyagerTokenBalances.ts but
// server-side (no React, no fetch quirks). Hits the same proxy that
// budokan.gg uses (set via BUDOKAN_VOYAGER_PROXY_URL).
//
// Voyager-side API key is kept in the proxy, not in our config.

interface VoyagerErc20BalanceItem {
  name: string;
  address: string;
  balance: string;
  usdBalance: string;
  usdFormattedBalance: string;
  decimals: string;
  symbol: string;
  formattedBalance: string;
  iconLogo: string;
  isVerified: boolean;
}

interface VoyagerApiResponse {
  erc20TokenBalances: VoyagerErc20BalanceItem[];
}

export interface VoyagerTokenBalance {
  tokenAddress: string;
  balance: string;          // raw u256 amount, decimal string
  symbol: string;
  name: string;
  decimals: number;
  usdBalance?: number;
}

/**
 * Fetch ERC-20 balances for an address from a Voyager proxy. Returns an
 * empty array if the proxy URL is unset (caller should treat as
 * "feature unavailable").
 */
export async function fetchVoyagerBalances(
  proxyUrl: string | undefined,
  ownerAddress: string,
): Promise<VoyagerTokenBalance[]> {
  if (!proxyUrl) return [];

  // Pad address to 66 chars (0x + 64 hex). Voyager rejects short forms.
  const padded = padAddress(ownerAddress).toLowerCase();
  const url = `${proxyUrl.replace(/\/$/, "")}/api/voyager/contracts/${padded}/token-balances`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  } catch (error) {
    throw new Error(`Voyager proxy unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    throw new Error(`Voyager proxy returned ${res.status}`);
  }
  const data = (await res.json()) as VoyagerApiResponse;
  const items = data.erc20TokenBalances ?? [];
  return items.map((item) => ({
    tokenAddress: item.address.toLowerCase(),
    balance: item.balance,
    symbol: item.symbol,
    name: item.name,
    // Voyager returns decimals as a hex string like "0x6"; tolerate decimal too.
    decimals: parseDecimals(item.decimals),
    usdBalance: item.usdBalance ? parseFloat(item.usdBalance) : undefined,
  }));
}

function padAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]+$/.test(address)) {
    throw new Error(`Invalid address: ${address}`);
  }
  const stripped = address.replace(/^0x0*/, "");
  return "0x" + stripped.padStart(64, "0");
}

function parseDecimals(raw: string | undefined): number {
  if (!raw) return 18;
  const parsed = raw.startsWith("0x") || raw.startsWith("0X")
    ? parseInt(raw, 16)
    : parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 18;
}
