import type { RpcProvider, Contract } from "starknet";

let starknetModule: typeof import("starknet") | null = null;
let useObjectConstructor: boolean | null = null;

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
  abi: unknown[],
  address: string,
  provider: RpcProvider,
): Promise<Contract> {
  // Handle case where ABI might be wrapped in a default export
  let resolvedAbi = abi;
  if (abi && !Array.isArray(abi) && typeof abi === "object" && "default" in abi) {
    resolvedAbi = (abi as { default: unknown[] }).default;
  }

  const starknet = await getStarknet();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StarknetContract = starknet.Contract as any;

  // Detect constructor style once and cache result
  if (useObjectConstructor === null) {
    // Try object format first (v7+), catch and try positional (v6.x)
    try {
      const contract = new StarknetContract({
        abi: resolvedAbi,
        address,
        providerOrAccount: provider,
      });
      // Object format works (v7+)
      useObjectConstructor = true;
      return contract as Contract;
    } catch {
      // Object format failed, use positional (v6.x)
      useObjectConstructor = false;
      return new StarknetContract(resolvedAbi, address, provider) as Contract;
    }
  }

  // Use cached constructor style
  if (useObjectConstructor) {
    return new StarknetContract({
      abi: resolvedAbi,
      address,
      providerOrAccount: provider,
    }) as Contract;
  } else {
    return new StarknetContract(resolvedAbi, address, provider) as Contract;
  }
}
