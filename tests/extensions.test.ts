import { describe, expect, test } from "bun:test";
import {
  buildErc20BalanceConfig,
  buildMerkleConfig,
  buildOpusTrovesConfig,
  buildTournamentValidatorConfig,
  buildTournamentQualificationProof,
  extensionAddressFor,
  u256ToLowHigh,
} from "../src/extensions/index.ts";
import {
  buildRegisterAllowlistTreeCall,
  type BuildRegisterAllowlistTreeParams,
} from "../src/extensions/merkle.ts";
import { normalizeAddress } from "../src/utils/address.ts";

describe("buildTournamentQualificationProof", () => {
  test("encodes [qualifyingTournamentId, tokenId, position]", () => {
    expect(buildTournamentQualificationProof("7", "0x123", 1)).toEqual([
      "7",
      "0x123",
      "1",
    ]);
  });
});

describe("u256ToLowHigh", () => {
  test("splits into low/high limbs", () => {
    expect(u256ToLowHigh(0n)).toEqual(["0", "0"]);
    expect(u256ToLowHigh((1n << 128n))).toEqual(["0", "1"]);
    expect(u256ToLowHigh((1n << 128n) + 5n)).toEqual(["5", "1"]);
  });

  test("accepts exactly u256 max", () => {
    const max = (1n << 256n) - 1n;
    const [lo, hi] = u256ToLowHigh(max);
    expect(BigInt(lo)).toBe((1n << 128n) - 1n);
    expect(BigInt(hi)).toBe((1n << 128n) - 1n);
  });

  test("throws on negative", () => {
    expect(() => u256ToLowHigh(-1n)).toThrow();
  });

  test("throws above u256 max", () => {
    expect(() => u256ToLowHigh(1n << 256n)).toThrow();
  });
});

describe("buildErc20BalanceConfig layout", () => {
  test("[token, min(lo,hi), max(lo,hi), vpe(lo,hi), maxEntries, bannable]", () => {
    const out = buildErc20BalanceConfig({
      tokenAddress: "0xtoken",
      minThreshold: 5n,
      maxThreshold: 0n,
      valuePerEntry: (1n << 128n) + 1n,
      maxEntries: 3,
      bannable: true,
    });
    expect(out).toEqual([
      "0xtoken",
      "5", "0", // min lo/hi
      "0", "0", // max lo/hi
      "1", "1", // vpe lo/hi
      "3",
      "1",
    ]);
  });
});

describe("buildOpusTrovesConfig layout", () => {
  test("[asset_count, ...assets, threshold, vpe, maxEntries, bannable]", () => {
    expect(
      buildOpusTrovesConfig({
        assetAddresses: ["0xa", "0xb"],
        threshold: 100n,
        valuePerEntry: 10n,
        maxEntries: 0,
        bannable: false,
      }),
    ).toEqual(["2", "0xa", "0xb", "100", "10", "0", "0"]);
  });

  test("empty assets → count 0 wildcard", () => {
    expect(
      buildOpusTrovesConfig({
        assetAddresses: [],
        threshold: 1n,
        valuePerEntry: 0n,
        maxEntries: 0,
        bannable: false,
      }),
    ).toEqual(["0", "1", "0", "0", "0"]);
  });
});

describe("buildMerkleConfig", () => {
  test("[tree_id]", () => {
    expect(buildMerkleConfig({ treeId: 7 })).toEqual(["7"]);
  });
});

