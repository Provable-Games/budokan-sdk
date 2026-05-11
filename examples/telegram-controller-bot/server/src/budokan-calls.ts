// Build starknet.js Call objects for the Budokan entrypoints the bot
// actually invokes. Pure data — no signing, no execution. Each function
// returns calldata in the right shape for `account.execute([...])`.
//
// Cairo enum tags are 0-indexed in declaration order. References:
//   contracts/packages/interfaces/src/budokan.cairo
//   contracts/packages/interfaces/src/budokan.cairo (RewardType, EntryFeeRewardType)
//   game-components/.../prize.cairo (PrizeType)

import {
  byteArray,
  CairoCustomEnum,
  CairoOption,
  CairoOptionVariant,
  CallData,
  num,
  uint256,
} from "starknet";

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

/** ERC20 approve(spender, amount) */
export function buildErc20ApproveCall(
  tokenAddress: string,
  spender: string,
  amount: string,
): Call {
  return {
    contractAddress: tokenAddress,
    entrypoint: "approve",
    calldata: CallData.compile([spender, uint256.bnToUint256(amount)]),
  };
}

/**
 * enter_tournament(tournament_id: u64, player_name: Option<felt252>,
 *                  player_address: ContractAddress,
 *                  qualification: Option<QualificationProof>,
 *                  salt: u16, metadata_value: u16)
 *
 * Returns (felt252, u32) on-chain — game_token_id and entry_number — but
 * starknet.js execute() only surfaces the tx hash. Callers can fetch the
 * receipt + parse events if they need those values.
 *
 * Tournaments with non-trivial entry_requirement (NFT-gated, validator
 * extensions) need a real QualificationProof; those should not be entered
 * via this call. Caller is responsible for checking and routing.
 */
export interface EnterTournamentArgs {
  tournamentId: string;
  playerAddress: string;
  playerName?: string;     // Optional felt252 short string. Omit → Option::None.
  salt?: number;
  metadataValue?: number;
}

export function buildEnterTournamentCall(
  budokanAddress: string,
  args: EnterTournamentArgs,
): Call {
  // Hand-build calldata: starknet.js's enum encoding is brittle for
  // Option<felt252> in some versions; doing it manually keeps it explicit.
  const calldata: string[] = [
    num.toHex(args.tournamentId),  // tournament_id u64
  ];
  // player_name: Option<felt252>. Cairo Option tags: 0 = Some, 1 = None.
  if (args.playerName) {
    calldata.push("0x0", felt252FromShortString(args.playerName));
  } else {
    calldata.push("0x1");
  }
  calldata.push(args.playerAddress);  // player_address
  // qualification: Option<QualificationProof>. We only support None here;
  // qualified tournaments are routed out via deeplink.
  calldata.push("0x1");
  calldata.push(num.toHex(args.salt ?? 0));            // salt u16
  calldata.push(num.toHex(args.metadataValue ?? 0));   // metadata_value u16
  return {
    contractAddress: budokanAddress,
    entrypoint: "enter_tournament",
    calldata,
  };
}

