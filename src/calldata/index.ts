/**
 * Calldata builders for Budokan's on-chain entrypoints.
 *
 * Each builder is a pure function that returns a starknet.js `Call` —
 * `{ contractAddress, entrypoint, calldata }` — without signing or
 * executing anything. Callers pass the returned Call to
 * `account.execute([...])` themselves so this module is decoupled from
 * how an integrator obtains an account (controller, sessions, agent
 * wallets, signing servers).
 *
 * Cairo encoding gotchas this module hides from callers:
 *   - Option<T> and custom enums must be wrapped in `CairoOption` /
 *     `CairoCustomEnum`. Plain `{ type, variant }` objects look right but
 *     CallData.compile treats them as generic structs and serializes the
 *     type-name string as a ByteArray — i.e. produces garbage calldata.
 *   - `Metadata.description` is a ByteArray (3+ felts). A plain JS
 *     string becomes a single felt and the deserializer reverts with
 *     "Failed to deserialize param".
 *   - Cairo enum variant tags are 0-indexed in declaration order; the
 *     manually-built calldata in enter/claim/submit follows this order
 *     exactly. References:
 *       contracts/packages/interfaces/src/budokan.cairo (RewardType,
 *         EntryFeeRewardType, EntryRequirementType, Distribution)
 *       game-components/.../prize.cairo (PrizeType)
 *
 * Used today by the Telegram bot in
 * `examples/telegram-controller-bot/`. Any other integration that needs
 * to drive the same contract (a Discord bot, a CLI, agent code) should
 * import from here so we don't fork the encoding logic again.
 */

import {
  byteArray,
  CairoCustomEnum,
  CairoOption,
  CairoOptionVariant,
  CallData,
  hash,
  num,
  uint256,
} from "starknet";

import type { TournamentSchedule } from "../schedule/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

/**
 * Shape of the entry-fee distribution. Mirrors the Cairo `Distribution`
 * enum (Linear / Exponential / Uniform / Custom). The integer `weight`
 * is in client units — the encoder scales it ×10 to match the on-chain
 * convention the budokan client uses, so distributions created via this
 * SDK and via budokan.gg render identically.
 */
export type DistributionSpec =
  | { kind: "linear"; weight: number }
  | { kind: "exponential"; weight: number }
  | { kind: "uniform" };

export interface EntryFeeArgs {
  tokenAddress: string;
  /** Raw u128 amount in smallest token units (decimal string). */
  amount: string;
  /** All shares are basis points (0–10000). Sum + leaderboard pool = 10000. */
  tournamentCreatorShare: number;
  gameCreatorShare: number;
  refundShare: number;
  distribution: DistributionSpec;
  /** Number of top placements that share the leaderboard pool. */
  distributionCount: number;
}

/**
 * Entry-requirement gating. Two variants on the chain's
 * EntryRequirementType enum:
 *   - token: ContractAddress — must own a token from this contract
 *   - extension: ExtensionConfig — validator contract + config Span
 *
 * For "extension" callers build the `config` Span<felt252> in the exact
 * felt order the target validator's `add_config` expects (see
 * `src/extensions` for preset builders that produce this for the
 * shared deployed validators).
 */
export type EntryRequirementSpec =
  | { kind: "token"; tokenAddress: string }
  | { kind: "extension"; address: string; config: string[] };

export interface EntryRequirementArgs {
  /** Max entries per qualifying token / extension match. */
  entryLimit: number;
  type: EntryRequirementSpec;
}

export interface EnterTournamentArgs {
  tournamentId: string;
  /**
   * Mint recipient. Encoded as `Option<ContractAddress>` — omit for
   * `None` (the contract defaults the mint to the caller).
   */
  playerAddress?: string;
  /** Optional felt252 short string (≤31 ASCII bytes). Omit → Option::None. */
  playerName?: string;
  /**
   * Third-party qualifier to claim, as `Option<ContractAddress>`. Omit for
   * `None` (caller is the qualifier — the common path). Only needed for
   * sponsor flows against gated tournaments.
   */
  qualifier?: string;
  /**
   * Proof that the entrant satisfies the tournament's `entry_requirement`,
   * encoded as `Option<QualificationProof>`. Omit → `None` (open tournaments,
   * or validators that need no proof).
   * - `{ kind: "extension", data }` → `QualificationProof::Extension(Span<felt252>)`.
   *   For the tournament validator (entry gated on having placed in another
   *   tournament), build `data` with `buildTournamentQualificationProof`.
   * - `{ kind: "nft", tokenId }` → `QualificationProof::NFT({ token_id })`.
   */
  qualification?:
    | { kind: "extension"; data: string[] }
    | { kind: "nft"; tokenId: string };
  /**
   * `entry_fee_pay_params` (`Option<Span<felt252>>`). Required only for
   * tournaments with an `EntryFeeKind::Extension` fee — the felts the fee
   * extension expects. Omit for the built-in fee flow (Option::None).
   */
  entryFeePayParams?: string[];
  salt?: number;
  metadataValue?: number;
}

