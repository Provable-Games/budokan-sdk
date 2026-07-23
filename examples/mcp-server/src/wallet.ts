// Signing-account resolution and dev-wallet lifecycle.
//
// Key material never flows through MCP tool arguments or results — it
// lives in env vars (STARKNET_PRIVATE_KEY / STARKNET_ACCOUNT_ADDRESS), in
// sncast's accounts file (Starknet Foundry —
// ~/.starknet_accounts/starknet_open_zeppelin_accounts.json, selected by
// name via SNCAST_ACCOUNT), or in a keystore file this module writes with
// 0600 permissions (`generate_wallet`). Tool results only ever carry the
// public address.
//
// Generated wallets use the OpenZeppelin account class (constructor:
// `public_key`), verified declared on both mainnet and sepolia. The flow is
// the standard counterfactual one: generate → fund the precomputed address
// with STRK → deploy_wallet sends the DEPLOY_ACCOUNT tx.

import { Account, RpcProvider, ec, hash, stark, uint256 } from "starknet";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEYSTORE_DIR, rpcUrlFor, type Chain } from "./config.ts";

// OpenZeppelin account (SRC6), declared on mainnet + sepolia.
const OZ_ACCOUNT_CLASS_HASH =
  process.env.BUDOKAN_MCP_ACCOUNT_CLASS_HASH ??
  "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

export const STRK_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const ETH_ADDRESS =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

// Pin V3 tip to 1 FRI/gas to avoid overpaying (same convention as
// budokan-bots' submission engines).
export const TX_DETAILS = { tip: 1n } as const;

interface Keystore {
  privateKey: string;
  publicKey: string;
  address: string;
  classHash: string;
}

// --- sncast (Starknet Foundry) accounts-file interop -----------------------
// Same file `sncast account create/import/deploy` maintains. Structure:
//   { "<network>": { "<name>": { private_key, public_key, address?, deployed?, … } } }
// Network keys follow sncast's chain_id_to_network_name mapping.

const SNCAST_ACCOUNTS_FILE =
  process.env.SNCAST_ACCOUNTS_FILE ??
  join(homedir(), ".starknet_accounts", "starknet_open_zeppelin_accounts.json");

const SNCAST_NETWORK: Record<Chain, string> = {
  mainnet: "alpha-mainnet",
  sepolia: "alpha-sepolia",
};

interface SncastAccount {
  private_key: string;
  address?: string;
  deployed?: boolean;
}

function readSncastNetwork(chain: Chain): Record<string, SncastAccount> | null {
  if (!existsSync(SNCAST_ACCOUNTS_FILE)) return null;
  const all = JSON.parse(readFileSync(SNCAST_ACCOUNTS_FILE, "utf8")) as Record<
    string,
    Record<string, SncastAccount>
  >;
  return all[SNCAST_NETWORK[chain]] ?? null;
}

/** Account names available in the sncast accounts file for this chain. */
export function listSncastAccounts(chain: Chain): string[] {
  return Object.keys(readSncastNetwork(chain) ?? {});
}

/**
 * Explicit opt-in via SNCAST_ACCOUNT=<name> — we never auto-pick a signing
 * account the user didn't name. Throws (rather than silently falling
 * through) when the named account is missing, so a typo can't make the
 * server sign with a different wallet.
 */
function resolveSncastAccount(chain: Chain): { name: string; privateKey: string; address: string } | null {
  const name = process.env.SNCAST_ACCOUNT;
  if (!name) return null;
  const network = readSncastNetwork(chain);
  const entry = network?.[name];
  if (!entry) {
    const available = Object.keys(network ?? {});
    throw new Error(
      `SNCAST_ACCOUNT="${name}" not found under network "${SNCAST_NETWORK[chain]}" in ` +
        `${SNCAST_ACCOUNTS_FILE}. Available: ${available.length ? available.join(", ") : "(none)"}.`,
    );
  }
  if (!entry.address) {
    throw new Error(`sncast account "${name}" has no address recorded — deploy it with sncast first.`);
  }
  return { name, privateKey: entry.private_key, address: entry.address };
}