// Felt252 short-string encoding: ASCII bytes packed big-endian into a felt.
// Throws if the input is too long (>31 bytes) or non-ASCII.
function felt252FromShortString(s: string): string {
  if (s.length > 31) throw new Error(`String too long for felt252: ${s.length} bytes`);
  let value = 0n;
  for (const char of s) {
    const code = char.charCodeAt(0);
    if (code > 0x7f) throw new Error("Felt252 short strings must be ASCII");
    value = (value << 8n) | BigInt(code);
  }
  return "0x" + value.toString(16);
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
/**
 * Distribution shape for splitting the entry-fee leaderboard pool (and
 * sponsored prize pools later) across the top N placements. Mirrors the
 * Cairo `Distribution` enum from game-components, with the same scaling
 * convention as the budokan client: client passes `weight` ∈ {0..N} and
 * the boundary scales to `weight * 10` for on-chain storage.
 */
export type DistributionSpec =
  | { kind: "linear"; weight: number }      // weight in client units (1 → on-chain 10)
  | { kind: "exponential"; weight: number } // same scaling
  | { kind: "uniform" };

export interface EntryFeeArgs {
  tokenAddress: string;
  amount: string;                    // raw u128 (decimal string)
  /** All shares are basis points (0–10000). Sum + leaderboard pool = 10000. */
  tournamentCreatorShare: number;
  gameCreatorShare: number;
  refundShare: number;
  distribution: DistributionSpec;
  /** Number of top placements that share the leaderboard pool. */
  distributionCount: number;
}

/**
 * Entry-requirement gating. The chain has two variants on the
 * EntryRequirementType enum:
 *   - token: ContractAddress — must own a token from this contract
 *   - extension: ExtensionConfig — a validator contract address + config Span
 *
 * For "extension" the caller is responsible for building the config Span
 * in the exact felt order the target validator's `add_config` expects
 * (see metagame-extensions/packages/presets/src/entry_requirement/* for
 * per-validator config layouts). `config` values are passed through as
 * raw felt strings — addresses, decimal numbers, hex are all fine.
 */
export type EntryRequirementSpec =
  | { kind: "token"; tokenAddress: string }
  | { kind: "extension"; address: string; config: string[] };

export interface EntryRequirementArgs {
  entryLimit: number;       // max entries per qualifying token / extension match
  type: EntryRequirementSpec;
}

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
  /** Optional. When set, encoded as Option::Some(EntryFee) on chain. */
  entryFee?: EntryFeeArgs;
  /** Optional. When set, encoded as Option::Some(EntryRequirement) on chain. */
  entryRequirement?: EntryRequirementArgs;
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
      // name is a felt252 (≤31 ASCII bytes). starknet.js CallData.compile
      // packs ASCII strings into a single felt without an ABI hint, so a
      // plain string works here.
      name: args.name,
      // description is a Cairo ByteArray (multi-felt: data words, pending
      // word, pending word length). CallData.compile doesn't infer that
      // from a plain string — encode explicitly via byteArrayFromString,
      // same as the budokan client does. Without this the on-chain
      // deserializer sees one felt where it expects 3+ and reverts with
      // "Failed to deserialize param".
      description: byteArray.byteArrayFromString(args.description),
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
      // Both Options are encoded via CairoOption so CallData.compile picks
      // them up as typed wrappers (it detects isSome/isNone on the
      // prototype). A plain {type, variant} object would not be recognized
      // and the type-name string would be serialized as a ByteArray —
      // i.e. garbage calldata.
      client_url: new CairoOption<string>(CairoOptionVariant.None),
      renderer: new CairoOption<string>(CairoOptionVariant.None),
    },
    entry_fee: encodeEntryFeeOption(args.entryFee),
    entry_requirement: encodeEntryRequirementOption(args.entryRequirement),
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

// On-chain weight is `client weight * 10` (matches client's
// formatting.ts convention so percentages match between bot-created and
// client-created tournaments).
function scaleWeight(client: number): number {
  return Math.round(client * 10);
}

/**
 * Build a CairoCustomEnum for the Distribution enum. Variant order in
 * Cairo: Linear, Exponential, Uniform, Custom — must match
 * declaration order so CallData.compile resolves the right tag. We
 * intentionally include every variant (with `undefined` for inactive
 * ones) so CairoCustomEnum's "exactly one active variant" invariant
 * holds and the index lookup is correct.
 */
function encodeDistribution(d: DistributionSpec): CairoCustomEnum {
  if (d.kind === "linear") {
    return new CairoCustomEnum({
      Linear: scaleWeight(d.weight),
      Exponential: undefined,
      Uniform: undefined,
      Custom: undefined,
    });
  }
  if (d.kind === "exponential") {
    return new CairoCustomEnum({
      Linear: undefined,
      Exponential: scaleWeight(d.weight),
      Uniform: undefined,
      Custom: undefined,
    });
  }
  // Uniform has no payload. CallData.compile emits just the variant tag
  // when unwrap() returns an empty object.
  return new CairoCustomEnum({
    Linear: undefined,
    Exponential: undefined,
    Uniform: {},
    Custom: undefined,
  });
}

/**
 * add_prize(tournament_id: u64, token_address: ContractAddress,
 *           token_type: TokenTypeData, sponsor_address: ContractAddress,
 *           sponsor_token_id: Option<felt252>)
 *
 * For chat use we only ship the ERC20 path. ERC721 prize sponsorship needs
 * tokenId selection from a Voyager NFT call which is a substantial extra
 * UX layer; defer to budokan.gg for that case.
 *
 * `distribution` is Option<Distribution> — None means "winner takes all"
 * (single payout). Some(...) splits the prize across the top
 * `distribution_count` placements.
 */
