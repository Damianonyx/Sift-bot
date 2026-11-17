// Builds Telegram sendMessage payloads. Text is capped at Telegram's limit
// (a longer text is rejected outright, so the reply would be lost). Given
// substrings such as token addresses are marked as `code`, which Telegram
// apps copy with one tap. Because explicit entities can replace Telegram's
// automatic link detection, every https:// URL is also marked as a `url`
// entity so links stay clickable. Offsets are UTF-16 code units, which is
// what both JavaScript strings and the Bot API use.
export const TELEGRAM_TEXT_LIMIT = 4096;
const SHORTENED = '\n… (message shortened)';

function cap(text) {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  let end = TELEGRAM_TEXT_LIMIT - SHORTENED.length;
  // Never cut a surrogate pair in half: a lone surrogate is invalid text.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + SHORTENED;
}

export function telegramMessage(chatId, text, copyable = []) {
  const body = cap(String(text));
  const entities = [];
  for (const value of new Set(copyable.filter((v) => typeof v === 'string' && v.length > 0))) {
    for (let at = body.indexOf(value); at !== -1; at = body.indexOf(value, at + value.length)) {
      entities.push({ type: 'code', offset: at, length: value.length });
    }
  }
  for (const match of body.matchAll(/https:\/\/[^\s]+/g)) {
    entities.push({ type: 'url', offset: match.index, length: match[0].length });
  }
  // Entities must not overlap; keep the first of any overlapping pair.
  entities.sort((a, b) => a.offset - b.offset);
  const kept = [];
  for (const entity of entities) {
    const last = kept.at(-1);
    if (!last || entity.offset >= last.offset + last.length) kept.push(entity);
  }
  return kept.length ? { chat_id: chatId, text: body, entities: kept } : { chat_id: chatId, text: body };
}