export interface CreateTournamentArgs {
  creatorRewardsAddress: string;
  /** ≤31 ASCII bytes (felt252 short string). */
  name: string;
  description: string;
  gameAddress: string;
  settingsId: number;
  /**
   * Five delay fields with MIXED anchors — the start delays are offsets from
   * tournament creation, the end fields are durations of their own window.
   * Don't hand-assemble: build with `scheduleFromTimestamps` /
   * `scheduleFromDurations` from `src/schedule`, which encode the contract's
   * anchoring rules (see that module's docs).
   */
  schedule: TournamentSchedule;
  leaderboard: { ascending: boolean; gameMustBeOver: boolean };
  /** Encoded as Option::Some(EntryFeeKind::BuiltIn(EntryFee)) when set. */
  entryFee?: EntryFeeArgs;
  /** Encoded as Option::Some(EntryRequirement) on chain when set. */
  entryRequirement?: EntryRequirementArgs;
  salt?: number;
  metadataValue?: number;
}

/**
 * Token prize payload. Mirrors the Cairo `TokenTypeData` enum.
 *
 * - `erc20` — fungible. `amount` is required; `distribution` optional
 *   (undefined → single winner-takes-all payout). When `distribution`
 *   is set, `distributionCount` is required (number of paid positions).
 * - `erc721` — single NFT. `tokenId` is the u128 id of the token the
 *   sponsor is escrowing.
 */
export type TokenTypeSpec =
  | {
      kind: "erc20";
      /** Raw u128 amount (decimal string). */
      amount: string;
      distribution?: DistributionSpec;
      distributionCount?: number;
    }
  | { kind: "erc721"; tokenId: string };

/**
 * Tagged union mirroring the on-chain `Prize` enum.
 *
 * - `config` — built-in path: sponsor escrows an ERC20/ERC721 prize via
 *   the budokan PrizeComponent; `position` selects a leaderboard slot
 *   for non-distributed prizes (ignored for distributed ERC20).
 * - `extension` — external `IPrizeExtension`: budokan forwards the
 *   `config` blob to `IPrizeExtension.add_prize`. `position` is ignored
 *   (the extension owns position semantics).
 */
export type PrizeSpec =
  | {
      kind: "token";
      tokenAddress: string;
      tokenType: TokenTypeSpec;
      /** Leaderboard slot for single (non-distributed) prizes. Omit for distributed. */
      position?: number;
    }
  | {
      kind: "extension";
      /** Address of the contract implementing `IPrizeExtension`. */
      address: string;
      /** Opaque payload forwarded to `IPrizeExtension.add_prize`. */
      config: string[];
    };

export interface AddPrizeArgs {
  tournamentId: string;
  prize: PrizeSpec;
}

