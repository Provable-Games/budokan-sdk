import { num } from "starknet";

/**
 * Decode a Cairo `ByteArray` from a parsed `contract.call` result.
 *
 * starknet.js (the >=9 line this SDK pins) returns ByteArray members as the
 * raw struct `{ data: felt252[], pending_word: felt252, pending_word_len }`.
 * A string input is passed through untouched so versions that already parse
 * ByteArray to a JS string stay correct.
 */
export function decodeByteArray(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const obj = value as Record<string, unknown>;
  const data = obj.data as unknown[] | undefined;
  const pendingWord = obj.pending_word;
  const pendingWordLen = Number(obj.pending_word_len ?? 0);

  let result = "";

  // Each data element is a 31-byte chunk encoded as felt252
  if (data) {
    for (const chunk of data) {
      const hex = num.toHex(chunk as bigint).slice(2).padStart(62, "0");
      for (let i = 0; i < 62; i += 2) {
        const charCode = parseInt(hex.slice(i, i + 2), 16);
        if (charCode !== 0) result += String.fromCharCode(charCode);
      }
    }
  }

  // Pending word contains remaining bytes (< 31)
  if (pendingWord && pendingWordLen > 0) {
    const hex = num.toHex(pendingWord as bigint).slice(2).padStart(pendingWordLen * 2, "0");
    for (let i = 0; i < pendingWordLen * 2; i += 2) {
      const charCode = parseInt(hex.slice(i, i + 2), 16);
      if (charCode !== 0) result += String.fromCharCode(charCode);
    }
  }

  return result;
}
