import test from 'node:test';
import assert from 'node:assert/strict';
import { withCopyableCAs } from '../src/telegram-format.js';

const CA = '1'.repeat(31) + '2';
const OTHER = '1'.repeat(31) + '3';
const POOL = '1'.repeat(31) + '4';
const copied = (message) => message.reply_markup.inline_keyboard.flat().filter((b) => b.copy_text).map((b) => b.copy_text.text);

test('CA formatting copies only the actual mint, with UTF-16 offsets after emoji and literal provider markup', () => {
  const text = `🟡 Sift · <b>untrusted</b> & _text_\nCA: ${OTHER}\n\nSolana CA: ${CA}\nPool: ${POOL}\nSource: https://example.invalid/${CA}`;
  const original = { chat_id: 42, text, link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: 'Monitor', callback_data: 'existing-control' }]] } };
  const before = structuredClone(original);
  const result = withCopyableCAs(original, [CA]);
  assert.equal(result.text, text);
  assert.equal(result.parse_mode, undefined);
  assert.deepEqual(result.entities, [{ type: 'code', offset: text.indexOf(CA), length: CA.length }]);
  assert.deepEqual(copied(result), [CA]);
  assert.deepEqual(result.reply_markup.inline_keyboard[0], original.reply_markup.inline_keyboard[0]);
  assert.deepEqual(original, before);
  assert.deepEqual(withCopyableCAs(result, [CA]), result);
});

test('multi-coin messages keep copy buttons in display order and duplicate CA lines copy one whole address', () => {
  const message = { text: `CA: ${OTHER}\n\nCA: ${CA}\nSolana CA: ${OTHER}` };
  const result = withCopyableCAs(message, [CA, OTHER, OTHER]);
  assert.deepEqual(copied(result), [OTHER, CA]);
  assert.deepEqual(result.entities.map((e) => result.text.slice(e.offset, e.offset + e.length)), [OTHER, CA, OTHER]);
  assert.match(result.reply_markup.inline_keyboard[0][0].text, /Copy CA 1/);
  assert.match(result.reply_markup.inline_keyboard[1][0].text, /Copy CA 2/);
  assert.ok(result.reply_markup.inline_keyboard.flat().every((b) => !b.callback_data && !b.url));
});

test('unknown tokens, addresses embedded in links and truncated CAs never create misleading clipboard buttons', () => {
  for (const text of [`CA: ${OTHER}`, `https://example.invalid/${CA}`, `CA: ${CA}trailing`, 'CA: not-a-mint', `Pool: ${CA}`]) {
    const message = { text };
    assert.equal(withCopyableCAs(message, [CA, 'not-a-mint', undefined]), message);
  }
});
