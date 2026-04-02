import type { RpcProvider, Contract, Abi } from "starknet";

let starknetModule: typeof import("starknet") | null = null;

async function getStarknet(): Promise<typeof import("starknet")> {
  if (!starknetModule) {
    starknetModule = await import("starknet");
  }
  return starknetModule;
}

export async function createProvider(rpcUrl: string): Promise<RpcProvider> {
  const { RpcProvider: StarknetRpcProvider } = await getStarknet();
  const provider = new StarknetRpcProvider({ nodeUrl: rpcUrl });
  return provider;
}

export async function createContract(
  abi: Abi,
  address: string,
  provider: RpcProvider,
): Promise<Contract> {
  // Handle case where ABI might be wrapped in a default export
  let resolvedAbi: Abi = abi;
  if (abi && !Array.isArray(abi) && typeof abi === "object" && "default" in abi) {
    resolvedAbi = (abi as { default: Abi }).default;
  }

  const starknet = await getStarknet();

  return new starknet.Contract({ abi: resolvedAbi, address, providerOrAccount: provider });
}
