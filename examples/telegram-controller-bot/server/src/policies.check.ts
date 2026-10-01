// Exercise the actual SDK call against the bot's session policies.
import assert from "node:assert/strict";
import { buildEnterTournamentForRecipientsCall } from "@provable-games/budokan-sdk";
import { buildSessionPolicies, parsedPoliciesFor } from "./policies.ts";

const address = "0x1234";
const call = buildEnterTournamentForRecipientsCall(address, {
  tournamentId: "1", recipients: [{ playerAddress: "0xab" }],
});
const bundle = buildSessionPolicies("sepolia", address);
assert(bundle.contracts[call.contractAddress]!.methods
  .some((method) => method.entrypoint === call.entrypoint));
assert(parsedPoliciesFor("sepolia", address).contracts[call.contractAddress]!.methods
  .find((method) => method.entrypoint === call.entrypoint)?.authorized);
console.log("Batch entry session policies match the SDK call");
