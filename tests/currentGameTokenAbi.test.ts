import { describe, expect, test } from "bun:test";
import { CallData, CairoCustomEnum, CairoOption, CairoOptionVariant } from "starknet";
import abi from "../src/rpc/abis/budokan.json";
import {
  buildEnterTournamentCall,
  buildEnterTournamentForRecipientsCall,
} from "../src/calldata/index.ts";

const encoder = new CallData(abi);
const some = <T>(value: T) => new CairoOption(CairoOptionVariant.Some, value);
const none = () => new CairoOption(CairoOptionVariant.None);
const felts = (values: readonly string[]) => values.map(BigInt);

describe("entry builders match the compiled Cairo ABI", () => {
  test("batch preserves repeated recipients and distinct qualification proofs", () => {
    const call = buildEnterTournamentForRecipientsCall("0x1234", {
      tournamentId: "9",
      recipients: [
        { playerAddress: "0xabc", qualifier: "0xabc", qualification: { kind: "extension", data: ["7", "0x123", "1"] } },
        { playerAddress: "0xabc", qualification: { kind: "nft", tokenId: (1n << 128n).toString() } },
        {},
      ],
    });
    const expected = encoder.compile("enter_tournament_for_recipients", {
      tournament_id: 9,
      recipients: [
        { player_address: some("0xabc"), qualifier: some("0xabc"), qualification: some(new CairoCustomEnum({ NFT: undefined, Extension: ["7", "0x123", "1"] })) },
        { player_address: some("0xabc"), qualifier: none(), qualification: some(new CairoCustomEnum({ NFT: { token_id: { low: 0, high: 1 } }, Extension: undefined })) },
        { player_address: none(), qualifier: none(), qualification: none() },
      ],
    });
    expect(call.entrypoint).toBe("enter_tournament_for_recipients");
    expect(felts(call.calldata as string[])).toEqual(felts(expected));
  });

  test("single entry carries extension fee pay parameters", () => {
    const call = buildEnterTournamentCall("0x1234", {
      tournamentId: "9", playerAddress: "0xabc", entryFeePayParams: ["7", "8"],
    });
    const expected = encoder.compile("enter_tournament", {
      tournament_id: 9, player_address: some("0xabc"), qualifier: none(),
      qualification: none(), entry_fee_pay_params: some(["7", "8"]),
    });
    expect(felts(call.calldata as string[])).toEqual(felts(expected));
  });

  test("empty and oversized batches are rejected before encoding", () => {
    expect(() => buildEnterTournamentForRecipientsCall("0x1234", { tournamentId: "9", recipients: [] })).toThrow();
    expect(() => buildEnterTournamentForRecipientsCall("0x1234", { tournamentId: "9", recipients: Array.from({ length: 2049 }, () => ({})) })).toThrow();
  });
});
