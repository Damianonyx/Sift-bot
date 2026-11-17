import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { runPreflight } from '../src/preflight.js';
import { openStore } from '../src/store.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const TOKEN = `12345:${'x'.repeat(30)}`;
const GOOD_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, SIFT_ALLOWED_USER_IDS: '42', ANTHROPIC_API_KEY: 'k', SIFT_DATA_DIR: ':memory:' };
const PROPOSAL = {
  rules: [
    { field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: 'at least 10k liquidity' },
    { field: 'marketCapUsd', op: 'lte', value: 2_000_000, severity: 'require', evidence: 'market cap under 2m' },
  ],
  unresolved: [],
};
const answer = (payload) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] });
const claudeClient = (handler) => ({ beta: { messages: { create: async (params) => handler(params) } } });
const goodClaude = claudeClient((params) => answer(params.system.startsWith('You route') ? { command: 'help' } : PROPOSAL));

// One fake for every HTTP service the preflight touches.
function fakeFetch({ webhook = '', telegramStatus = 200 } = {}) {
  const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  return async (url) => {
    if (url.includes('api.telegram.org')) {
      if (telegramStatus !== 200) return json({ ok: false, error_code: telegramStatus }, telegramStatus);
      if (url.endsWith('/getMe')) return json({ ok: true, result: { is_bot: true, username: 'SiftAgentbot' } });
      if (url.endsWith('/getWebhookInfo')) return json({ ok: true, result: { url: webhook } });
    }
    if (url.includes('/tokens/v1/solana/')) return json(fixture('dexscreener-v1-batch.json'));
    if (url.includes('/latest/dex/tokens/')) return json(fixture('dexscreener-bonk.json'));
    if (url.includes('geckoterminal.com')) return json(fixture('geckoterminal-new-pools.json'));
    throw new Error(`unexpected ${url}`);
  };
}
async function run(over = {}) {
  const lines = [];
  const result = await runPreflight({
    env: GOOD_ENV, nodeVersion: '24.11.0', fetchImpl: fakeFetch(), claudeClient: goodClaude,
    openStoreFn: () => openStore(':memory:'), out: (line) => lines.push(line), ...over,
  });
  return { ...result, text: lines.join('\n') };
}

test('everything configured: every check passes and says ready', async () => {
  const { failures, warnings, text } = await run();
  assert.equal(failures, 0, text);
  assert.equal(warnings, 0, text);
  for (const label of ['Node.js', 'Configuration', 'Telegram', 'Storage', 'Claude routing', 'Claude criteria',
    'DexScreener token lookup', 'DexScreener batch lookup', 'GeckoTerminal new pools']) {
    assert.match(text, new RegExp(`^\\u2713 ${label}`, 'm'), label);
  }
  assert.match(text, /Ready for private testing\.$/);
  assert.match(text, /"what can you do\?" → help/);
});

test('missing Anthropic key fails: testers could not create criteria', async () => {
  const { ANTHROPIC_API_KEY, ...env } = GOOD_ENV;
  const { failures, text } = await run({ env });
  assert.equal(failures, 1);
  assert.match(text, /✗ Claude — ANTHROPIC_API_KEY is not set/);
});

test('every problem is reported, even when several checks fail at once', async () => {
  const { ANTHROPIC_API_KEY, ...env } = GOOD_ENV;
  const { failures, text } = await run({ env, fetchImpl: fakeFetch({ telegramStatus: 401 }) });
  assert.equal(failures, 2);
  assert.match(text, /\u2717 Telegram/);
  assert.match(text, /\u2717 Claude \u2014 ANTHROPIC_API_KEY is not set/);
  const badModel = await run({ env: { ...GOOD_ENV, SIFT_CLAUDE_MODEL: 'bad model!' } });
  assert.equal(badModel.failures, 1); // reported once, as the model problem
  assert.match(badModel.text, /\u2717 Claude \u2014 SIFT_CLAUDE_MODEL must be/);
});

test('no testers, a webhook, or a revoked bot token each fail with what to do', async () => {
  const noTesters = await run({ env: { ...GOOD_ENV, SIFT_ALLOWED_USER_IDS: '' } });
  assert.match(noTesters.text, /✗ Testers — SIFT_ALLOWED_USER_IDS is empty: start the bot, send it \/id/);
  const webhook = await run({ fetchImpl: fakeFetch({ webhook: 'https://example.com/hook' }) });
  assert.match(webhook.text, /✗ Telegram — A Telegram webhook is already configured/);
  const revoked = await run({ fetchImpl: fakeFetch({ telegramStatus: 401 }) });
  assert.match(revoked.text, /✗ Telegram — the token was rejected \(401\): copy the current token from @BotFather/);
});

test('a rejected Claude request is reported with its status, and the criteria check is skipped', async () => {
  const rejected = claudeClient(() => { throw new Anthropic.APIError(401, { error: {} }, 'bad key', new Headers()); });
  const { failures, text } = await run({ claudeClient: rejected });
  assert.equal(failures, 1);
  assert.match(text, /✗ Claude routing — Claude rejected the API key or model \(401\)/);
  assert.doesNotMatch(text, /Claude criteria/);
  const schemaRejected = claudeClient(() => { throw new Anthropic.APIError(400, { error: {} }, 'bad schema', new Headers()); });
  assert.match((await run({ claudeClient: schemaRejected })).text, /✗ Claude criteria — Claude request failed \(400\)/);
});

test('a wrong extraction fails the criteria check instead of passing silently', async () => {
  const misread = claudeClient((params) => answer(params.system.startsWith('You route') ? { command: 'help' }
    : { rules: [{ ...PROPOSAL.rules[0] }], unresolved: ['market cap under 2m'] }));
  const { failures, text } = await run({ claudeClient: misread });
  assert.equal(failures, 1);
  assert.match(text, /✗ Claude criteria — unexpected proposal/);
});

test('data sources down or another Node version are reported, not thrown', async () => {
  const down = async (url) => {
    if (url.includes('api.telegram.org')) return fakeFetch()(url);
    throw new Error('network down');
  };
  const { failures, text } = await run({ fetchImpl: down, nodeVersion: '22.13.0' });
  assert.equal(failures, 3);
  assert.match(text, /^! Node\.js — v22\.13\.0: runs, but Sift targets Node 24/m);
  assert.match(text, /✗ GeckoTerminal new pools — unreachable/);
  assert.match(text, /3 checks failed/);
});
