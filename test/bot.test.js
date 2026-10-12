import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, replyFor, verifyBot, WELCOME } from '../src/bot.js';
import { createTelegram, TelegramError } from '../src/telegram.js';

const testToken = `12345:${'x'.repeat(30)}`; // Deliberately fake; no network calls in tests.
const allowed = new Set([42]);
const update = (text, id = 42, type = 'private') => ({
  update_id: 1,
  message: { text, from: { id, is_bot: false }, chat: { id, type } },
});

test('configuration fails closed without a valid token or numeric tester IDs', () => {
  assert.throws(() => readConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42,wrong' }), /numeric IDs/);
  assert.equal(readConfig({ TELEGRAM_BOT_TOKEN: testToken }).allowedUserIds.size, 0);
  assert.deepEqual(readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42, 57' }).allowedUserIds, new Set([42, 57]));
});

test('allowed tester receives the welcome, including a Telegram deep-link start', () => {
  assert.equal(replyFor(update('/start'), allowed).text, WELCOME);
  assert.equal(replyFor(update('/start@SiftAgentbot invitation'), allowed).text, WELCOME);
  assert.match(WELCOME, /not live yet/);
});

test('unknown users cannot access tester replies but can retrieve only their own ID', () => {
  assert.match(replyFor(update('/start', 57), allowed).text, /does not have tester access/);
  assert.match(replyFor(update('/id', 57), allowed).text, /user ID: 57/);
  assert.doesNotMatch(replyFor(update('/id', 57), allowed).text, /42/);
  assert.notEqual(replyFor(update('/start'), new Set()).text, WELCOME);
});

test('groups, other bots, callbacks and non-text messages are ignored', () => {
  assert.equal(replyFor(update('/start', 42, 'supergroup'), allowed), null);
  assert.equal(replyFor(update('/start@OtherBot'), allowed), null);
  assert.equal(replyFor({ callback_query: {} }, allowed), null);
  assert.equal(replyFor(update(undefined), allowed), null);
  const botUpdate = update('/start');
  botUpdate.message.from.is_bot = true;
  assert.equal(replyFor(botUpdate, allowed), null);
});

test('help, status and unsupported commands describe the actual capability', () => {
  assert.match(replyFor(update('/help'), allowed).text, /\/status/);
  assert.match(replyFor(update('/status'), allowed).text, /explicit activation required/);
  assert.match(replyFor(update('/scan'), allowed).text, /not available yet/);
  assert.match(replyFor(update('find me coins'), allowed).text, /not available yet/);
  for (const command of ['/constructor', '/toString', '/__proto__']) {
    assert.equal(typeof replyFor(update(command), allowed).text, 'string');
    assert.match(replyFor(update(command), allowed).text, /not available yet/);
  }
});

test('identity and webhook checks prevent running the wrong bot or overriding a deployment', () => {
  assert.doesNotThrow(() => verifyBot({ username: 'SiftAgentbot', is_bot: true }, { url: '' }));
  assert.throws(() => verifyBot({ username: 'OtherBot', is_bot: true }, { url: '' }), /does not belong/);
  assert.throws(() => verifyBot({ username: 'SiftAgentbot', is_bot: true }, { url: 'https://example.com/hook' }), /webhook/);
  assert.throws(() => verifyBot({ username: 'SiftAgentbot', is_bot: true }, {}), /could not be verified/);
});

test('transport uses POST with JSON and returns the API result', async () => {
  const call = createTelegram(testToken, { fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sendMessage'));
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { chat_id: 42, text: 'hello' });
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  } });
  assert.deepEqual(await call('sendMessage', { chat_id: 42, text: 'hello' }), { message_id: 99 });
});

test('API rate limits retain retry information but not response descriptions', async () => {
  const call = createTelegram(testToken, { fetchImpl: async () => ({
    ok: false, status: 429,
    json: async () => ({ ok: false, error_code: 429, description: testToken, parameters: { retry_after: 7 } }),
  }) });
  await assert.rejects(call('getUpdates'), (error) => {
    assert.equal(error.code, 429);
    assert.equal(error.retryAfter, 7);
    assert.ok(!error.message.includes(testToken));
    return true;
  });
});

test('network failures and invalid JSON never expose the token in error messages', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`request failed https://api.telegram.org/bot${testToken}/getMe`); },
    async () => ({ ok: true, json: async () => { throw new Error(testToken); } }),
  ]) {
    const call = createTelegram(testToken, { fetchImpl });
    await assert.rejects(call('getMe'), (error) => {
      assert.ok(error instanceof TelegramError);
      assert.ok(!error.stack.includes(testToken));
      return true;
    });
  }
});
