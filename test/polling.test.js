import test from 'node:test';
import assert from 'node:assert/strict';
import { runPolling } from '../src/polling.js';
import { TelegramError } from '../src/telegram.js';

const silent = { warn() {} };
const message = (update_id, chat = 111) => ({ update_id, message: { text: '/start', from: { id: chat, is_bot: false }, chat: { id: chat, type: 'private' } } });

// Fake Telegram: serves `updates` until all are confirmed, then stops polling.
// `send` decides what each sendMessage call does.
function fakeTelegram(updates, send = () => ({ message_id: 1 })) {
  const controller = new AbortController();
  const sent = [];
  const offsets = [];
  const call = async (method, body) => {
    if (method === 'getUpdates') {
      offsets.push(body.offset);
      const pending = updates.filter((u) => u.update_id >= body.offset);
      if (pending.length === 0 || offsets.length > 20) controller.abort();
      return pending;
    }
    if (method === 'sendMessage') {
      sent.push(body.chat_id);
      const result = send(body, sent.length);
      if (result instanceof Error) throw result;
      return result;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, signal: controller.signal, sent, offsets };
}
const noSleep = async () => {};
const reply = (update) => ({ chat_id: update.message.chat.id, text: 'hi' });

test('a reply Telegram permanently rejects is skipped and later updates are answered', async () => {
  const telegram = fakeTelegram([message(1, 111), message(2, 222)], (body) => (body.chat_id === 111 ? new TelegramError(400) : {}));
  await runPolling({ ...telegram, handleUpdate: reply, log: silent, sleep: noSleep });
  assert.deepEqual(telegram.sent, [111, 222]);
  assert.equal(telegram.offsets.at(-1), 3);
});

test('retrying after a failed send reuses the reply instead of handling the update again', async () => {
  let handled = 0;
  const telegram = fakeTelegram([message(1)], (_body, n) => (n === 1 ? new TelegramError(500) : {}));
  await runPolling({ ...telegram, handleUpdate: (u) => { handled += 1; return reply(u); }, log: silent, sleep: noSleep });
  assert.equal(handled, 1); // one (possibly paid) interpretation
  assert.deepEqual(telegram.sent, [111, 111]); // delivered on the retry
});

test('rate limits wait for Telegram retry_after before retrying', async () => {
  const waits = [];
  const telegram = fakeTelegram([message(1)], (_body, n) => (n === 1 ? new TelegramError(429, 7) : {}));
  await runPolling({ ...telegram, handleUpdate: reply, log: silent, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [7000]);
  assert.deepEqual(telegram.sent, [111, 111]);
});

test('an unexpected error handling one update skips it instead of stalling polling', async () => {
  const logs = [];
  const telegram = fakeTelegram([message(1, 111), message(2, 222)]);
  const handleUpdate = (u) => { if (u.update_id === 1) throw new Error('secret detail'); return reply(u); };
  await runPolling({ ...telegram, handleUpdate, log: { warn: (m) => logs.push(m) }, sleep: noSleep });
  assert.deepEqual(telegram.sent, [222]);
  assert.equal(telegram.offsets.at(-1), 3);
  assert.deepEqual(logs, ['An update could not be processed and was skipped.']);
});

test('misconfiguration stops polling instead of retrying', async () => {
  for (const code of [401, 404, 409]) {
    const call = async () => { throw new TelegramError(code); };
    await assert.rejects(
      runPolling({ call, signal: new AbortController().signal, handleUpdate: reply, log: silent, sleep: noSleep }),
      (error) => error.code === code,
    );
  }
});

test('shutdown during a retry wait ends polling cleanly', async () => {
  const controller = new AbortController();
  const call = async () => { throw new TelegramError(500); };
  const sleep = async () => { controller.abort(); throw new Error('AbortError'); };
  await runPolling({ call, signal: controller.signal, handleUpdate: reply, log: silent, sleep });
});
