import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorker } from '../src/worker.js';
import { SECRET_HEADER, webhookSecret, isAuthenticated } from '../src/webhook-auth.js';
import { setupWebhook } from '../scripts/setup-webhook.js';
import { WELCOME } from '../src/bot.js';

const token = `12345:${'x'.repeat(30)}`; // Fake credentials. All outbound requests are mocked.
const env = { TELEGRAM_BOT_TOKEN: token, SIFT_ALLOWED_USER_IDS: '42' };
const origin = 'https://sift-bot.test-account.workers.dev';
const secret = await webhookSecret(token);
const identity = { is_bot: true, username: 'SiftAgentbot' };
const api = (result) => Response.json({ ok: true, result });
const update = (text = '/start', id = 42, type = 'private') => ({
  update_id: 1, message: { text, from: { id, is_bot: false }, chat: { id, type } },
});
const request = (body = update(), headers = {}, path = '/telegram', method = 'POST') =>
  new Request(origin + path, {
    method, headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret, ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
const noNetwork = async () => { assert.fail('Unexpected outbound request'); };

test('webhook credential matches standard HMAC and rejects missing, malformed or wrong secrets', async () => {
  assert.equal(secret, createHmac('sha256', token).update('sift:telegram-webhook:v1').digest('hex'));
  assert.equal(await isAuthenticated(token, secret), true);
  for (const value of [null, '', token, 'f'.repeat(64), secret + '0']) {
    assert.equal(await isAuthenticated(token, value), false);
  }
  assert.equal(await isAuthenticated(token + 'x', secret), false);
});

test('public health reports liveness only; webhook routes fail closed without configuration and authentication', async () => {
  const worker = createWorker({ fetchImpl: noNetwork });
  const health = await worker.fetch(new Request(origin + '/health'), {});
  assert.deepEqual(await health.json(), { service: 'sift-bot', status: 'deployed' });
  assert.equal((await worker.fetch(request(), {})).status, 503);
  assert.equal((await worker.fetch(request(), { ...env, SIFT_ALLOWED_USER_IDS: 'bad' })).status, 503);
  for (const header of ['', 'f'.repeat(64)]) {
    assert.equal((await worker.fetch(request(update(), { [SECRET_HEADER]: header }), env)).status, 401);
    assert.equal((await worker.fetch(request(null, { [SECRET_HEADER]: header }, '/ready', 'GET'), env)).status, 401);
  }
  assert.equal((await worker.fetch(new Request(origin + '/telegram'), env)).status, 405);
  assert.equal((await worker.fetch(new Request(origin + '/missing'), env)).status, 404);
});

test('readiness checks actual bot identity and configured tester access', async () => {
  for (const [bot, config, expected] of [
    [identity, env, 200],
    [{ is_bot: true, username: 'OtherBot' }, env, 503],
    [identity, { TELEGRAM_BOT_TOKEN: token }, 503],
  ]) {
    const worker = createWorker({ fetchImpl: async (url) => {
      assert.ok(url.endsWith('/getMe'));
      return api(bot);
    } });
    const response = await worker.fetch(request(null, {}, '/ready', 'GET'), config);
    assert.equal(response.status, expected);
  }
});

test('authenticated commands preserve approved replies and separate unlisted users', async () => {
  const sent = [];
  const worker = createWorker({ fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sendMessage'));
    sent.push(JSON.parse(options.body));
    return api({ message_id: 1 });
  } });
  for (const input of [update(), update('/status'), update('/help'), update('/start', 57), update('/id', 57)]) {
    assert.equal((await worker.fetch(request(input), env)).status, 200);
  }
  assert.equal(sent[0].text, WELCOME);
  assert.match(sent[1].text, /No scans or alerts/);
  assert.match(sent[2].text, /\/help/);
  assert.equal(sent[3].chat_id, 57);
  assert.match(sent[3].text, /does not have tester access/);
  assert.match(sent[4].text, /user ID: 57/);
  assert.doesNotMatch(sent[4].text, /42/);
});

test('groups and unsupported updates are acknowledged without sending a message', async () => {
  const worker = createWorker({ fetchImpl: noNetwork });
  for (const input of [update('/start', 42, 'supergroup'), update('/start@OtherBot'),
    { update_id: 1, callback_query: {} }, { update_id: 1 }]) {
    assert.equal((await worker.fetch(request(input), env)).status, 200);
  }
});

test('malformed JSON, missing update IDs and oversized streamed bodies are rejected', async () => {
  const worker = createWorker({ fetchImpl: noNetwork });
  for (const input of ['{', {}, null, { update_id: -1 }, { update_id: 1.1 }]) {
    assert.equal((await worker.fetch(request(input), env)).status, 400);
  }
  assert.equal((await worker.fetch(request(update(), { 'content-type': 'text/plain' }), env)).status, 415);
  // No Content-Length header: the bound applies while consuming the body.
  assert.equal((await worker.fetch(request('x'.repeat(1024 * 1024 + 1)), env)).status, 413);
});

test('a successful webhook response waits for Telegram to confirm the reply', async () => {
  let release, started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { started = resolve; });
  const worker = createWorker({ fetchImpl: async () => { started(); await waiting; return api({ message_id: 1 }); } });
  let complete = false;
  const response = worker.fetch(request(), env).then((value) => { complete = true; return value; });
  await reached;
  assert.equal(complete, false);
  release();
  assert.equal((await response).status, 200);
});