function keystorePath(chain: Chain): string {
  return join(KEYSTORE_DIR, `wallet-${chain}.json`);
}

function readKeystore(chain: Chain): Keystore | null {
  const path = keystorePath(chain);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Keystore;
}

export function providerFor(chain: Chain): RpcProvider {
  const headers = process.env.RPC_API_KEY
    ? { Authorization: `Bearer ${process.env.RPC_API_KEY}` }
    : undefined;
  return new RpcProvider({ nodeUrl: rpcUrlFor(chain), ...(headers && { headers }) });
}

export interface ResolvedSigner {
  account: Account;
  address: string;
  source: "env" | "sncast" | "keystore";
  /** sncast account name, when source is "sncast". */
  name?: string;
}

/** Precedence: raw env credentials > SNCAST_ACCOUNT > generated keystore. */
export function resolveSigner(chain: Chain): ResolvedSigner | null {
  const provider = providerFor(chain);
  const envKey = process.env.STARKNET_PRIVATE_KEY;
  const envAddress = process.env.STARKNET_ACCOUNT_ADDRESS;
  if (envKey && envAddress) {
    return {
      account: new Account({ provider, address: envAddress, signer: envKey }),
      address: envAddress,
      source: "env",
    };
  }
  const sncast = resolveSncastAccount(chain);
  if (sncast) {
    return {
      account: new Account({ provider, address: sncast.address, signer: sncast.privateKey }),
      address: sncast.address,
      source: "sncast",
      name: sncast.name,
    };
  }
  const ks = readKeystore(chain);
  if (ks) {
    return {
      account: new Account({ provider, address: ks.address, signer: ks.privateKey }),
      address: ks.address,
      source: "keystore",
    };
  }
  return null;
}

export function generateWallet(chain: Chain): { address: string; path: string; alreadyExisted: boolean } {
  const existing = readKeystore(chain);
  if (existing) {
    return { address: existing.address, path: keystorePath(chain), alreadyExisted: true };
  }
  const privateKey = stark.randomAddress();
  const publicKey = ec.starkCurve.getStarkKey(privateKey);
  const address = hash.calculateContractAddressFromHash(
    publicKey, // salt
    OZ_ACCOUNT_CLASS_HASH,
    [publicKey],
    0,
  );
  mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
  const path = keystorePath(chain);
  writeFileSync(path, JSON.stringify({ privateKey, publicKey, address, classHash: OZ_ACCOUNT_CLASS_HASH }, null, 2));
  chmodSync(path, 0o600);
  return { address, path, alreadyExisted: false };
}

export async function isDeployed(chain: Chain, address: string): Promise<boolean> {
  try {
    await providerFor(chain).getClassHashAt(address, "latest");
    return true;
  } catch {
    return false;
  }
}

export async function erc20Balance(chain: Chain, token: string, owner: string): Promise<bigint> {
  const res = await providerFor(chain).callContract(
    { contractAddress: token, entrypoint: "balance_of", calldata: [owner] },
    "latest",
  );
  return uint256.uint256ToBN({ low: res[0]!, high: res[1]! });
}

/** Deploy the generated keystore wallet (requires the address to be funded with STRK). */
export async function deployWallet(chain: Chain): Promise<{ address: string; txHash: string }> {
  const ks = readKeystore(chain);
  if (!ks) throw new Error(`No generated wallet for ${chain} — run generate_wallet first.`);
  if (await isDeployed(chain, ks.address)) {
    return { address: ks.address, txHash: "(already deployed)" };
  }
  const provider = providerFor(chain);
  const account = new Account({ provider, address: ks.address, signer: ks.privateKey });
  const { transaction_hash } = await account.deployAccount(
    {
      classHash: ks.classHash,
      constructorCalldata: [ks.publicKey],
      addressSalt: ks.publicKey,
      contractAddress: ks.address,
    },
    TX_DETAILS,
  );
  await provider.waitForTransaction(transaction_hash);
  return { address: ks.address, txHash: transaction_hash };
}
