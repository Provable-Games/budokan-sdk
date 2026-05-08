// Multi-turn /create state machine. Each chat can have at most one in-flight
// create flow at a time. State is in-memory only; restart loses it (the user
// just runs /create again).
//
// The form is the "minimal" tournament create:
//   - metadata (name + description)
//   - game_config (address, settings_id, soulbound=false, paymaster=false)
//   - schedule (5 timing fields, asked as durations the user can grok)
//   - leaderboard_config (ascending, game_must_be_over)
//   - entry_fee = None, entry_requirement = None  (defaults)
//   - salt = 0, metadata_value = 0
//
// Free-form text from the user advances the current step; the dispatcher in
// telegram.ts checks isPending(chatId) before falling through to commands.

import type { Config } from "../config.ts";
import type { TelegramApi } from "../telegram-api.ts";
import { buildCreateTournamentCall, type CreateTournamentArgs } from "../budokan-calls.ts";
import { resolveAccount } from "../controller-account.ts";
import { CHAINS } from "@provable-games/budokan-sdk";

type Step =
  | "name"
  | "description"
  | "gameAddress"
  | "settingsId"
  | "regStartHours"
  | "regDurationHours"
  | "stagingHours"
  | "gameDurationHours"
  | "submissionHours"
  | "leaderboardAscending"
  | "gameMustBeOver"
  | "confirm";

interface State {
  step: Step;
  // Filled in as the user answers; types are normalized at parse time.
  name?: string;
  description?: string;
  gameAddress?: string;
  settingsId?: number;
  regStartSeconds?: number;
  regDurationSeconds?: number;
  stagingSeconds?: number;
  gameDurationSeconds?: number;
  submissionSeconds?: number;
  leaderboardAscending?: boolean;
  gameMustBeOver?: boolean;
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

/** Kick off a fresh /create flow. Replies via api. */
export async function start(api: TelegramApi, chatId: string): Promise<void> {
  states.set(chatId, { step: "name" });
  await api.sendMessage(
    chatId,
    [
      "Let's create a tournament. I'll ask one thing at a time. /cancel to abort.",
      "",
      "Tournament name? (≤31 characters, ASCII)",
    ].join("\n"),
  );
}

/** Process a user's free-form answer to the current step. */
export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  const trimmed = text.trim();

  switch (state.step) {
    case "name": {
      if (trimmed.length === 0 || trimmed.length > 31) {
        await api.sendMessage(chatId, "Name must be 1–31 characters. Try again, or /cancel.");
        return;
      }
      // ASCII only — felt252 short strings can't carry multi-byte UTF-8.
      if (!/^[\x20-\x7e]+$/.test(trimmed)) {
        await api.sendMessage(chatId, "Name must be plain ASCII (no emojis or accents). Try again.");
        return;
      }
      state.name = trimmed;
      state.step = "description";
      await api.sendMessage(chatId, "Description? (free text, or send 'skip')");
      return;
    }
    case "description": {
      state.description = /^skip$/i.test(trimmed) ? "" : trimmed;
      state.step = "gameAddress";
      await api.sendMessage(
        chatId,
        "Game contract address? (0x-prefixed Starknet address — the game your tournament uses)",
      );
      return;
    }
    case "gameAddress": {
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
        await api.sendMessage(chatId, "That doesn't look like a Starknet address. Try again.");
        return;
      }
      state.gameAddress = trimmed.toLowerCase();
      state.step = "settingsId";
      await api.sendMessage(chatId, "Game settings ID? (integer; send 0 if you don't have one)");
      return;
    }
    case "settingsId": {
      const n = parseUint(trimmed);
      if (n === null) {
        await api.sendMessage(chatId, "Must be a non-negative integer. Try again.");
        return;
      }
      state.settingsId = n;
      state.step = "regStartHours";
      await api.sendMessage(
        chatId,
        "When does registration open? Send 'now' or a duration like '2h', '30m', '1d'.",
      );
      return;
    }
    case "regStartHours": {
      const seconds = parseDuration(trimmed, /*allowNow*/ true);
      if (seconds === null) {
        await api.sendMessage(chatId, "Couldn't parse that. Examples: 'now', '2h', '30m', '1d'. Try again.");
        return;
      }
      state.regStartSeconds = seconds;
      state.step = "regDurationHours";
      await api.sendMessage(chatId, "How long is registration open? (e.g. '24h', '7d')");
      return;
    }
    case "regDurationHours": {
      const seconds = parseDuration(trimmed);
      if (seconds === null || seconds <= 0) {
        await api.sendMessage(chatId, "Must be a positive duration. Try again.");
        return;
      }
      state.regDurationSeconds = seconds;
      state.step = "stagingHours";
      await api.sendMessage(
        chatId,
        "Buffer between registration close and game start? (e.g. '1h', or '0' for none)",
      );
      return;
    }
    case "stagingHours": {
      const seconds = parseDuration(trimmed, /*allowNow*/ true);
      if (seconds === null) {
        await api.sendMessage(chatId, "Couldn't parse that. Try '0', '1h', etc.");
        return;
      }
      state.stagingSeconds = seconds;
      state.step = "gameDurationHours";
      await api.sendMessage(chatId, "How long is the live game? (e.g. '24h', '7d')");
      return;
    }
    case "gameDurationHours": {
      const seconds = parseDuration(trimmed);
      if (seconds === null || seconds <= 0) {
        await api.sendMessage(chatId, "Must be positive. Try again.");
        return;
      }
      state.gameDurationSeconds = seconds;
      state.step = "submissionHours";
      await api.sendMessage(
        chatId,
        "How long is the submission window after the game ends? (e.g. '24h')",
      );
      return;
    }
    case "submissionHours": {
      const seconds = parseDuration(trimmed);
      if (seconds === null || seconds <= 0) {
        await api.sendMessage(chatId, "Must be positive. Try again.");
        return;
      }
      state.submissionSeconds = seconds;
      state.step = "leaderboardAscending";
      await api.sendMessage(
        chatId,
        "Leaderboard sort: do lower scores win? (yes / no)\n(yes for golf-style; no for points-style)",
      );
      return;
    }
    case "leaderboardAscending": {
      const b = parseYesNo(trimmed);
      if (b === null) {
        await api.sendMessage(chatId, "Send 'yes' or 'no'.");
        return;
      }
      state.leaderboardAscending = b;
      state.step = "gameMustBeOver";
      await api.sendMessage(
        chatId,
        "Must the game be finished before a player can submit a score? (yes / no)",
      );
      return;
    }
    case "gameMustBeOver": {
      const b = parseYesNo(trimmed);
      if (b === null) {
        await api.sendMessage(chatId, "Send 'yes' or 'no'.");
        return;
      }
      state.gameMustBeOver = b;
      state.step = "confirm";
      await api.sendMessage(chatId, formatSummary(state) + "\n\nReply 'create' to submit, or /cancel.");
      return;
    }
    case "confirm": {
      if (!/^create$/i.test(trimmed)) {
        await api.sendMessage(chatId, "Reply 'create' to submit, or /cancel.");
        return;
      }
      states.delete(chatId);
      await execute(api, config, chatId, state);
      return;
    }
  }
}

