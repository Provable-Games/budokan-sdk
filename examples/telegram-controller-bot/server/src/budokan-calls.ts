// Build starknet.js Call objects for the Budokan entrypoints the bot
// actually invokes. Pure data — no signing, no execution. Each function
// returns calldata in the right shape for `account.execute([...])`.
//
// Cairo enum tags are 0-indexed in declaration order. References:
//   contracts/packages/interfaces/src/budokan.cairo
//   contracts/packages/interfaces/src/budokan.cairo (RewardType, EntryFeeRewardType)
//   game-components/.../prize.cairo (PrizeType)

import { CallData, num } from "starknet";

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

/** submit_score(tournament_id: u64, token_id: felt252, position: u32) */
export function buildSubmitScoreCall(
  budokanAddress: string,
  args: { tournamentId: string; tokenId: string; position: number },
): Call {
  return {
    contractAddress: budokanAddress,
    entrypoint: "submit_score",
    calldata: CallData.compile([
      args.tournamentId,
      args.tokenId,
      args.position,
    ]),
  };
}

/**
 * claim_reward(tournament_id: u64, reward_type: RewardType)
 *
 * RewardType is an enum:
 *   variant 0: Prize(PrizeType)
 *     PrizeType variant 0: Single(u64)
 *     PrizeType variant 1: Distributed((u64, u8))
 *   variant 1: EntryFee(EntryFeeRewardType)
 *     EntryFeeRewardType variant 0: Position(u32)
 *     EntryFeeRewardType variant 1: TournamentCreator
 *     EntryFeeRewardType variant 2: GameCreator
 *     EntryFeeRewardType variant 3: Refund(felt252)
 */
export type RewardType =
  | { kind: "prize_single"; prizeId: string }
  | { kind: "prize_distributed"; prizeId: string; payoutPosition: number }
  | { kind: "entry_fee_position"; position: number }
  | { kind: "entry_fee_tournament_creator" }
  | { kind: "entry_fee_game_creator" }
  | { kind: "entry_fee_refund"; tokenId: string };

export function buildClaimRewardCall(
  budokanAddress: string,
  args: { tournamentId: string; reward: RewardType },
): Call {
  // Hand-rolled enum encoding: outer tag, then inner tag, then payload.
  // CallData.compile flattens nested arrays, so we build the felt list directly.
  const calldata: string[] = [num.toHex(args.tournamentId)];
  pushRewardTypeFelts(calldata, args.reward);
  return {
    contractAddress: budokanAddress,
    entrypoint: "claim_reward",
    calldata,
  };
}

function pushRewardTypeFelts(out: string[], reward: RewardType): void {
  switch (reward.kind) {
    case "prize_single":
      out.push("0x0", "0x0", num.toHex(reward.prizeId));
      return;
    case "prize_distributed":
      out.push("0x0", "0x1", num.toHex(reward.prizeId), num.toHex(reward.payoutPosition));
      return;
    case "entry_fee_position":
      out.push("0x1", "0x0", num.toHex(reward.position));
      return;
    case "entry_fee_tournament_creator":
      out.push("0x1", "0x1");
      return;
    case "entry_fee_game_creator":
      out.push("0x1", "0x2");
      return;
    case "entry_fee_refund":
      out.push("0x1", "0x3", num.toHex(reward.tokenId));
      return;
  }
}

/**
 * create_tournament — minimal form (no entry_fee, no entry_requirement).
 *
 * Args mirror the contract:
 *   creator_rewards_address: ContractAddress
 *   metadata: { name: felt252, description: ByteArray }
 *   schedule: 5 × u32 delays
 *   game_config: { game_address, settings_id, soulbound, paymaster, client_url: Option<ByteArray>, renderer: Option<ContractAddress> }
 *   entry_fee: Option::None
 *   entry_requirement: Option::None
 *   leaderboard_config: { ascending, game_must_be_over }
 *   salt: u16
 *   metadata_value: u16
 */
export interface CreateTournamentArgs {
  creatorRewardsAddress: string;
  name: string;          // ≤ 31 ASCII bytes (felt252 short string)
  description: string;
  gameAddress: string;
  settingsId: number;
  schedule: {
    registrationStartDelay: number;
    registrationEndDelay: number;
    gameStartDelay: number;
    gameEndDelay: number;
    submissionDuration: number;
  };
  leaderboard: { ascending: boolean; gameMustBeOver: boolean };
  salt?: number;
  metadataValue?: number;
}

export function buildCreateTournamentCall(
  budokanAddress: string,
  args: CreateTournamentArgs,
): Call {
  const calldata = CallData.compile({
    creator_rewards_address: args.creatorRewardsAddress,
    metadata: {
      name: args.name,                  // CallData encodes short strings as felt252
      description: args.description,    // CallData encodes ByteArray
    },
    schedule: {
      registration_start_delay: args.schedule.registrationStartDelay,
      registration_end_delay: args.schedule.registrationEndDelay,
      game_start_delay: args.schedule.gameStartDelay,
      game_end_delay: args.schedule.gameEndDelay,
      submission_duration: args.schedule.submissionDuration,
    },
    game_config: {
      game_address: args.gameAddress,
      settings_id: args.settingsId,
      soulbound: false,
      paymaster: false,
      // Option<ByteArray> — None is tag 1, Some is tag 0.
      client_url: { type: "core::option::Option::<core::byte_array::ByteArray>", variant: { None: {} } },
      renderer: { type: "core::option::Option::<core::starknet::contract_address::ContractAddress>", variant: { None: {} } },
    },
    entry_fee: { type: "core::option::Option::<budokan_interfaces::budokan::EntryFee>", variant: { None: {} } },
    entry_requirement: { type: "core::option::Option::<game_components_interfaces::entry_requirement::EntryRequirement>", variant: { None: {} } },
    leaderboard_config: {
      ascending: args.leaderboard.ascending,
      game_must_be_over: args.leaderboard.gameMustBeOver,
    },
    salt: args.salt ?? 0,
    metadata_value: args.metadataValue ?? 0,
  });
  return {
    contractAddress: budokanAddress,
    entrypoint: "create_tournament",
    calldata,
  };
}