/**
 * Tagged union mirroring the Cairo `RewardType` enum hierarchy:
 *
 *   variant 0: Prize(PrizeClaim)
 *     PrizeClaim variant 0: Token(PrizeType)
 *       PrizeType variant 0: Single(u64)
 *       PrizeType variant 1: Distributed((u64, u8))
 *     PrizeClaim variant 1: Extension({prize_id, position, payout_params})
 *   variant 1: EntryFee(EntryFeeClaim)
 *     EntryFeeClaim variant 0: Token(EntryFeeRewardType)
 *       EntryFeeRewardType variant 0: Position(u32)
 *       EntryFeeRewardType variant 1: TournamentCreator
 *       EntryFeeRewardType variant 2: GameCreator
 *       EntryFeeRewardType variant 3: Refund(felt252)
 *     EntryFeeClaim variant 1: Extension(ExtensionEntryFeeClaim)
 *
 * Extension claims are pure pass-through on the host: budokan forwards
 * `(token_id, payout_params)` to the extension and lets it resolve
 * recipient + eligibility from its own state. Callers don't supply
 * recipient or position — the extension derives them.
 *
 * Conventions:
 *   - `tokenId` is the game token claiming. Positional extensions
 *     (NFTPrize, NFTEntryFee) use it to look up the leaderboard
 *     position; ownership-based extensions use it to derive the
 *     recipient via `owner_of`.
 *   - `tokenId: undefined` signals a non-claim flow (sponsor refund,
 *     dao distribution, raffle draw). The extension extracts whatever
 *     it needs from `payoutParams` / `claimParams` — e.g. NFTPrize
 *     reads `payoutParams[0]` as the slot index to refund.
 */
export type RewardType =
  | { kind: "prize_single"; prizeId: string }
  | { kind: "prize_distributed"; prizeId: string; payoutPosition: number }
  | {
      kind: "prize_extension";
      prizeId: string;
      /**
       * Game token claiming the prize, or undefined for non-claim flows
       * (sponsor refunds, raffle draws, etc.).
       */
      tokenId?: string;
      payoutParams: string[];
    }
  | { kind: "entry_fee_position"; position: number }
  | { kind: "entry_fee_tournament_creator" }
  | { kind: "entry_fee_game_creator" }
  | { kind: "entry_fee_protocol_fee" }
  | { kind: "entry_fee_refund"; tokenId: string }
  | {
      kind: "entry_fee_extension";
      /**
       * Game token claiming the fee-pool share, or undefined for
       * non-claim flows (sponsor refunds, creator shares, etc.).
       */
      tokenId?: string;
      claimParams: string[];
    };

// ---------------------------------------------------------------------------
// ERC20
// ---------------------------------------------------------------------------

/** Standard ERC20 `approve(spender, amount)` call. */
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

// ---------------------------------------------------------------------------
// Budokan entrypoints
// ---------------------------------------------------------------------------

/**
 * `enter_tournament(tournament_id: u64, player_name: Option<felt252>,
 *                   player_address: Option<ContractAddress>,
 *                   qualifier: Option<ContractAddress>,
 *                   qualification: Option<QualificationProof>,
 *                   entry_fee_pay_params: Option<Span<felt252>>,
 *                   salt: u16, metadata_value: u16)`
 *
 * Targets the current budokan contract (#264/#269). `qualification` and
 * `entry_fee_pay_params` are always `None` here — gated/extension-fee
 * tournaments need a real proof / pay-params payload, which depend on the
 * validator and the caller's runtime state.
 *
 * Returns `(felt252, u32)` on-chain — game_token_id and entry_number — but
 * `execute()` surfaces only the tx hash. Callers can fetch the receipt
 * and parse events if they need the values.
 *
 * Tournaments with a non-trivial entry_requirement (NFT-gated or
 * extension-validator) need a real `QualificationProof` and shouldn't go
 * through this entrypoint — route those via the budokan client UI or
 * implement a qualification-proof builder.
 */
