// Signed-action tools: create_tournament and add_prize. Calldata comes
// entirely from the SDK's pure builders; this file only resolves friendly
// inputs (token symbols, human amounts, schedule durations) and signs with
// the account from wallet.ts.
//
// Every write tool takes `dryRun` — build and return the exact calls
// without broadcasting — so agents can show a human the transaction before
// spending anything.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAddPrizeCall,
  buildCreateTournamentCall,
  buildErc20ApproveCall,
  buildMerkleConfig,
  buildRegisterAllowlistTreeCall,
  explorerTxUrl,
  extensionAddressFor,
  getGameDefaults,
  parseAllowlistTreeId,
  parseTournamentIdFromReceipt,
  storeAllowlistTree,
  tournamentPageUrl,
  type Call,
  type CreateTournamentArgs,
  type DistributionSpec,
  type EntryFeeArgs,
  type EntryRequirementArgs,
} from "@provable-games/budokan-sdk";
import { chainConfig, resolveChain, type Chain } from "../config.ts";
import { providerFor, resolveSigner, TX_DETAILS, type ResolvedSigner } from "../wallet.ts";
import { resolveToken, toRawAmount } from "../tokens.ts";
import { errorResult, jsonResult } from "./read.ts";

const chainParam = z
  .enum(["mainnet", "sepolia"])
  .optional()
  .describe("Starknet network (defaults to BUDOKAN_CHAIN env or mainnet)");

function requireSigner(chain: Chain): ResolvedSigner {
  const signer = resolveSigner(chain);
  if (!signer) {
    throw new Error(
      `No signing account configured for ${chain}. Set SNCAST_ACCOUNT=<name> (Starknet ` +
        `Foundry accounts file) or STARKNET_PRIVATE_KEY + STARKNET_ACCOUNT_ADDRESS in the ` +
        `server's environment, or call generate_wallet then fund + deploy_wallet.`,
    );
  }
  return signer;
}

async function executeCalls(
  chain: Chain,
  signer: ResolvedSigner,
  calls: Call[],
): Promise<{ txHash: string; receipt: unknown }> {
  const tx = await signer.account.execute(calls, TX_DETAILS);
  const receipt = await providerFor(chain).waitForTransaction(tx.transaction_hash);
  return { txHash: tx.transaction_hash, receipt };
}

const distributionParam = z
  .enum(["exponential", "linear", "uniform"])
  .optional()
  .describe("How the pool splits across winners (default exponential)");

function buildDistribution(kind: string | undefined, weight: number | undefined): DistributionSpec {
  if (kind === "uniform") return { kind: "uniform" };
  if (kind === "linear") return { kind: "linear", weight: weight ?? 1 };
  return { kind: "exponential", weight: weight ?? 1 };
}

