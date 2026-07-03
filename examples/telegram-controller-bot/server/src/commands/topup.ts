// /topup — hand the user a channel-agnostic top-up deeplink for their wallet.
//
// The top-up app takes the destination straight from `?address=` (no connection
// gate — the calling app owns being connected and supplies the address) and
// redirects to `?returnUrl=` on success. The exact same link works from every
// channel; the bot just supplies the user's connected address (or one they
// pass) plus a return link back into this bot's DM.

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { TelegramApi } from "../telegram-api.ts";
import type { SessionStore } from "../session-store.ts";

// Basic Starknet address sanity check for a user-supplied `/topup <address>`.
// The top-up app re-validates + normalizes before sending funds; this just gives
// instant feedback instead of bouncing the user to the app to see the error.
const STARKNET_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export async function topup(
  api: TelegramApi,
  config: Config,
  sessions: SessionStore,
  chatId: string,
  chain: Chain,
  args: string[],
  botUsername: string,
): Promise<void> {
  if (!config.topupUrl) {
    await api.sendMessage(chatId, "Top-up isn't configured on this bot yet.");
    return;
  }

  let address = args[0]?.trim();
  if (address) {
    if (!STARKNET_ADDRESS.test(address)) {
      await api.sendMessage(
        chatId,
        "That doesn't look like a Starknet address. Usage: /topup [0x… address] — omit it to top up your connected wallet.",
      );
      return;
    }
  } else {
    const session = await sessions.get(chatId, chain);
    if (!session) {
      await api.sendMessage(
        chatId,
        `Not connected on ${chain} — run /connect first, or pass an address: /topup <0x…>.`,
      );
      return;
    }
    address = session.session.address;
  }

  // Send the user back to this bot's DM after a successful top-up.
  const returnUrl = botUsername ? `https://t.me/${botUsername}` : config.botPublicUrl;
  const url = buildTopupUrl(config.topupUrl, address, returnUrl);

  await api.sendMessage(chatId, `💰 Top up your wallet:\n${url}`, {
    replyMarkup: { inline_keyboard: [[{ text: "💰 Top up", url }]] },
  });
}

/** Append `address` + `returnUrl` to the configured top-up endpoint. */
export function buildTopupUrl(base: string, address: string, returnUrl: string): string {
  const u = new URL(base);
  u.searchParams.set("address", address);
  u.searchParams.set("returnUrl", returnUrl);
  return u.toString();
}
