import { expect, test } from "bun:test";
import { buildEnterTournamentForRecipientsCall } from "@provable-games/budokan-sdk";
import { buildSessionPolicies, parsedPoliciesFor } from "./policies.ts";

test("batch entry is authorized for the configured Budokan deployment", () => {
  const address = "0x1234";
  const call = buildEnterTournamentForRecipientsCall(address, {
    tournamentId: "1", recipients: [{ playerAddress: "0xab" }],
  });
  const bundle = buildSessionPolicies("sepolia", address);
  expect(bundle.contracts[call.contractAddress]!.methods.map((method) => method.entrypoint))
    .toContain(call.entrypoint);
  expect(parsedPoliciesFor("sepolia", address).contracts[call.contractAddress]!.methods
    .find((method) => method.entrypoint === call.entrypoint)?.authorized).toBe(true);
});