async function execute(api: TelegramApi, config: Config, chatId: string, state: State): Promise<void> {
  // The session must still be valid + cover create_tournament.
  const result = await resolveAccount(chatId, config);
  if (!result.ok) {
    await api.sendMessage(
      chatId,
      result.reason === "no_session"
        ? "Not connected — run /connect first."
        : "Your session has expired or doesn't cover this action. Run /connect again.",
    );
    return;
  }

  const budokanAddress = config.budokanAddress ?? CHAINS[config.chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, "Internal error: no Budokan address configured for this chain.");
    return;
  }

  const args: CreateTournamentArgs = {
    creatorRewardsAddress: result.data.address,
    name: state.name!,
    description: state.description ?? "",
    gameAddress: state.gameAddress!,
    settingsId: state.settingsId!,
    schedule: {
      registrationStartDelay: state.regStartSeconds!,
      registrationEndDelay: state.regStartSeconds! + state.regDurationSeconds!,
      gameStartDelay: state.regStartSeconds! + state.regDurationSeconds! + state.stagingSeconds!,
      gameEndDelay: state.regStartSeconds! + state.regDurationSeconds! + state.stagingSeconds! + state.gameDurationSeconds!,
      submissionDuration: state.submissionSeconds!,
    },
    leaderboard: {
      ascending: state.leaderboardAscending!,
      gameMustBeOver: state.gameMustBeOver!,
    },
  };

  const call = buildCreateTournamentCall(budokanAddress, args);

  await api.sendMessage(chatId, "Submitting transaction…");
  try {
    const tx = await result.data.account.execute([call]);
    await api.sendMessage(
      chatId,
      [
        `Tournament submitted ✓`,
        `tx: ${tx.transaction_hash}`,
        "",
        "It will appear in /tournaments once the indexer catches up.",
      ].join("\n"),
    );
  } catch (error) {
    await api.sendMessage(
      chatId,
      `Tournament creation failed: ${formatError(error)}`,
    );
  }
}

function formatSummary(s: State): string {
  return [
    "Ready to create:",
    `  Name: ${s.name}`,
    `  Description: ${s.description || "(none)"}`,
    `  Game: ${s.gameAddress}`,
    `  Settings ID: ${s.settingsId}`,
    `  Registration opens: in ${formatDuration(s.regStartSeconds!)}`,
    `  Registration window: ${formatDuration(s.regDurationSeconds!)}`,
    `  Staging buffer: ${formatDuration(s.stagingSeconds!)}`,
    `  Live game: ${formatDuration(s.gameDurationSeconds!)}`,
    `  Submission window: ${formatDuration(s.submissionSeconds!)}`,
    `  Lower scores win: ${s.leaderboardAscending ? "yes" : "no"}`,
    `  Require game over: ${s.gameMustBeOver ? "yes" : "no"}`,
  ].join("\n");
}

// "now" → 0; "2h" → 7200; "30m" → 1800; "1d" → 86400; "90s" → 90; "1h30m" not supported
function parseDuration(input: string, allowNow = false): number | null {
  const t = input.trim().toLowerCase();
  if (allowNow && (t === "now" || t === "0")) return 0;
  const match = t.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    // bare number → seconds
    if (/^\d+$/.test(t)) return Number(t);
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const mul = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return value * mul;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "now";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseYesNo(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (["y", "yes", "true"].includes(t)) return true;
  if (["n", "no", "false"].includes(t)) return false;
  return null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