export function buildEnterTournamentCall(
  budokanAddress: string,
  args: EnterTournamentArgs,
): Call {
  // Hand-built calldata. enter_tournament takes a chain of Options (tags:
  // 0 = Some, 1 = None) in this exact ABI order:
  //   tournament_id, player_name?, player_address?, qualifier?,
  //   qualification?, entry_fee_pay_params?, salt, metadata_value
  const calldata: string[] = [
    num.toHex(args.tournamentId), // tournament_id u64
  ];
  // player_name: Option<felt252>
  if (args.playerName) {
    calldata.push("0x0", felt252FromShortString(args.playerName, "Player name"));
  } else {
    calldata.push("0x1");
  }
  // player_address: Option<ContractAddress> — Some(addr) sets the mint
  // recipient; None defaults to the caller.
  if (args.playerAddress) {
    calldata.push("0x0", args.playerAddress);
  } else {
    calldata.push("0x1");
  }
  // qualifier: Option<ContractAddress> — Some(addr) claims a third-party
  // qualifier; None = caller is the qualifier.
  if (args.qualifier) {
    calldata.push("0x0", args.qualifier);
  } else {
    calldata.push("0x1");
  }
  // qualification: Option<QualificationProof>. None for open tournaments;
  // Some(proof) for gated ones. QualificationProof variants: NFT=0, Extension=1.
  if (args.qualification) {
    calldata.push("0x0"); // Option::Some
    if (args.qualification.kind === "nft") {
      calldata.push("0x0"); // QualificationProof::NFT(NFTQualification { token_id: u256 })
      const { low, high } = uint256.bnToUint256(args.qualification.tokenId);
      calldata.push(num.toHex(low), num.toHex(high));
    } else {
      calldata.push("0x1"); // QualificationProof::Extension(Span<felt252>)
      const data = args.qualification.data;
      calldata.push(num.toHex(data.length), ...data.map((d) => num.toHex(d)));
    }
  } else {
    calldata.push("0x1"); // Option::None
  }
  // entry_fee_pay_params: Option<Span<felt252>>. Some(span) for
  // EntryFeeKind::Extension tournaments; None for the built-in fee flow.
  if (args.entryFeePayParams && args.entryFeePayParams.length > 0) {
    calldata.push(
      "0x0",
      num.toHex(args.entryFeePayParams.length),
      ...args.entryFeePayParams,
    );
  } else {
    calldata.push("0x1");
  }
  calldata.push(num.toHex(args.salt ?? 0)); // salt u16
  calldata.push(num.toHex(args.metadataValue ?? 0)); // metadata_value u16
  return {
    contractAddress: budokanAddress,
    entrypoint: "enter_tournament",
    calldata,
  };
}

/** `submit_score(tournament_id: u64, token_id: felt252, position: u32)` */
export function buildSubmitScoreCall(
  budokanAddress: string,
  args: { tournamentId: string; tokenId: string; position: number },
): Call {
  return {
    contractAddress: budokanAddress,
    entrypoint: "submit_score",
    calldata: CallData.compile([args.tournamentId, args.tokenId, args.position]),
  };
}

/** `claim_reward(tournament_id: u64, reward_type: RewardType)` */
export function buildClaimRewardCall(
  budokanAddress: string,
  args: { tournamentId: string; reward: RewardType },
): Call {
  // Hand-rolled enum encoding: outer tag, then inner tag, then payload.
  // CallData.compile flattens nested arrays, so we build the felt list
  // directly to keep this transparent.
  const calldata: string[] = [num.toHex(args.tournamentId)];
  pushRewardTypeFelts(calldata, args.reward);
  return {
    contractAddress: budokanAddress,
    entrypoint: "claim_reward",
    calldata,
  };
}

/**
 * `create_tournament(creator_rewards_address, metadata, schedule,
 *                    game_config, entry_fee, entry_requirement,
 *                    leaderboard_config, salt, metadata_value)`
 *
 * Schedule fields are durations (`registration_end_delay`,
 * `game_end_delay` measured from their respective starts) — *not*
 * absolute offsets from creation. Callers are responsible for the
 * arithmetic; the contract validates min/max bounds itself.
 *
 * Pass `entryFee` / `entryRequirement` as `undefined` for free / open
 * tournaments. Both fields are wrapped in `CairoOption` so
 * `CallData.compile` emits the correct variant tag.
 */
