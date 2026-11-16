import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, respond, verifyBot, WELCOME } from '../src/bot.js';
import { openStore } from '../src/store.js';
import { createTelegram, isPermanentReplyError, TelegramError } from '../src/telegram.js';

const testToken = `12345:${'x'.repeat(30)}`; // Deliberately fake; no network calls in tests.
const update = (text, id = 42, type = 'private') => ({
  update_id: 1,
  message: { text, from: { id, is_bot: false }, chat: { id, type } },
});
// Context with no Claude and no market data: fixed replies only.
const ctx = (over = {}) => ({ allowedUserIds: new Set([42]), store: openStore(':memory:'), ...over });

test('configuration fails closed without a valid token or numeric tester IDs', () => {
  assert.throws(() => readConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42,wrong' }), /numeric IDs/);
  assert.throws(() => readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42, -1' }), /numeric IDs/);
  assert.equal(readConfig({ TELEGRAM_BOT_TOKEN: testToken }).allowedUserIds.size, 0);
  assert.deepEqual(readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42, 57' }).allowedUserIds, new Set([42, 57]));
  assert.deepEqual(readConfig({ TELEGRAM_BOT_TOKEN: testToken, SIFT_ALLOWED_USER_IDS: '42,' }).allowedUserIds, new Set([42]));
});

test('allowed tester receives the welcome, including a Telegram deep-link start', async () => {
  assert.equal((await respond(update('/start'), ctx())).text, WELCOME);
  assert.equal((await respond(update('/start@SiftAgentbot invitation'), ctx())).text, WELCOME);
  assert.match(WELCOME, /not live yet/);
});

test('unknown users cannot access tester replies but can retrieve only their own ID', async () => {
  assert.match((await respond(update('/start', 57), ctx())).text, /does not have tester access/);
  assert.match((await respond(update('/id', 57), ctx())).text, /user ID: 57/);
  assert.doesNotMatch((await respond(update('/id', 57), ctx())).text, /42/);
  assert.match((await respond(update('/criteria 10k liquidity', 57), ctx())).text, /does not have tester access/);
  assert.match((await respond(update('/check abc', 57), ctx())).text, /does not have tester access/);
  assert.notEqual((await respond(update('/start'), ctx({ allowedUserIds: new Set() }))).text, WELCOME);
});

test('groups, other bots, callbacks and non-text messages are ignored', async () => {
  assert.equal(await respond(update('/start', 42, 'supergroup'), ctx()), null);
  assert.equal(await respond(update('/start@OtherBot'), ctx()), null);
  assert.equal(await respond({ callback_query: {} }, ctx()), null);
  assert.equal(await respond(update(undefined), ctx()), null);
  const botUpdate = update('/start');
  botUpdate.message.from.is_bot = true;
  assert.equal(await respond(botUpdate, ctx()), null);
});

test('help, status and unsupported commands describe the actual capability', async () => {
  assert.match((await respond(update('/help'), ctx())).text, /\/check <token address>/);
  const status = (await respond(update('/status'), ctx())).text;
  assert.match(status, /Saved criteria: none saved/);
  assert.match(status, /Scheduled discovery: not connected/);
  assert.match(status, /No scans or alerts are running/);
  assert.match((await respond(update('/scan'), ctx())).text, /not available yet/);
  assert.match((await respond(update('find me coins'), ctx())).text, /not available yet/);
  for (const command of ['/constructor', '/toString', '/__proto__']) {
    assert.match((await respond(update(command), ctx())).text, /not available yet/);
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

test('replies Telegram permanently rejects are skipped so one update cannot stall polling', () => {
  for (const code of [400, 403]) assert.equal(isPermanentReplyError(new TelegramError(code)), true);
  // Misconfiguration must still stop the process; rate limits and outages must still retry.
  for (const code of [401, 404, 409, 429, 500, 502, 'NETWORK_OR_RESPONSE', 'STOPPED']) {
    assert.equal(isPermanentReplyError(new TelegramError(code)), false);
  }
  assert.equal(isPermanentReplyError(new Error('not from Telegram')), false);
});
