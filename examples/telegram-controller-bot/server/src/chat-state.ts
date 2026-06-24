// Per-chat preferences. Today this is just the active chain. Stored as
// `<dataDir>/chats/<chatId>/state.json`. New chats default to the bot's
// configured BUDOKAN_CHAIN (the deploy-time chain).
//
// Sessions are stored separately and namespaced by chain
// (`<dataDir>/sessions/<chain>/<chatId>/session.json`) so a user can have
// distinct sessions on mainnet and sepolia without collision.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export type Chain = "mainnet" | "sepolia";
export const SUPPORTED_CHAINS: readonly Chain[] = ["mainnet", "sepolia"] as const;

export function isChain(value: string): value is Chain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

interface ChatState {
  chain: Chain;
}

export class ChatStateStore {
  constructor(
    private readonly rootDir: string,
    private readonly defaultChain: Chain,
  ) {}

  async getChain(chatId: string): Promise<Chain> {
    const state = await this.read(chatId);
    return state?.chain ?? this.defaultChain;
  }

  async setChain(chatId: string, chain: Chain): Promise<void> {
    await this.write(chatId, { chain });
  }

  private async read(chatId: string): Promise<ChatState | null> {
    const file = this.fileFor(chatId);
    if (!existsSync(file)) return null;
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<ChatState>;
      if (typeof parsed.chain === "string" && isChain(parsed.chain)) {
        return { chain: parsed.chain };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async write(chatId: string, state: ChatState): Promise<void> {
    const file = this.fileFor(chatId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  }

  private fileFor(chatId: string): string {
    if (!/^-?\d+$/.test(chatId)) {
      throw new Error(`Invalid chatId for chat state: ${chatId}`);
    }
    return join(this.rootDir, "chats", chatId, "state.json");
  }
}
