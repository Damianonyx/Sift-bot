import test from 'node:test';
import assert from 'node:assert/strict';
import { TELEGRAM_TEXT_LIMIT, telegramMessage } from '../src/message.js';

const CA = 'EsG6M94etoDyjZRWp3JPj7mzR21s865NZrdr1vwJpump';
const slice = (msg, e) => msg.text.slice(e.offset, e.offset + e.length);

test('plain text without addresses or links carries no entities', () => {
  assert.deepEqual(telegramMessage(42, 'hello'), { chat_id: 42, text: 'hello' });
});

test('addresses become tap-to-copy code and links stay clickable', () => {
  const text = `Token: ${CA}\nhttps://www.geckoterminal.com/solana/pools/abc\n✓ ≥ $5,000`;
  const msg = telegramMessage(42, text, [CA]);
  assert.deepEqual(msg.entities.map((e) => [e.type, slice(msg, e)]), [
    ['code', CA],
    ['url', 'https://www.geckoterminal.com/solana/pools/abc'],
  ]);
});

test('offsets are UTF-16 based, so emoji before an address do not shift it', () => {
  const text = `🚀🚀 MOON / SOL\nToken: ${CA}`;
  const msg = telegramMessage(42, text, [CA]);
  assert.equal(slice(msg, msg.entities[0]), CA);
});

test('every occurrence is marked, and overlapping entities are dropped', () => {
  const msg = telegramMessage(42, `${CA} and again ${CA}`, [CA, CA.slice(0, 10)]);
  assert.equal(msg.entities.length, 2);
  assert.ok(msg.entities.every((e) => slice(msg, e) === CA));
});

test('over-long text is capped at the Telegram limit without splitting a surrogate pair', () => {
  // Place the cut exactly on the first half of an emoji's surrogate pair.
  const cutAt = TELEGRAM_TEXT_LIMIT - '\n\u2026 (message shortened)'.length;
  const long = 'x'.repeat(cutAt - 1) + '\ud83d\ude80'.repeat(50);
  const msg = telegramMessage(42, long, []);
  assert.ok(msg.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.match(msg.text, /message shortened\)$/);
  assert.doesNotMatch(msg.text, /[\ud800-\udbff](?![\udc00-\udfff])/); // no lone high surrogate
  // An address cut off by the cap gets no entity pointing past the text.
  const cut = telegramMessage(42, 'y'.repeat(TELEGRAM_TEXT_LIMIT) + CA, [CA]);
  assert.equal(cut.entities, undefined);
});