export function registerWriteTools(server: McpServer) {
  server.registerTool(
    "create_tournament",
    {
      title: "Create tournament",
      description:
        "Create a Budokan tournament on-chain (signed by the configured wallet). " +
        "Times are durations in seconds from now. registrationSeconds=0 creates an " +
        "'open' tournament where players can join throughout play. Use list_games for " +
        "game addresses/defaults and list_game_settings for settings ids. " +
        "Defining an entry fee moves no funds at create time (entrants pay it). " +
        "Set dryRun=true to preview the calldata without sending a transaction.",
      inputSchema: {
        chain: chainParam,
        name: z.string().min(1).max(31).describe("Tournament name (max 31 ASCII characters)"),
        description: z.string().optional().describe("Longer description shown on budokan.gg"),
        gameAddress: z.string().describe("Game contract address (see list_games)"),
        settingsId: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Game settings preset id — MUST be one the game registered (see list_game_settings); " +
              "the contract rejects unknown ids. Defaults to 0, which not all games accept",
          ),
        registrationDelaySeconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Delay before registration opens (default 0 = opens immediately)"),
        registrationSeconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Registration window length. 0 (default) = open tournament, join any time during play"),
        stagingSeconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Gap between registration close and play start (default 0)"),
        playSeconds: z.number().int().min(60).describe("How long the play window lasts"),
        submissionSeconds: z
          .number()
          .int()
          .min(60)
          .optional()
          .describe("Score-submission window after play ends (default 86400 = 24h)"),
        leaderboardAscending: z
          .boolean()
          .optional()
          .describe("true = lower score wins. Default inherited from the game's metadata"),
        gameMustBeOver: z
          .boolean()
          .optional()
          .describe("Require the game run to be finished before submitting. Default from game metadata"),
        entryFee: z
          .object({
            token: z.string().describe("Token symbol (STRK, ETH, USDC, LORDS…) or 0x address"),
            amount: z.string().describe("Entry fee per player in human units, e.g. '5' or '0.25'"),
            winnersCount: z.number().int().min(1).optional().describe("Top placements sharing the pool (default 10)"),
            distribution: distributionParam,
            distributionWeight: z.number().int().min(1).optional(),
            tournamentCreatorShareBps: z
              .number()
              .int()
              .min(0)
              .max(10000)
              .optional()
              .describe("Your cut in basis points (default 0)"),
            gameCreatorShareBps: z
              .number()
              .int()
              .min(0)
              .max(10000)
              .optional()
              .describe("Game creator's cut in bps. Default: the game's whitelisted fee percentage"),
            refundShareBps: z.number().int().min(0).max(10000).optional().describe("Refund share for non-placers (default 0)"),
          })
          .optional()
          .describe("Optional paid entry. Omit for a free tournament"),
        gatingTokenAddress: z
          .string()
          .optional()
          .describe("Optional token-gate: entrants must own a token from this NFT contract"),
        gatingAllowlistTreeId: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Optional allowlist-gate: merkle tree id from create_allowlist. Only allowlisted " +
              "addresses can enter (mutually exclusive with gatingTokenAddress)",
          ),
        gatingEntryLimit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Max entries per qualifying token/address (0 = unlimited, default 0)"),
        dryRun: z.boolean().optional().describe("Build and return calldata without broadcasting"),
      },
    },
    async (input) => {
      try {
        const chain = resolveChain(input.chain);
        const signer = requireSigner(chain);
        const { budokanAddress } = chainConfig(chain);
        const defaults = getGameDefaults(chain, input.gameAddress);

        let entryFee: EntryFeeArgs | undefined;
        if (input.entryFee) {
          const token = await resolveToken(chain, input.entryFee.token);
          entryFee = {
            tokenAddress: token.address,
            amount: toRawAmount(input.entryFee.amount, token.decimals),
            tournamentCreatorShare: input.entryFee.tournamentCreatorShareBps ?? 0,
            gameCreatorShare:
              input.entryFee.gameCreatorShareBps ?? defaults.defaultGameFeePercentage * 100,
            refundShare: input.entryFee.refundShareBps ?? 0,
            distribution: buildDistribution(
              input.entryFee.distribution,
              input.entryFee.distributionWeight,
            ),
            distributionCount: input.entryFee.winnersCount ?? 10,
          };
        }

        if (input.gatingTokenAddress && input.gatingAllowlistTreeId !== undefined) {
          throw new Error("gatingTokenAddress and gatingAllowlistTreeId are mutually exclusive.");
        }
        let entryRequirement: EntryRequirementArgs | undefined;
        if (input.gatingTokenAddress) {
          entryRequirement = {
            entryLimit: input.gatingEntryLimit ?? 0,
            type: { kind: "token", tokenAddress: input.gatingTokenAddress },
          };
        } else if (input.gatingAllowlistTreeId !== undefined) {
          entryRequirement = {
            entryLimit: input.gatingEntryLimit ?? 0,
            type: {
              kind: "extension",
              address: extensionAddressFor(chain, "merkle"),
              config: buildMerkleConfig({ treeId: input.gatingAllowlistTreeId }),
            },
          };
        }

        const regStart = input.registrationDelaySeconds ?? 0;
        const regDuration = input.registrationSeconds ?? 0;
        const staging = input.stagingSeconds ?? 0;
        const args: CreateTournamentArgs = {
          creatorRewardsAddress: signer.address,
          name: input.name,
          description: input.description ?? "",
          gameAddress: input.gameAddress,
          settingsId: input.settingsId ?? 0,
          schedule: {
            registrationStartDelay: regStart,
            registrationEndDelay: regStart + regDuration,
            gameStartDelay: regStart + regDuration + staging,
            gameEndDelay: regStart + regDuration + staging + input.playSeconds,
            submissionDuration: input.submissionSeconds ?? 86400,
          },
          leaderboard: {
            ascending: input.leaderboardAscending ?? defaults.leaderboardAscending,
            gameMustBeOver: input.gameMustBeOver ?? defaults.leaderboardGameMustBeOver,
          },
          entryFee,
          entryRequirement,
        };

        const call = buildCreateTournamentCall(budokanAddress, args);
        if (input.dryRun) {
          return jsonResult({ dryRun: true, signerAddress: signer.address, args, call });
        }

        const { txHash, receipt } = await executeCalls(chain, signer, [call]);
        const tournamentId = parseTournamentIdFromReceipt(
          receipt as Parameters<typeof parseTournamentIdFromReceipt>[0],
          budokanAddress,
        );
        return jsonResult({
          tournamentId: tournamentId?.toString(),
          url: tournamentId ? tournamentPageUrl(chain, tournamentId.toString()) : undefined,
          txHash,
          explorerUrl: explorerTxUrl(chain, txHash),
          note:
            "The tournament may take a minute to appear on budokan.gg while the indexer catches up.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "create_allowlist",
    {
      title: "Create allowlist",
      description:
        "Register an address allowlist (e.g. a holder/participant snapshot) as a merkle tree " +
        "on the deployed merkle validator, and store it in the merkle API so entrants get " +
        "proofs automatically on budokan.gg. Returns a treeId — pass it as " +
        "gatingAllowlistTreeId to create_tournament to make the tournament allowlist-only. " +
        "Trees are registered separately from tournaments and can be reused across many. " +
        "Set dryRun=true to preview the registration call.",
      inputSchema: {
        chain: chainParam,
        name: z.string().min(1).describe("Allowlist name (shown in the merkle API)"),
        description: z.string().optional(),
        addresses: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "Starknet addresses allowed to enter, all sharing the same entriesPerAddress " +
              "allowance. Provide either this or `entries`. Deduplicated and normalized " +
              "automatically. Very large snapshots may exceed transaction size limits — " +
              "thousands, not millions",
          ),
        entriesPerAddress: z
          .number()
          .int()
          .min(1)
          .max(2147483647)
          .optional()
          .describe(
            "Entry allowance baked into each leaf (default 1). Use 2147483647 (max) for " +
              "effectively unlimited entries — larger values fit the chain's u32 but break " +
              "the merkle proof API's storage. The validator applies " +
              "min(entriesPerAddress, tournament entryLimit) when entryLimit > 0, so keep " +
              "them consistent",
          ),
        entries: z
          .array(
            z.object({
              address: z.string(),
              count: z.number().int().min(1).max(2147483647),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Tiered allowlist: each address with its own entry allowance (e.g. whales 5, " +
              "everyone else 1). Alternative to addresses/entriesPerAddress. Leave the " +
              "tournament's gatingEntryLimit at 0 or the per-address counts get capped by it",
          ),
        dryRun: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const chain = resolveChain(input.chain);
        const signer = requireSigner(chain);
        if (!input.addresses && !input.entries) {
          throw new Error("Provide `addresses` (uniform allowance) or `entries` (tiered).");
        }
        const { call, entries } = buildRegisterAllowlistTreeCall({
          chain,
          addresses: input.addresses,
          entriesPerAddress: input.entriesPerAddress,
          entries: input.entries,
        });
        if (input.dryRun) {
          return jsonResult({
            dryRun: true,
            signerAddress: signer.address,
            uniqueAddresses: entries.length,
            call,
          });
        }
        const { txHash, receipt } = await executeCalls(chain, signer, [call]);
        const events = (receipt as { events?: unknown[] }).events ?? [];
        const treeId = parseAllowlistTreeId({ chain, events });
        if (treeId === null) {
          return jsonResult({
            txHash,
            explorerUrl: explorerTxUrl(chain, txHash),
            warning:
              "Tree registered but the tree id could not be parsed from the receipt — " +
              "check the transaction events on the explorer.",
          });
        }
        // Without this step the merkle API can't serve proofs, and allowlisted
        // players would be unable to enter via budokan.gg — surface loudly.
        let stored = true;
        let storeError: string | undefined;
        try {
          await storeAllowlistTree({
            chain,
            treeId,
            name: input.name,
            description: input.description ?? "",
            entries,
          });
        } catch (error) {
          stored = false;
          storeError = error instanceof Error ? error.message : String(error);
        }
        return jsonResult({
          treeId,
          uniqueAddresses: entries.length,
          txHash,
          explorerUrl: explorerTxUrl(chain, txHash),
          proofsStored: stored,
          ...(stored
            ? { usage: `Pass gatingAllowlistTreeId: ${treeId} to create_tournament.` }
            : {
                warning:
                  `Tree ${treeId} is registered on-chain but storing it in the merkle API ` +
                  `failed (${storeError}). Entrants cannot fetch proofs until it is stored — ` +
                  `retry create_allowlist with the same addresses is NOT safe (it would ` +
                  `register a new tree); store the entries manually instead.`,
              }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "add_prize",
    {
      title: "Add prize",
      description:
        "Sponsor an ERC-20 prize for a tournament. Sends one multicall: approve + add_prize " +
        "(this DOES transfer your tokens into escrow). Distributed prizes split across the top " +
        "winnersCount placements; single prizes pay one leaderboard position. " +
        "Set dryRun=true to preview without spending.",
      inputSchema: {
        chain: chainParam,
        tournamentId: z.string(),
        token: z.string().describe("Token symbol or 0x address"),
        amount: z.string().describe("Prize amount in human units, e.g. '100'"),
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Leaderboard position for a single winner-takes-all prize (omit when distributing)"),
        winnersCount: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Distribute across the top N placements (omit for a single-position prize)"),
        distribution: distributionParam,
        distributionWeight: z.number().int().min(1).optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async (input) => {
      try {
        const chain = resolveChain(input.chain);
        const signer = requireSigner(chain);
        const { budokanAddress } = chainConfig(chain);
        const token = await resolveToken(chain, input.token);
        const raw = toRawAmount(input.amount, token.decimals);

        const distributed = input.winnersCount !== undefined;
        const calls: Call[] = [
          buildErc20ApproveCall(token.address, budokanAddress, raw),
          buildAddPrizeCall(budokanAddress, {
            tournamentId: input.tournamentId,
            prize: {
              kind: "token",
              tokenAddress: token.address,
              tokenType: {
                kind: "erc20",
                amount: raw,
                ...(distributed
                  ? {
                      distribution: buildDistribution(input.distribution, input.distributionWeight),
                      distributionCount: input.winnersCount,
                    }
                  : {}),
              },
              ...(distributed ? {} : { position: input.position ?? 1 }),
            },
          }),
        ];

        if (input.dryRun) {
          return jsonResult({ dryRun: true, signerAddress: signer.address, calls });
        }
        const { txHash } = await executeCalls(chain, signer, calls);
        return jsonResult({ txHash, explorerUrl: explorerTxUrl(chain, txHash) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