test('blocked chats are acknowledged; API and network failures remain retryable without leaking secrets', async () => {
  for (const code of [403, 429, 401, 500, 'network']) {
    const worker = createWorker({ fetchImpl: async () => {
      if (code === 'network') throw new Error(token + secret);
      return Response.json({ ok: false, error_code: code, description: token + secret }, { status: code });
    } });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, code === 403 ? 200 : 503);
    const body = await response.text();
    assert.ok(!body.includes(token) && !body.includes(secret));
  }
});

function setupFixture({ existing = '', bot = identity, workerEnv = env, readyFailure = false, setResult = true } = {}) {
  const calls = [];
  let webhook = existing;
  const fetchImpl = async (url, options) => {
    if (url === origin + '/ready') {
      calls.push({ method: 'ready' });
      assert.equal(options.redirect, 'error');
      if (readyFailure) throw new Error(token + secret);
      return createWorker({ fetchImpl }).fetch(new Request(url, options), workerEnv);
    }
    assert.ok(url.startsWith(`https://api.telegram.org/bot${token}/`));
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === 'getMe') return api(bot);
    if (method === 'getWebhookInfo') return api({ url: webhook, pending_update_count: 0 });
    if (method === 'setWebhook') { webhook = body.url; return api(setResult); }
    assert.fail('Unexpected API method');
  };
  return { calls, fetchImpl };
}

test('setup preflights the deployed worker before registering, preserving pending updates', async () => {
  const { calls, fetchImpl } = setupFixture();
  assert.deepEqual(await setupWebhook({ env, workerUrl: origin, fetchImpl }), { pendingUpdates: 0 });
  assert.deepEqual(calls.map((c) => c.method), ['getMe', 'getWebhookInfo', 'ready', 'getMe', 'setWebhook', 'getWebhookInfo']);
  assert.deepEqual(calls.find((c) => c.method === 'setWebhook').body, {
    url: origin + '/telegram', secret_token: secret, allowed_updates: ['message'],
    max_connections: 1, drop_pending_updates: false,
  });
});

test('setup refuses other hosts, existing deployments, wrong bots and unready workers before mutation', async () => {
  for (const workerUrl of [undefined, 'http://sift-bot.test-account.workers.dev', 'https://example.com',
    origin + '/telegram', origin + '?secret=x', 'https://user:pass@sift-bot.test-account.workers.dev']) {
    await assert.rejects(setupWebhook({ env, workerUrl, fetchImpl: noNetwork }));
  }
  for (const options of [
    { existing: 'https://another.example/telegram' }, { bot: { is_bot: true, username: 'OtherBot' } },
    { workerEnv: {} }, { workerEnv: { ...env, SIFT_ALLOWED_USER_IDS: '' } }, { readyFailure: true },
  ]) {
    const { calls, fetchImpl } = setupFixture(options);
    await assert.rejects(setupWebhook({ env, workerUrl: origin, fetchImpl }), (error) => {
      assert.ok(!error.message.includes(token) && !error.message.includes(secret));
      return true;
    });
    assert.ok(!calls.some((c) => c.method === 'setWebhook'));
  }
});

test('setup can register the same target again and never claims success without confirmation', async () => {
  const same = setupFixture({ existing: origin + '/telegram' });
  await setupWebhook({ env, workerUrl: origin, fetchImpl: same.fetchImpl });
  const unconfirmed = setupFixture({ setResult: false });
  await assert.rejects(setupWebhook({ env, workerUrl: origin, fetchImpl: unconfirmed.fetchImpl }), /did not confirm/);
});