describe("buildRegisterAllowlistTreeCall", () => {
  const norm = (s: string) => BigInt(s).toString();

  test("returns a create_tree call to the merkle validator + count-1 entries", () => {
    const { call, entries } = buildRegisterAllowlistTreeCall({
      chain: "sepolia",
      addresses: ["0x1", "0x2"],
    });
    expect(call.entrypoint).toBe("create_tree");
    expect(norm(call.contractAddress)).toBe(norm(extensionAddressFor("sepolia", "merkle")));
    // Addresses are normalized to the canonical form in the tree entries.
    expect(entries).toEqual([
      { address: normalizeAddress("0x1"), count: 1 },
      { address: normalizeAddress("0x2"), count: 1 },
    ]);
  });

  test("honors entriesPerAddress", () => {
    const { entries } = buildRegisterAllowlistTreeCall({
      chain: "mainnet",
      addresses: ["0xa"],
      entriesPerAddress: 3,
    });
    expect(entries).toEqual([{ address: normalizeAddress("0xa"), count: 3 }]);
  });

  test("normalizes + dedupes representation variants of the same address", () => {
    const { entries } = buildRegisterAllowlistTreeCall({
      chain: "sepolia",
      addresses: ["0x1", "0x01", "0xABC", "0xabc"],
    });
    expect(entries).toEqual([
      { address: normalizeAddress("0x1"), count: 1 },
      { address: normalizeAddress("0xabc"), count: 1 },
    ]);
  });

  test("rejects an empty allowlist", () => {
    expect(() =>
      buildRegisterAllowlistTreeCall({ chain: "sepolia", addresses: [] }),
    ).toThrow();
  });

  test("rejects a non-positive-integer entriesPerAddress (incl. NaN / fractional)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        buildRegisterAllowlistTreeCall({
          chain: "sepolia",
          addresses: ["0x1"],
          entriesPerAddress: bad,
        }),
      ).toThrow();
    }
  });

  test("count boundary: exactly MAX passes, MAX+1 throws", () => {
    const MAX = 2147483647;
    const { entries } = buildRegisterAllowlistTreeCall({
      chain: "mainnet",
      entries: [{ address: "0x1", count: MAX }],
    });
    expect(entries).toEqual([{ address: normalizeAddress("0x1"), count: MAX }]);
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        entries: [{ address: "0x1", count: MAX + 1 }],
      }),
    ).toThrow(/merkle API/);
  });

  test("form selection is presence-based: entries: [] is the tiered form", () => {
    // Runtime guards for JS callers — the union type makes these compile
    // errors in TS, hence the casts.
    expect(() =>
      buildRegisterAllowlistTreeCall({ chain: "mainnet", entries: [] }),
    ).toThrow(/at least one entry/);
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        entries: [],
        addresses: ["0x1"],
      } as never),
    ).toThrow(/not both/);
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        entries: [{ address: "0x1", count: 1 }],
        entriesPerAddress: 2,
      } as never),
    ).toThrow(/entriesPerAddress/);
  });

  test("rejects counts above the merkle API's i32 storage limit", () => {
    // On-chain u32 accepts these, but the proof API cannot store them — the
    // tree would register and then never serve proofs.
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        addresses: ["0x1"],
        entriesPerAddress: 2147483648,
      }),
    ).toThrow(/merkle API/);
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        entries: [{ address: "0x1", count: 4294967295 }],
      }),
    ).toThrow(/merkle API/);
  });

  test("tiered entries: per-address counts, normalized", () => {
    const { entries } = buildRegisterAllowlistTreeCall({
      chain: "mainnet",
      entries: [
        { address: "0xABC", count: 5 },
        { address: "0x1", count: 1 },
      ],
    });
    expect(entries).toEqual([
      { address: normalizeAddress("0xabc"), count: 5 },
      { address: normalizeAddress("0x1"), count: 1 },
    ]);
  });

  test("tiered entries: identical duplicates collapse, conflicting counts throw", () => {
    const { entries } = buildRegisterAllowlistTreeCall({
      chain: "mainnet",
      entries: [
        { address: "0x1", count: 2 },
        { address: "0x01", count: 2 },
      ],
    });
    expect(entries).toEqual([{ address: normalizeAddress("0x1"), count: 2 }]);
    expect(() =>
      buildRegisterAllowlistTreeCall({
        chain: "mainnet",
        entries: [
          { address: "0x1", count: 2 },
          { address: "0x01", count: 3 },
        ],
      }),
    ).toThrow(/conflicting/);
  });

  test("rejects mixing addresses with entries, and entriesPerAddress with entries", () => {
    // Cast deliberately. `BuildRegisterAllowlistTreeParams` encodes
    // `addresses` XOR `entries` in the type system via `never`, so these
    // combinations are compile errors — which is the point: the runtime guards
    // exist for JS callers who never see the types. Testing them requires
    // stepping around the union the same way such a caller would.
    const invalid = (p: unknown) =>
      buildRegisterAllowlistTreeCall(p as BuildRegisterAllowlistTreeParams);
    expect(() =>
      invalid({
        chain: "mainnet",
        addresses: ["0x1"],
        entries: [{ address: "0x2", count: 1 }],
      }),
    ).toThrow(/not both/);
    expect(() =>
      invalid({
        chain: "mainnet",
        entries: [{ address: "0x2", count: 1 }],
        entriesPerAddress: 2,
      }),
    ).toThrow(/entriesPerAddress/);
  });
});