export interface AddPrizeArgs {
  tournamentId: string;
  tokenAddress: string;
  amount: string;                    // raw u128 (decimal string)
  /** When undefined, encoded as Option::None → single payout. */
  distribution?: DistributionSpec;
  /** Required when distribution is set; ignored otherwise. */
  distributionCount?: number;
  sponsorAddress: string;
}

export function buildAddPrizeCall(
  budokanAddress: string,
  args: AddPrizeArgs,
): Call {
  // Inner ERC20Data: { amount: u128, distribution: Option<Distribution>,
  // distribution_count: Option<u32> }. Both Options use CairoOption so
  // CallData.compile recognizes them as typed wrappers.
  const erc20Distribution = args.distribution
    ? new CairoOption<CairoCustomEnum>(
        CairoOptionVariant.Some,
        encodeDistribution(args.distribution),
      )
    : new CairoOption<CairoCustomEnum>(CairoOptionVariant.None);
  const erc20DistributionCount =
    args.distribution && args.distributionCount !== undefined
      ? new CairoOption<number>(CairoOptionVariant.Some, args.distributionCount)
      : new CairoOption<number>(CairoOptionVariant.None);

  // TokenTypeData is a Cairo enum: variants ERC20: ERC20Data, ERC721: ERC721Data.
  // Encode as CairoCustomEnum so the variant index resolves correctly.
  const tokenType = new CairoCustomEnum({
    ERC20: {
      amount: args.amount,
      distribution: erc20Distribution,
      distribution_count: erc20DistributionCount,
    },
    ERC721: undefined,
  });

  const calldata = CallData.compile({
    tournament_id: args.tournamentId,
    token_address: args.tokenAddress,
    token_type: tokenType,
    sponsor_address: args.sponsorAddress,
    // Option<felt252> — None for normal sponsorship.
    sponsor_token_id: new CairoOption<string>(CairoOptionVariant.None),
  });
  return {
    contractAddress: budokanAddress,
    entrypoint: "add_prize",
    calldata,
  };
}

// Cairo struct payload accepted by CallData.compile via recursive
// flattening. The CairoCustomEnum it contains is detected by activeVariant.
interface EntryRequirementPayload {
  entry_limit: number;
  entry_requirement_type: CairoCustomEnum;
}

function encodeEntryRequirementOption(
  req: EntryRequirementArgs | undefined,
): CairoOption<EntryRequirementPayload> {
  if (!req) return new CairoOption<EntryRequirementPayload>(CairoOptionVariant.None);
  return new CairoOption<EntryRequirementPayload>(CairoOptionVariant.Some, {
    entry_limit: req.entryLimit,
    entry_requirement_type: encodeEntryRequirementType(req.type),
  });
}

function encodeEntryRequirementType(spec: EntryRequirementSpec): CairoCustomEnum {
  // Variant order on chain (from interfaces::entry_requirement::EntryRequirementType):
  //   token: ContractAddress, extension: ExtensionConfig
  // The lowercase names match the Cairo declaration — starknet.js looks
  // up the variant index by exact key.
  if (spec.kind === "token") {
    return new CairoCustomEnum({
      token: spec.tokenAddress,
      extension: undefined,
    });
  }
  if (spec.kind === "extension") {
    // ExtensionConfig { address: ContractAddress, config: Span<felt252> }.
    // CallData.compile serializes a string[] as a Span (len + items).
    return new CairoCustomEnum({
      token: undefined,
      extension: {
        address: spec.address,
        config: spec.config,
      },
    });
  }
  throw new Error(`Unsupported entry requirement kind: ${(spec as { kind: string }).kind}`);
}

interface EntryFeePayload {
  token_address: string;
  amount: string;
  tournament_creator_share: number;
  game_creator_share: number;
  refund_share: number;
  distribution: CairoCustomEnum;
  distribution_count: number;
}

function encodeEntryFeeOption(
  fee: EntryFeeArgs | undefined,
): CairoOption<EntryFeePayload> {
  if (!fee) return new CairoOption<EntryFeePayload>(CairoOptionVariant.None);
  return new CairoOption<EntryFeePayload>(CairoOptionVariant.Some, {
    token_address: fee.tokenAddress,
    amount: fee.amount,
    tournament_creator_share: fee.tournamentCreatorShare,
    game_creator_share: fee.gameCreatorShare,
    refund_share: fee.refundShare,
    distribution: encodeDistribution(fee.distribution),
    distribution_count: fee.distributionCount,
  });
}
