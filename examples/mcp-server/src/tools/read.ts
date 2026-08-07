// Read-only tools: everything here is a plain indexer/RPC read via the
// Budokan and Denshokan SDK clients — no wallet needed.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAllowlistProof,
  getWhitelistedGames,
  getGameDefaults,
  tournamentPageUrl,
  type Tournament,
  recommendDistribution,
  validateDistributionSpec,
  exactPayouts,
  type CurveStyle,
  type DistributionSpec,
} from "@provable-games/budokan-sdk";
import { budokanClient, denshokanClient } from "../clients.ts";
import { formatToolError } from "../format-error.ts";
import { resolveChain, type Chain } from "../config.ts";
import { tokensForChain } from "../tokens.ts";

export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${formatToolError(error)}` }],
    isError: true,
  };
}

const chainParam = z
  .enum(["mainnet", "sepolia"])
  .optional()
  .describe("Starknet network (defaults to BUDOKAN_CHAIN env or mainnet)");

/** Trim the wide Tournament row to what an agent actually needs. */
function tournamentView(chain: Chain, t: Tournament) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    url: tournamentPageUrl(chain, t.id),
    gameAddress: t.gameAddress,
    createdBy: t.createdBy,
    phase: t.phase,
    settingsId: t.settingsId,
    registrationStartTime: t.registrationStartTime,
    registrationEndTime: t.registrationEndTime,
    gameStartTime: t.gameStartTime,
    gameEndTime: t.gameEndTime,
    submissionEndTime: t.submissionEndTime,
    entryFeeToken: t.entryFeeToken,
    entryFeeAmount: t.entryFeeAmount,
    entryRequirement: t.entryRequirement,
    entryCount: t.entryCount,
    prizeCount: t.prizeCount,
    submissionCount: t.submissionCount,
    paidPlaces: t.paidPlaces,
  };
}

export function registerReadTools(server: McpServer) {
  server.registerTool(
    "list_tournaments",
    {
      title: "List tournaments",
      description:
        "List Budokan tournaments, optionally filtered by game address or phase " +
        "(scheduled | registration | staging | live | submission | finalized). Paginated.",
      inputSchema: {
        chain: chainParam,
        gameAddress: z.string().optional().describe("Filter by game contract address"),
        phase: z
          .enum(["scheduled", "registration", "staging", "live", "submission", "finalized"])
          .optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Page size, default 10"),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ chain: chainArg, gameAddress, phase, limit, offset }) => {
      try {
        const chain = resolveChain(chainArg);
        const result = await budokanClient(chain).getTournaments({
          gameAddress,
          phase,
          limit: limit ?? 10,
          offset,
          sort: "created_at",
        });
        return jsonResult({
          total: result.total,
          tournaments: result.data.map((t) => tournamentView(chain, t)),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_tournament",
    {
      title: "Get tournament",
      description: "Fetch one tournament by id: schedule, phase, entry fee, entry counts, page URL.",
      inputSchema: { chain: chainParam, tournamentId: z.string().describe("Tournament id (decimal string)") },
    },
    async ({ chain: chainArg, tournamentId }) => {
      try {
        const chain = resolveChain(chainArg);
        const t = await budokanClient(chain).getTournament(tournamentId);
        if (!t) return jsonResult({ found: false, tournamentId });
        return jsonResult(tournamentView(chain, t));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_leaderboard",
    {
      title: "Get leaderboard",
      description: "Current leaderboard (submitted scores, best first) for a tournament.",
      inputSchema: { chain: chainParam, tournamentId: z.string() },
    },
    async ({ chain: chainArg, tournamentId }) => {
      try {
        const chain = resolveChain(chainArg);
        const entries = await budokanClient(chain).getTournamentLeaderboard(tournamentId);
        return jsonResult(entries);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_prizes",
    {
      title: "Get prizes",
      description: "Sponsored prizes escrowed for a tournament.",
      inputSchema: { chain: chainParam, tournamentId: z.string() },
    },
    async ({ chain: chainArg, tournamentId }) => {
      try {
        const chain = resolveChain(chainArg);
        const prizes = await budokanClient(chain).getTournamentPrizes(tournamentId);
        return jsonResult(prizes);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_games",
    {
      title: "List games",
      description:
        "Whitelisted games tournaments can be created for, with per-game defaults " +
        "(leaderboard ordering, recommended entry-fee token, game-creator fee share). " +
        "Also lists the known entry-fee tokens for the chain.",
      inputSchema: { chain: chainParam },
    },
    async ({ chain: chainArg }) => {
      try {
        const chain = resolveChain(chainArg);
        const games = getWhitelistedGames(chain)
          .filter((g) => !g.disabled)
          .map((g) => ({
            name: g.name,
            contractAddress: g.contractAddress,
            url: g.url,
            controllerOnly: g.controllerOnly ?? false,
            minEntryFeeUsd: g.minEntryFeeUsd,
            defaults: getGameDefaults(chain, g.contractAddress),
          }));
        return jsonResult({ games, knownTokens: tokensForChain(chain) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "check_allowlist",
    {
      title: "Check allowlist",
      description:
        "Check whether an address is on a merkle allowlist (by treeId from create_allowlist) " +
        "and can enter tournaments gated on it. Returns the entry proof when allowlisted.",
      inputSchema: {
        chain: chainParam,
        treeId: z.number().int().min(0),
        address: z.string().describe("Starknet address to check"),
      },
    },
    async ({ chain: chainArg, treeId, address }) => {
      try {
        const chain = resolveChain(chainArg);
        const proof = await getAllowlistProof({ chain, treeId, address });
        return jsonResult({ allowlisted: true, treeId, address, proof });
      } catch (error) {
        // metagame-sdk throws "<addr> is not on the merkle allowlist for
        // tree <id>" for a genuine 404; service failures throw different
        // messages and should surface as errors, not as allowlisted=false.
        const message = error instanceof Error ? error.message : String(error);
        if (/is not on the merkle allowlist/i.test(message)) {
          return jsonResult({ allowlisted: false, treeId, address, detail: message });
        }
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_game_settings",
    {
      title: "List game settings",
      description:
        "Registered settings presets for a game (settings_id values usable in create_tournament). " +
        "Budokan validates the id against the game's registered settings at create time, so " +
        "always pick an id from this list — 0 is only valid if the game registered it.",
      inputSchema: {
        chain: chainParam,
        gameAddress: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ chain: chainArg, gameAddress, limit, offset }) => {
      try {
        const chain = resolveChain(chainArg);
        const result = await denshokanClient(chain).getSettings({
          gameAddress,
          limit: limit ?? 10,
          offset,
        });
        return jsonResult({
          total: result.total,
          settings: result.data.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            settings: s.settings,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "preview_payouts",
    {
      title: "Preview a payout structure",
      description:
        "Pure calculator — no chain access. Given a payout style (or an explicit curve) and the " +
        "number of paid places, returns the exact per-place split the contract will settle: " +
        "percentages, and precise token amounts when a pool size is supplied. Call this BEFORE " +
        "create_tournament to show the user the split and iterate until it matches their intent. " +
        "Styles: equal (everyone the same), gentle (~2x first vs last), balanced (clear podium, " +
        "good default), topHeavy (~30% to 1st at any size), winnerTakesMost (~50% to 1st). The " +
        "engine picks the on-chain curve for the field size automatically; amounts equal what " +
        "claims will actually transfer, to the wei.",
      inputSchema: {
        winnersCount: z.number().int().min(1).max(10000).describe("Paid places"),
        payoutStyle: z
          .enum(["equal", "gentle", "balanced", "topHeavy", "winnerTakesMost"])
          .optional()
          .describe("Intent style (recommended). Omit only when giving customWeights."),
        customWeights: z
          .array(z.number().min(0).max(100))
          .optional()
          .describe(
            "Exact per-place percentages, best-to-worst, summing to 100 — for hand-authored splits",
          ),
        poolAmount: z
          .string()
          .optional()
          .describe("Optional pool size in smallest token units to get exact per-place amounts"),
      },
    },
    async ({ winnersCount, payoutStyle, customWeights, poolAmount }) => {
      try {
        const spec: DistributionSpec = customWeights
          ? { kind: "custom", weights: customWeights.map((p) => Math.round(p * 100)) }
          : recommendDistribution((payoutStyle ?? "balanced") as CurveStyle, winnersCount);
        const validation = validateDistributionSpec(
          spec,
          winnersCount,
          poolAmount !== undefined ? BigInt(poolAmount) : undefined,
        );
        if (!validation.ok) {
          return jsonResult({ valid: false, errors: validation.errors, resolvedCurve: spec });
        }
        const SCALE = 1_000_000_000_000n;
        const shares = exactPayouts(spec, winnersCount, SCALE);
        const percentages = shares.map((v) => Number((v * 10000n) / SCALE) / 100);
        const amounts =
          poolAmount !== undefined
            ? exactPayouts(spec, winnersCount, BigInt(poolAmount)).map(String)
            : undefined;
        return jsonResult({
          valid: true,
          resolvedCurve: spec,
          note:
            "resolvedCurve is the on-chain variant chosen for this field size — creators never " +
            "need to pick it; pass the same payoutStyle to create_tournament.",
          percentages,
          ...(amounts ? { amounts } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