describe("buildTournamentValidatorConfig layout", () => {
  test("participated → qualifier 0, top_positions forced 0", () => {
    expect(
      buildTournamentValidatorConfig({
        requirement: "participated",
        tournamentIds: ["1", "2"],
        topPositions: 5,
      }),
    ).toEqual(["0", "0", "0", "1", "2"]);
  });

  test("won → qualifier 1, top_positions honored, mode passthrough", () => {
    expect(
      buildTournamentValidatorConfig({
        requirement: "won",
        tournamentIds: ["9"],
        topPositions: 3,
        qualifyingMode: 2,
      }),
    ).toEqual(["1", "2", "3", "9"]);
  });
});

// =========================================================================
// Entry-fee trust classification
// =========================================================================

import {
  classifyEntryFeeTrust,
  getEntryFeeTrust,
  isVettedFeeExtension,
} from "../src/extensions/feeTrust.ts";

describe("classifyEntryFeeTrust", () => {
  test("no fee -> none, nothing to enforce", () => {
    const t = classifyEntryFeeTrust({ hasEntryFee: false });
    expect(t.level).toBe("none");
    expect(t.protocolFeeEnforcedOnChain).toBe(false);
  });

  test("builtin fee -> custodial, protocol fee contract-enforced", () => {
    const t = classifyEntryFeeTrust({ hasEntryFee: true });
    expect(t.level).toBe("custodial");
    expect(t.protocolFeeEnforcedOnChain).toBe(true);
  });

  test("vetted extension -> fee honored by convention not enforcement", () => {
    const t = classifyEntryFeeTrust({
      hasEntryFee: true,
      extensionAddress: "0xabc",
      extensionVetted: true,
    });
    expect(t.level).toBe("vetted-extension");
    expect(t.extensionAddress).toBe("0xabc");
    expect(t.protocolFeeEnforcedOnChain).toBe(false);
  });

  test("extension outside the curated list -> unvetted", () => {
    const t = classifyEntryFeeTrust({
      hasEntryFee: true,
      extensionAddress: "0xabc",
      extensionVetted: false,
    });
    expect(t.level).toBe("unvetted-extension");
  });
});

describe("isVettedFeeExtension", () => {
  test("matches addresses regardless of zero-padding", () => {
    const list = ["0x0abc"];
    expect(isVettedFeeExtension("0xabc", list)).toBe(true);
    expect(isVettedFeeExtension("0x00abc", list)).toBe(true);
    expect(isVettedFeeExtension("0xdef", list)).toBe(false);
  });

  test("malformed addresses are never vetted, never throw", () => {
    expect(isVettedFeeExtension("not-hex", ["0xabc"])).toBe(false);
    expect(isVettedFeeExtension("0xabc", ["not-hex"])).toBe(false);
  });

  test("zero/empty addresses are never vetted (BigInt('') is 0n, not a throw)", () => {
    expect(isVettedFeeExtension("", [""])).toBe(false);
    expect(isVettedFeeExtension(" ", ["0x0"])).toBe(false);
    expect(isVettedFeeExtension("0x0", ["0x0"])).toBe(false);
  });
});

