// Shared types between the Mini App and the bot's HTTP API.
// Mirrors the response shapes in server/src/http.ts. Keep these in sync.

export type Chain = "mainnet" | "sepolia";

export interface PolicyMethod {
  entrypoint: string;
  description: string;
}

export interface PolicyBundle {
  contracts: Record<string, { methods: PolicyMethod[] }>;
}

export interface ConnectInfoResponse {
  chain: Chain;
  rpcUrl: string;
  policies: PolicyBundle;
  status: "pending";
}

// Body posted to POST /api/connect/<token> after Cartridge auth completes.
// Shape matches what server/src/http.ts:parseSessionBody expects.
export interface ConnectPostBody {
  address: string;
  username: string;
  ownerGuid: string;
  expiresAt: string;
  guardianKeyGuid: string;
  metadataHash: string;
  sessionKeyGuid: string;
  signer: { privKey: string; pubKey: string };
}
