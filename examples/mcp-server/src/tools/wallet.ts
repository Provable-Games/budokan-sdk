// Wallet lifecycle tools. Private keys never appear in tool inputs or
// outputs — generate_wallet writes the key to a 0600 keystore file and
// returns only the address; users bringing their own key set it via env
// vars on the server process, outside the model's context.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveChain } from "../config.ts";
import {
  deployWallet,
  erc20Balance,
  ETH_ADDRESS,
  generateWallet,
  isDeployed,
  listSncastAccounts,
  resolveSigner,
  STRK_ADDRESS,
} from "../wallet.ts";
import { fromRawAmount } from "../tokens.ts";
import { errorResult, jsonResult } from "./read.ts";

const chainParam = z
  .enum(["mainnet", "sepolia"])
  .optional()
  .describe("Starknet network (defaults to BUDOKAN_CHAIN env or mainnet)");

export function registerWalletTools(server: McpServer) {
  server.registerTool(
    "wallet_status",
    {
      title: "Wallet status",
      description:
        "Show the signing wallet the server will use: address, where it came from " +
        "(env vars or generated keystore), whether the account contract is deployed, " +
        "and its STRK/ETH balances. Transactions pay fees in STRK.",
      inputSchema: { chain: chainParam },
    },
    async ({ chain: chainArg }) => {
      try {
        const chain = resolveChain(chainArg);
        const signer = resolveSigner(chain);
        if (!signer) {
          const sncastAccounts = listSncastAccounts(chain);
          return jsonResult({
            configured: false,
            ...(sncastAccounts.length > 0 && {
              sncastAccountsAvailable: sncastAccounts,
              hint: `Found sncast (Starknet Foundry) accounts for ${chain} — set SNCAST_ACCOUNT=<name> in the MCP server's environment to sign with one of them.`,
            }),
            howToConfigure:
              "Configure a signer in the MCP server's environment (never paste keys into chat): " +
              "SNCAST_ACCOUNT=<name> to reuse a Starknet Foundry account from " +
              "~/.starknet_accounts/, or STARKNET_PRIVATE_KEY + STARKNET_ACCOUNT_ADDRESS " +
              "for a raw key. Alternatively call generate_wallet for a fresh dev wallet.",
          });
        }
        const [deployed, strk, eth] = await Promise.all([
          isDeployed(chain, signer.address),
          erc20Balance(chain, STRK_ADDRESS, signer.address),
          erc20Balance(chain, ETH_ADDRESS, signer.address),
        ]);
        return jsonResult({
          configured: true,
          chain,
          address: signer.address,
          source: signer.source,
          ...(signer.name && { sncastAccountName: signer.name }),
          deployed,
          balances: { STRK: fromRawAmount(strk, 18), ETH: fromRawAmount(eth, 18) },
          ...(deployed
            ? {}
            : {
                nextStep:
                  signer.source === "keystore"
                    ? strk > 0n
                      ? "Account is funded but not deployed — call deploy_wallet."
                      : "Fund this address with STRK (for fees), then call deploy_wallet."
                    : signer.source === "sncast"
                      ? "Account contract not deployed — fund it with STRK, then run `sncast account deploy` (deploy_wallet only handles generated wallets)."
                      : "Account contract not deployed on this chain — deploy it with your wallet tooling (deploy_wallet only handles generated wallets).",
              }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "generate_wallet",
    {
      title: "Generate dev wallet",
      description:
        "Generate a fresh dev wallet (OpenZeppelin account) for signing Budokan transactions. " +
        "The private key is stored in a keystore file on the server machine and is never " +
        "returned. Fund the returned address with STRK, then call deploy_wallet. " +
        "No-op if a wallet was already generated for this chain. " +
        "Note: env STARKNET_PRIVATE_KEY/STARKNET_ACCOUNT_ADDRESS take precedence when set.",
      inputSchema: { chain: chainParam },
    },
    async ({ chain: chainArg }) => {
      try {
        const chain = resolveChain(chainArg);
        const result = generateWallet(chain);
        return jsonResult({
          chain,
          address: result.address,
          keystoreFile: result.path,
          alreadyExisted: result.alreadyExisted,
          nextSteps: [
            `Send STRK to ${result.address} on ${chain} to cover deployment + transaction fees (a few STRK is plenty to start).`,
            "Call deploy_wallet to deploy the account contract.",
            "Then create_tournament / add_prize will sign with this wallet.",
          ],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "deploy_wallet",
    {
      title: "Deploy dev wallet",
      description:
        "Deploy the generated dev wallet's account contract (DEPLOY_ACCOUNT). " +
        "The address must already hold STRK for fees.",
      inputSchema: { chain: chainParam },
    },
    async ({ chain: chainArg }) => {
      try {
        const chain = resolveChain(chainArg);
        const result = await deployWallet(chain);
        return jsonResult({ chain, ...result });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