describe("getEntryFeeTrust", () => {
  // Stub Budokan contract: only `call` and `address` are consulted.
  function stubContract(reads: Record<string, unknown>) {
    return {
      address: "0xbudokan",
      call: async (entrypoint: string) => {
        if (!(entrypoint in reads)) throw new Error(`unexpected call ${entrypoint}`);
        return reads[entrypoint];
      },
    } as never;
  }

  // License modeled as the raw ByteArray struct starknet.js actually returns
  // for `contract.call` — NOT a pre-decoded string. "pay the declared
  // protocol fee" is 29 bytes, so it rides entirely in `pending_word`.
  const infoRead = {
    tournament_protocol_fee_info: {
      license: {
        data: [],
        pending_word: 0x70617920746865206465636c617265642070726f746f636f6c20666565n,
        pending_word_len: 29n,
      },
      fee_bps: 250n,
      recipient: 0xda0n,
    },
  };

  test("one info read supplies rate, recipient, and license terms", async () => {
    const report = await getEntryFeeTrust(
      stubContract(infoRead),
      { tournamentId: "7", hasEntryFee: true, extensionAddress: "0xfee" },
      { vettedExtensions: ["0xfee"] },
    );
    expect(report.level).toBe("vetted-extension");
    expect(report.protocolFeeBps).toBe(250);
    expect(report.protocolFeeRecipient).toBe("0x" + "da0".padStart(64, "0"));
    expect(report.protocolFeeLicense).toBe("pay the declared protocol fee");
    expect(report.protocolFeeEnforcedOnChain).toBe(false);
  });

  test("vetting is chain-scoped: another chain's list never applies", async () => {
    const { VETTED_FEE_EXTENSIONS } = await import("../src/extensions/feeTrust.ts");
    (VETTED_FEE_EXTENSIONS as Record<string, readonly string[]>).mainnet = ["0xfee"];
    try {
      const onSepolia = await getEntryFeeTrust(
        stubContract(infoRead),
        { tournamentId: "7", hasEntryFee: true, extensionAddress: "0xfee" },
        { chain: "sepolia" },
      );
      expect(onSepolia.level).toBe("unvetted-extension");

      const noChain = await getEntryFeeTrust(stubContract(infoRead), {
        tournamentId: "7",
        hasEntryFee: true,
        extensionAddress: "0xfee",
      });
      expect(noChain.level).toBe("unvetted-extension");

      const onMainnet = await getEntryFeeTrust(
        stubContract(infoRead),
        { tournamentId: "7", hasEntryFee: true, extensionAddress: "0xfee" },
        { chain: "mainnet" },
      );
      expect(onMainnet.level).toBe("vetted-extension");
    } finally {
      (VETTED_FEE_EXTENSIONS as Record<string, readonly string[]>).mainnet = [];
    }
  });

  test("extension defaults to unvetted while the curated list is empty", async () => {
    const report = await getEntryFeeTrust(stubContract(infoRead), {
      tournamentId: "7",
      hasEntryFee: true,
      extensionAddress: "0xfee",
    });
    expect(report.level).toBe("unvetted-extension");
  });

  test("decodes a multi-chunk ByteArray license (data felts + empty pending)", async () => {
    // 62 bytes = exactly two 31-byte data chunks, nothing pending.
    const report = await getEntryFeeTrust(
      stubContract({
        tournament_protocol_fee_info: {
          license: {
            data: [
              0x657874656e73696f6e73206d7573742070617920746865206465636c617265n,
              0x642070726f746f636f6c2066656520746f2074686520726563697069656e74n,
            ],
            pending_word: 0n,
            pending_word_len: 0n,
          },
          fee_bps: 250n,
          recipient: 0xda0n,
        },
      }),
      { tournamentId: "7", hasEntryFee: true },
    );
    expect(report.protocolFeeLicense).toBe(
      "extensions must pay the declared protocol fee to the recipient",
    );
  });

  test("no entry fee short-circuits without any RPC read", async () => {
    // Stub with no readable entrypoints: any call would throw.
    const report = await getEntryFeeTrust(stubContract({}), {
      tournamentId: "7",
      hasEntryFee: false,
    });
    expect(report.level).toBe("none");
    expect(report.protocolFeeBps).toBe(0);
    expect(report.protocolFeeLicense).toBe("");
    expect(report.protocolFeeRecipient).toBe("0x" + "".padStart(64, "0"));
  });

  test("builtin fee stays custodial and contract-enforced", async () => {
    const report = await getEntryFeeTrust(stubContract(infoRead), {
      tournamentId: "7",
      hasEntryFee: true,
    });
    expect(report.level).toBe("custodial");
    expect(report.protocolFeeEnforcedOnChain).toBe(true);
  });
});
