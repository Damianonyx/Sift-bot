import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { respond, WELCOME } from '../src/bot.js';
import { createClaude } from '../src/claude.js';
import { createMarketData } from '../src/market-data.js';
import { openStore } from '../src/store.js';

// The complete tester journey with fake Claude and recorded DexScreener data:
// describe criteria -> review the proposal -> approve -> check a real token.
const silent = { warn() {} };
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const bonkJson = JSON.parse(readFileSync(new URL('./fixtures/dexscreener-bonk.json', import.meta.url), 'utf8'));
const DESCRIPTION = 'at least 10k liquidity, mcap under 5m, warn if the pool is younger than 30 minutes, and the dev must be clean';
const PROPOSAL = {
  rules: [
    { field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: '10k liquidity' },
    { field: 'marketCapUsd', op: 'lte', value: 5_000_000, severity: 'require', evidence: 'mcap under 5m' },
    { field: 'poolAgeMinutes', op: 'gte', value: 30, severity: 'warn', evidence: 'younger than 30 minutes' },
  ],
  unresolved: ['the dev must be clean'],
};
const claudeFor = (payload) => createClaude({
  log: silent,
  client: { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] }) } } },
});
const update = (text, id = 42) => ({ update_id: 1, message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });

function makeCtx(payload = PROPOSAL) {
  return {
    allowedUserIds: new Set([42]),
    store: openStore(':memory:'),
    claude: claudeFor(payload),
    market: createMarketData({ fetchImpl: async () => ({ ok: true, json: async () => bonkJson }) }),
  };
}
const text = async (ctx, message) => (await respond(update(message), ctx)).text;

test('describe -> approve -> check: the full flow with evidence in every reply', async () => {
  const ctx = makeCtx();
  assert.equal(await text(ctx, '/start'), WELCOME);

  const proposal = await text(ctx, `/criteria ${DESCRIPTION}`);
  assert.match(proposal, /nothing is active yet/i);
  assert.match(proposal, /require selected-pool liquidity ≥ \$10,000 — "10k liquidity"/);
  assert.match(proposal, /warn if not selected-pool age ≥ 30 min/);
  assert.match(proposal, /"the dev must be clean"/); // unsupported ask is surfaced, not silently dropped

  assert.match(await text(ctx, '/status'), /a proposal is waiting for \/approve/);
  const approved = await text(ctx, '/approve');
  assert.match(approved, /Criteria v1 is active \(3 rules\)/);
  assert.match(approved, /1 unresolved item .* NOT activated/);
  assert.match(await text(ctx, '/status'), /Saved criteria: v1 \(3 rules\)/);

  // BONK's real recorded mcap is far over 5m: the verdict must be a clean fail.
  const check = await text(ctx, `/check ${BONK}`);
  assert.match(check, /Does NOT pass your criteria v1/);
  assert.match(check, /✓ require selected-pool liquidity/);
  assert.match(check, /✗ require market cap/);
  assert.match(check, /Warning-only checks:/);
  assert.match(check, /best liquidity of 30 Solana pools/);
  assert.match(check, /does not make a token safe or profitable/);

  // The saved rules survive into a view, and /approve without a draft is safe.
  assert.match(await text(ctx, '/criteria'), /Saved criteria: v1/);
  assert.match(await text(ctx, '/approve'), /No proposed rules are waiting/);
});

test('discard drops the proposal and keeps the approved rules', async () => {
  const ctx = makeCtx();
  await text(ctx, `/criteria ${DESCRIPTION}`);
  await text(ctx, '/approve');
  await text(ctx, `/criteria ${DESCRIPTION}`);
  assert.match(await text(ctx, '/discard'), /previously approved rules, if any, are unchanged/);
  assert.match(await text(ctx, '/status'), /Saved criteria: v1/);
  assert.match(await text(ctx, '/discard'), /No proposal to discard/);
});

test('check without rules, with a bad address, and with the data source down', async () => {
  const ctx = makeCtx();
  assert.match(await text(ctx, `/check ${BONK}`), /No active criteria/);
  await text(ctx, `/criteria ${DESCRIPTION}`);
  await text(ctx, '/approve');
  const bad = await text(ctx, '/check not-a-real-address');
  assert.match(bad, /32–44 base58 characters/);
  assert.doesNotMatch(bad, /not-a-real-address/); // arbitrary input is never echoed
  ctx.market = createMarketData({ fetchImpl: async () => { throw new Error('down'); } });
  assert.match(await text(ctx, `/check ${BONK}`), /could not be reached .* Nothing was evaluated/);
});

test('a proposal with no measurable rules saves nothing and lists what was not understood', async () => {
  const ctx = makeCtx({ rules: [], unresolved: ['good liquidity', 'safe dev'] });
  const reply = await text(ctx, '/criteria good liquidity and a safe dev');
  assert.match(reply, /No measurable screening rules/);
  assert.match(reply, /"good liquidity"/);
  assert.match(await text(ctx, '/approve'), /No proposed rules are waiting/);
});

test('without Claude, /criteria explains itself and nothing is changed', async () => {
  const ctx = makeCtx();
  ctx.claude = null;
  assert.match(await text(ctx, '/criteria 10k liquidity'), /needs Claude, which is off/);
  assert.match(await text(ctx, '/criteria'), /No saved screening rules yet/);
  assert.match(await text(ctx, '/help'), /off: needs ANTHROPIC_API_KEY/);
});

test('/scan needs approved criteria, warns about data-poor fields, and turns off cleanly', async () => {
  const ctx = makeCtx();
  assert.match(await text(ctx, '/scan on'), /needs active criteria first/);
  await text(ctx, `/criteria ${DESCRIPTION}`);
  await text(ctx, '/approve');
  const on = await text(ctx, '/scan on');
  assert.match(on, /Scanning is on with criteria v1/);
  // The approved rules require market cap, which brand-new pools usually lack.
  assert.match(on, /no market cap or FDV data yet/);
  assert.match(await text(ctx, '/status'), /Scanning: on \(no check has run yet\)/);
  ctx.store.setLastScan({ at: '2026-11-17T08:00:00.000Z', ok: true, pools: 20, newMatches: 1 });
  assert.match(await text(ctx, '/scan'), /last check 08:00 UTC: 20 new pools, 1 new match overall/);
  assert.match(await text(ctx, '/scan off'), /Scanning stopped/);
  assert.match(await text(ctx, '/scan off'), /already off/);
  assert.match(await text(ctx, '/status'), /Scanning: off/);
});

test('plain language still routes to fixed replies and criteria state shows in status', async () => {
  const ctx = makeCtx({ command: 'status' });
  const reply = await text(ctx, 'is anything live yet?');
  assert.match(reply, /Sift status/);
  assert.match(reply, /Token checks: on demand via \/check/);
});