export function buildCreateTournamentCall(
  budokanAddress: string,
  args: CreateTournamentArgs,
): Call {
  const calldata = CallData.compile({
    creator_rewards_address: args.creatorRewardsAddress,
    metadata: {
      // name is a felt252 (≤31 ASCII bytes) — encode explicitly so an
      // oversized/non-ASCII name fails here with a clear message instead of
      // deep inside CallData.compile.
      name: felt252FromShortString(args.name, "Tournament name"),
      // description is a Cairo ByteArray (multi-felt: data words +
      // pending word + pending word length). A plain JS string serializes
      // to a single felt and the deserializer reverts — wrap explicitly.
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
      // Options must be CairoOption — see file header for why.
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

/**
 * `add_prize(tournament_id: u64, prize: Prize, position: Option<u32>) -> u64`
 *
 * The `Prize` sum type discriminates between the built-in
 * (ERC20/ERC721) flow and an external `IPrizeExtension` integration —
 * see `PrizeSpec` for the variants.
 *
 * The on-chain entrypoint returns the minted `prize_id` (u64); callers
 * wanting the full payload should subscribe to the `PrizeAdded` event.
 */
export function buildAddPrizeCall(
  budokanAddress: string,
  args: AddPrizeArgs,
): Call {
  const prize = encodePrize(args.prize);
  const position =
    args.prize.kind === "token" && args.prize.position !== undefined
      ? new CairoOption<number>(CairoOptionVariant.Some, args.prize.position)
      : new CairoOption<number>(CairoOptionVariant.None);
  const calldata = CallData.compile({
    tournament_id: args.tournamentId,
    prize,
    position,
  });
  return {
    contractAddress: budokanAddress,
    entrypoint: "add_prize",
    calldata,
  };
}

function encodePrize(spec: PrizeSpec): CairoCustomEnum {
  // Variant order from interfaces::prize::Prize: Token, Extension.
  // Input payloads (TokenPrizePayload / ExtensionPrizePayload) carry no
  // host-assigned metadata — id/context_id/sponsor_address live on the
  // wrapping PrizeRecord at read time and are filled in by the host.
  if (spec.kind === "token") {
    return new CairoCustomEnum({
      Token: {
        token_address: spec.tokenAddress,
        token_type: encodeTokenType(spec.tokenType),
      },
      Extension: undefined,
    });
  }
  // ExtensionPrizePayload { address, config }. CallData.compile
  // serializes string[] as a Span (len + items).
  return new CairoCustomEnum({
    Token: undefined,
    Extension: {
      address: spec.address,
      config: spec.config,
    },
  });
}

function encodeTokenType(spec: TokenTypeSpec): CairoCustomEnum {
  if (spec.kind === "erc20") {
    // distribution and distribution_count must agree: a Some(distribution)
    // with a None count is ambiguous calldata that the contract rejects.
    if (spec.distribution && spec.distributionCount === undefined) {
      throw new Error(
        "TokenTypeSpec.erc20: distributionCount is required when distribution is set",
      );
    }
    // Inner erc20 data: { amount: u128, distribution: Option<Distribution>,
    // distribution_count: Option<u32> }. Both Options use CairoOption so
    // CallData.compile recognizes them as typed wrappers.
    //
    // Variant keys (`erc20`/`erc721`) match the ABI's TokenTypeData variant
    // names exactly, in declaration order. CallData.compile encodes the
    // variant by position (it's order-based without an ABI), so casing is
    // cosmetic for the wire format — but matching the ABI keeps the encoder
    // self-evidently correct and ABI-aware code paths safe.
    const distribution = spec.distribution
      ? new CairoOption<CairoCustomEnum>(
          CairoOptionVariant.Some,
          encodeDistribution(spec.distribution),
        )
      : new CairoOption<CairoCustomEnum>(CairoOptionVariant.None);
    const distributionCount =
      spec.distribution && spec.distributionCount !== undefined
        ? new CairoOption<number>(
            CairoOptionVariant.Some,
            spec.distributionCount,
          )
        : new CairoOption<number>(CairoOptionVariant.None);
    return new CairoCustomEnum({
      erc20: {
        amount: spec.amount,
        distribution,
        distribution_count: distributionCount,
      },
      erc721: undefined,
    });
  }
  return new CairoCustomEnum({
    erc20: undefined,
    erc721: { id: spec.tokenId },
  });
}

// ---------------------------------------------------------------------------
// Internal encoders
// ---------------------------------------------------------------------------

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
): CairoOption<CairoCustomEnum> {
  if (!fee) return new CairoOption<CairoCustomEnum>(CairoOptionVariant.None);
  // Validate here so mistakes fail with a clear message at build time
  // instead of an opaque on-chain revert at estimation.
  if (!/^\d+$/.test(fee.amount) || BigInt(fee.amount) === 0n) {
    throw new Error(
      `Entry-fee amount must be a positive base-unit integer string, got "${fee.amount}" — ` +
        `scale human amounts with toRawAmount()`,
    );
  }
  const shares: Array<[string, number]> = [
    ["tournamentCreatorShare", fee.tournamentCreatorShare],
    ["gameCreatorShare", fee.gameCreatorShare],
    ["refundShare", fee.refundShare],
  ];
  for (const [label, value] of shares) {
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
      throw new Error(`Entry-fee ${label} must be an integer 0–10000 basis points, got ${value}`);
    }
  }
  const shareSum = fee.tournamentCreatorShare + fee.gameCreatorShare + fee.refundShare;
  if (shareSum > 10000) {
    throw new Error(
      `Entry-fee shares exceed 100%: ${shareSum} of 10000 bps ` +
        `(the remainder after shares funds the winners' pool)`,
    );
  }
  if (!Number.isInteger(fee.distributionCount) || fee.distributionCount < 1) {
    throw new Error(`Entry-fee distributionCount must be a positive integer, got ${fee.distributionCount}`);
  }
  const builtIn: EntryFeePayload = {
    token_address: fee.tokenAddress,
    amount: fee.amount,
    tournament_creator_share: fee.tournamentCreatorShare,
    game_creator_share: fee.gameCreatorShare,
    refund_share: fee.refundShare,
    distribution: encodeDistribution(fee.distribution),
    distribution_count: fee.distributionCount,
  };
  // entry_fee is now Option<EntryFeeKind>, where EntryFeeKind is a sum type
  // { BuiltIn: EntryFee, Extension: ExtensionConfig }. The SDK only builds
  // built-in token fees; wrap the payload in the BuiltIn variant.
  return new CairoOption<CairoCustomEnum>(
    CairoOptionVariant.Some,
    new CairoCustomEnum({ BuiltIn: builtIn, Extension: undefined }),
  );
}

interface EntryRequirementPayload {
  entry_limit: number;
  entry_requirement_type: CairoCustomEnum;
}

function encodeEntryRequirementOption(
  req: EntryRequirementArgs | undefined,
): CairoOption<EntryRequirementPayload> {
  if (!req)
    return new CairoOption<EntryRequirementPayload>(CairoOptionVariant.None);
  return new CairoOption<EntryRequirementPayload>(CairoOptionVariant.Some, {
    entry_limit: req.entryLimit,
    entry_requirement_type: encodeEntryRequirementType(req.type),
  });
}

function encodeEntryRequirementType(
  spec: EntryRequirementSpec,
): CairoCustomEnum {
  // Variant order from interfaces::entry_requirement::EntryRequirementType:
  //   token: ContractAddress, extension: ExtensionConfig
  if (spec.kind === "token") {
    return new CairoCustomEnum({
      token: spec.tokenAddress,
      extension: undefined,
    });
  }
  if (spec.kind === "extension") {
    // ExtensionConfig { address: ContractAddress, config: Span<felt252> }.
    // CallData.compile serializes string[] as a Span (len + items).
    return new CairoCustomEnum({
      token: undefined,
      extension: {
        address: spec.address,
        config: spec.config,
      },
    });
  }
  throw new Error(
    `Unsupported entry requirement kind: ${(spec as { kind: string }).kind}`,
  );
}

// On-chain weight is `client weight * 10` (matches the budokan client's
// formatting.ts convention so percentages match between tournaments
// created via budokan.gg and via this SDK).
function scaleWeight(client: number): number {
  return Math.round(client * 10);
}

/**
 * Encode the Distribution enum. Variant order in Cairo: Linear,
 * Exponential, Uniform, Custom — must match declaration order so
 * CallData.compile resolves the right tag. All variants are included
 * with `undefined` for inactive ones so CairoCustomEnum's "exactly one
 * active variant" invariant holds.
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

function pushRewardTypeFelts(out: string[], reward: RewardType): void {
  // Outer tags: RewardType { Prize=0, EntryFee=1 }
  // Prize inner: PrizeClaim { Token=0, Extension=1 }
  // PrizeClaim::Token inner: PrizeType { Single=0, Distributed=1 }
  // EntryFee inner: EntryFeeClaim { Token=0, Extension=1 }
  // EntryFeeClaim::Token inner: EntryFeeRewardType { Position=0,
  //   TournamentCreator=1, GameCreator=2, Refund=3, ProtocolFee=4 }
  switch (reward.kind) {
    case "prize_single":
      out.push("0x0", "0x0", "0x0", num.toHex(reward.prizeId));
      return;
    case "prize_distributed":
      out.push(
        "0x0",
        "0x0",
        "0x1",
        num.toHex(reward.prizeId),
        num.toHex(reward.payoutPosition),
      );
      return;
    case "prize_extension":
      // ExtensionPrizeClaim { prize_id, token_id: Option<felt252>, payout_params }
      out.push("0x0", "0x1", num.toHex(reward.prizeId));
      if (reward.tokenId !== undefined) {
        out.push("0x0", reward.tokenId); // Some(token_id)
      } else {
        out.push("0x1"); // None
      }
      out.push(
        num.toHex(reward.payoutParams.length),
        ...reward.payoutParams.map((p) => num.toHex(p)),
      );
      return;
    case "entry_fee_position":
      out.push("0x1", "0x0", "0x0", num.toHex(reward.position));
      return;
    case "entry_fee_tournament_creator":
      out.push("0x1", "0x0", "0x1");
      return;
    case "entry_fee_game_creator":
      out.push("0x1", "0x0", "0x2");
      return;
    case "entry_fee_refund":
      out.push("0x1", "0x0", "0x3", num.toHex(reward.tokenId));
      return;
    case "entry_fee_protocol_fee":
      out.push("0x1", "0x0", "0x4");
      return;
    case "entry_fee_extension": {
      // ExtensionEntryFeeClaim { token_id: Option<felt252>, claim_params }
      out.push("0x1", "0x1");
      if (reward.tokenId !== undefined) {
        out.push("0x0", reward.tokenId); // Some(token_id)
      } else {
        out.push("0x1"); // None
      }
      out.push(
        num.toHex(reward.claimParams.length),
        ...reward.claimParams.map((p) => num.toHex(p)),
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Event parsing helpers
// ---------------------------------------------------------------------------

/**
 * Minimal receipt shape — `events: Array<{ from_address, keys, ... }>`
 * is all `parseTournamentIdFromReceipt` needs and matches what every
 * Starknet RPC / starknet.js `waitForTransaction` returns.
 */
export interface ReceiptWithEvents {
  events?: Array<{ from_address?: string; keys?: string[] }>;
}

const TOURNAMENT_CREATED_SELECTOR = hash.getSelectorFromName(
  "TournamentCreated",
);

/**
 * Extract the new tournament's id from a `create_tournament` tx receipt
 * by scanning for the `TournamentCreated` event emitted by the budokan
 * contract. The event has the tournament id in its first indexed key
 * (`keys[1]` — `keys[0]` is the selector).
 *
 * Returns the id as a `bigint` (the on-chain type is `u64`, which exceeds
 * JS `Number.MAX_SAFE_INTEGER`, so a lossless type is required — callers
 * deep-linking to a tournament page should `.toString()` it). Returns
 * `undefined` if no matching event is found (e.g. the receipt came from a
 * different call, or the budokan address didn't match).
 *
 * Caller is responsible for fetching the receipt — typically via
 * `account.waitForTransaction(hash)` or `provider.waitForTransaction(hash)`.
 */
export function parseTournamentIdFromReceipt(
  receipt: ReceiptWithEvents,
  budokanAddress: string,
): bigint | undefined {
  const normalise = (addr: string) =>
    addr.toLowerCase().replace(/^0x0*/, "0x");
  const normContract = normalise(budokanAddress);
  // Compare selectors numerically so RPC formatting differences
  // (leading-zero padding, casing) don't cause a valid event to be missed.
  const createdSelector = BigInt(TOURNAMENT_CREATED_SELECTOR);
  for (const event of receipt.events ?? []) {
    if (!event.from_address || !event.keys || event.keys.length < 2) continue;
    if (normalise(event.from_address) !== normContract) continue;
    if (BigInt(event.keys[0]!) !== createdSelector) continue;
    return BigInt(event.keys[1]!);
  }
  return undefined;
}

// Felt252 short-string encoding: ASCII bytes packed big-endian into a felt.
// Throws if the input is too long (>31 bytes) or non-ASCII.
function felt252FromShortString(s: string, label = "String"): string {
  if (s.length > 31)
    throw new Error(
      `${label} doesn't fit in a felt252 short string: ${s.length} characters (max 31)`,
    );
  let value = 0n;
  for (const char of s) {
    const code = char.charCodeAt(0);
    if (code > 0x7f)
      throw new Error(`${label} must be ASCII — "${char}" doesn't fit in a felt252 short string`);
    value = (value << 8n) | BigInt(code);
  }
  return "0x" + value.toString(16);
}
