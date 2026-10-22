import { isSolanaAddress } from './market.js';

// The caller supplies the report's actual token identities. Do not infer these
// from token names, user instructions, pool addresses or provider links.
// JS string indices already use the UTF-16 units required by Telegram entities.
export function withCopyableCAs(message, addresses) {
  if (typeof message.text !== 'string' || message.parse_mode) return message;
  const allowed = new Set(addresses.filter(isSolanaAddress));
  const entities = [...(message.entities ?? [])];
  const found = new Set();
  for (const match of message.text.matchAll(/^(?:Solana )?CA: ([1-9A-HJ-NP-Za-km-z]{32,44})$/gm)) {
    const address = match[1];
    if (!allowed.has(address)) continue;
    found.add(address);
    const offset = match.index + match[0].length - address.length;
    if (!entities.some((e) => e.offset < offset + address.length && offset < e.offset + e.length)) {
      entities.push({ type: 'code', offset, length: address.length });
    }
  }
  if (!found.size) return message;
  const result = { ...message, entities: entities.sort((a, b) => a.offset - b.offset) };
  // Keep any non-inline reply keyboard intact. Current token reports use only
  // inline controls; copy buttons never replace Monitor, Mute or Pause actions.
  if (message.reply_markup && !Array.isArray(message.reply_markup.inline_keyboard)) return result;
  const rows = message.reply_markup?.inline_keyboard ?? [];
  const existing = new Set(rows.flat().map((b) => b.copy_text?.text));
  const buttons = [...found].flatMap((address, i) => existing.has(address) ? [] : [[{
    text: found.size === 1 ? 'Copy CA' : `Copy CA ${i + 1} (${address.slice(0, 4)}…${address.slice(-4)})`,
    copy_text: { text: address },
  }]]);
  return { ...result, reply_markup: { ...message.reply_markup, inline_keyboard: [...rows, ...buttons] } };
}
