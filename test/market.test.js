import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketData, isSolanaAddress, normalisePairs, MarketDataError } from '../src/market.js';
import { formatTokenReport } from '../src/token-report.js';
import { createResponder } from '../src/commands.js';

// Synthetic fixtures only. Public addresses identify format examples; metrics
// and the token name below are invented exclusively for offline tests.
const CA = 'So11111111111111111111111111111111111111112';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = '11111111111111111111111111111111';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const allowed = new Set([42]);
const input = (text, id = 42, type = 'private') => ({
  update_id: 100,
  message: { text, from: { id, is_bot: false }, chat: { id, type } },
});
const fixture = (overrides = {}) => ({
  chainId: 'solana', pairAddress: POOL,
  baseToken: { address: CA, name: 'SYNTHETIC TEST ONLY', symbol: 'TEST' },
  quoteToken: { symbol: 'QUOTE' }, dexId: 'synthetic-venue',
  priceUsd: '0.0000000123', marketCap: 100000, fdv: 200000,
  liquidity: { usd: 30000 }, volume: { m5: 100, h1: 500, h24: 1200 },
  txns: { m5: { buys: 2, sells: 0 }, h1: { buys: 8, sells: 3 }, h24: { buys: 20, sells: 10 } },
  pairCreatedAt: NOW - 7200000,
  ...overrides,
});
const noNetwork = async () => { assert.fail('Unexpected market-data request'); };

test('Solana format validation decodes exactly 32 bytes, not just a plausible character count', () => {
  for (const value of [CA, OTHER, POOL]) assert.equal(isSolanaAddress(value), true);
  for (const value of [null, '', '2'.repeat(32), 'z'.repeat(44), '1'.repeat(31), '1'.repeat(33),
    '0'.repeat(32), 'O'.repeat(32), 'I'.repeat(32), 'l'.repeat(32), 'https://example.com/' + CA,
    CA + ' ' + OTHER, ' ' + CA, '0x' + '1'.repeat(40)]) assert.equal(isSolanaAddress(value), false);
});

test('pool selection is base-token and chain specific, deduplicated and ranked only by known liquidity', () => {
  const snapshot = normalisePairs([
    fixture({ chainId: 'ethereum', liquidity: { usd: 9999999 } }),
    fixture({ baseToken: { address: OTHER }, quoteToken: { address: CA }, liquidity: { usd: 9999999 } }),
    fixture({ pairAddress: 'not-a-pool' }),
    fixture({ pairAddress: OTHER, liquidity: {} }),
    fixture(),
    fixture({ liquidity: { usd: 9999999 } }), // duplicate cannot double count
    fixture({ pairAddress: CA, liquidity: { usd: 60000 } }),
  ], CA, NOW);
  assert.equal(snapshot.poolCount, 3);
  assert.equal(snapshot.unknownLiquidityCount, 1);
  assert.equal(snapshot.selected.address, CA);
  assert.equal(snapshot.selected.liquidityUsd, 60000); // not a cross-pool sum
  assert.equal(snapshot.selection, 'reported_liquidity');
});

test('unknown values remain unknown; zeros are retained and market cap is never replaced by FDV', () => {
  const snapshot = normalisePairs([fixture({
    marketCap: null, fdv: 70000, priceUsd: '', liquidity: { usd: null },
    volume: { m5: 0, h1: -1, h24: '1000' },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 1.5, sells: null } },
    pairCreatedAt: NOW + 1000,
  })], CA, NOW);
  assert.equal(snapshot.selected.marketCap, null);
  assert.equal(snapshot.selected.fdv, 70000);
  assert.equal(snapshot.selected.priceUsd, null);
  assert.equal(snapshot.selected.liquidityUsd, null);
  assert.equal(snapshot.selected.createdAt, null);
  assert.deepEqual(snapshot.selected.windows[0], { window: 'm5', volume: 0, buys: 0, sells: 0 });
  assert.deepEqual(snapshot.selected.windows[1], { window: 'h1', volume: null, buys: null, sells: null });
  const report = formatTokenReport(snapshot);
  assert.match(report, /Market cap \(provider estimate\): unknown/);
  assert.match(report, /FDV .*\$70,000/);
  assert.match(report, /5m: volume \$0 · buys 0 \/ sells 0/);
  assert.match(report, /all reported liquidity values are unknown/);
});

test('reports include evidence, measurement windows and freshness limits without trusting provider links', () => {
  const snapshot = normalisePairs([fixture({
    url: 'https://untrusted.example/claim',
    baseToken: { address: CA, name: '\u202eTEST\nNAME' + 'X'.repeat(200), symbol: 'TEST' },
  })], CA, NOW);
  const report = formatTokenReport(snapshot);
  assert.ok(report.length < 4096);
  assert.ok(!report.includes('untrusted.example') && !report.includes('\u202e'));
  assert.ok(snapshot.selected.name.length <= 64);
  assert.match(report, new RegExp('CA: ' + CA));
  assert.match(report, new RegExp('https://dexscreener.com/solana/' + POOL));
  for (const window of ['5m:', '1h:', '24h:']) assert.ok(report.includes(window));
  assert.match(report, /Pool age \(provider creation time\): 2h 0m/);
  assert.match(report, /Token creation \/ trading start: unknown/);
  assert.match(report, /Provider update time: unknown/);
  assert.match(report, /no Sift cache/);
  assert.match(report, /No strategy has been applied/);
  assert.match(report, /developer sales\/transfers/);
  assert.ok(!report.includes('Price: $0\n')); // tiny positive price must not become zero
  const smallPrice = formatTokenReport(normalisePairs([fixture({ priceUsd: '0.0123456' })], CA, NOW));
  assert.match(smallPrice, /Price: \$0.0123456/);
});

test('no supported pool means unknown coverage, never an invented token or safety claim', () => {
  for (const raw of [[], [fixture({ baseToken: { address: OTHER }, quoteToken: { address: CA } })]]) {
    const report = formatTokenReport(normalisePairs(raw, CA, NOW));
    assert.match(report, /No supported pool found/);
    assert.match(report, /does not prove the address is invalid/);
    assert.match(report, /Token existence and market metrics: unknown/);
    assert.doesNotMatch(report, /Price:/);
  }
  assert.throws(() => normalisePairs({ pairs: [] }, CA, NOW), /INVALID_RESPONSE/);
});

test('the provider client validates before GET, sends no credentials and does not cache results', async () => {
  let current = NOW;
  let calls = 0;
  const market = createMarketData({ now: () => current, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.dexscreener.com/token-pairs/v1/solana/' + CA);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json([fixture({ marketCap: calls })]);
  } });
  await assert.rejects(market.check('invalid'), /INVALID_ADDRESS/);
  assert.equal(calls, 0);
  assert.equal(market.status().state, 'not_checked');
  assert.equal((await market.check(CA)).selected.marketCap, 1);
  assert.equal(market.status().state, 'responded');
  await assert.rejects(market.check(CA), (error) => error.code === 'COOLDOWN' && error.retryAfter === 3);
  current += 3000;
  assert.equal((await market.check(CA)).selected.marketCap, 2);
  assert.equal(calls, 2);
});

test('provider rate limits retain Retry-After and prevent another outbound request during backoff', async () => {
  let current = NOW;
  let calls = 0;
  const market = createMarketData({ now: () => current, fetchImpl: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(market.check(CA), (e) => e.code === 'RATE_LIMITED' && e.retryAfter === 120);
  current += 3000;
  await assert.rejects(market.check(CA), (e) => e.code === 'COOLDOWN' && e.retryAfter === 117);
  assert.equal(calls, 1);
  assert.equal(market.status().state, 'unavailable');
});

test('errors, malformed or oversized responses never become empty-data success or leak raw errors', async () => {
  for (const fetchImpl of [
    async () => new Response('', { status: 503 }),
    async () => Response.json({ unexpected: 'payload' }),
    async () => new Response('{bad'),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => { throw new Error('PRIVATE_RAW_ERROR'); },
  ]) {
    const market = createMarketData({ fetchImpl, now: () => NOW });
    await assert.rejects(market.check(CA), (error) => {
      assert.ok(error instanceof MarketDataError);
      assert.ok(!error.stack.includes('PRIVATE_RAW_ERROR'));
      return true;
    });
    assert.equal(market.status().state, 'unavailable');
  }
});

test('unauthorized users and ignored updates cannot trigger source calls', async () => {
  const respond = createResponder({ market: { check: noNetwork, status: noNetwork } });
  assert.match((await respond(input('/check ' + CA, 57), allowed)).text, /does not have tester access/);
  assert.match((await respond(input('/id', 57), allowed)).text, /user ID: 57/);
  assert.match((await respond(input('/status', 57), allowed)).text, /does not have tester access/);
  assert.equal(await respond(input('/check ' + CA, 42, 'supergroup'), allowed), null);
  assert.equal(await respond(input('/check@OtherBot ' + CA), allowed), null);
  for (const text of ['/check', '/check not-an-address', '/check ' + CA + ' ' + OTHER]) {
    assert.match((await respond(input(text), allowed)).text, /one full Solana/);
  }
});

test('the complete command path returns the matching CA, source data and per-chat reply without previews', async () => {
  const market = createMarketData({ now: () => NOW, fetchImpl: async () => Response.json([fixture()]) });
  const respond = createResponder({ market });
  const response = await respond(input('/check@SiftAgentbot ' + CA), allowed);
  assert.equal(response.chat_id, 42);
  assert.deepEqual(response.link_preview_options, { is_disabled: true });
  assert.match(response.text, /SYNTHETIC TEST ONLY/);
  assert.match(response.text, /Market cap .*\$100,000/);
  assert.match((await respond(input('/status'), allowed)).text, /last request succeeded/);
  assert.match((await respond(input('/check ' + CA), allowed)).text, /Try again in 3 seconds/);
});

test('source outages are visible in replies and status; cancellation sends no stale reply', async () => {
  const market = createMarketData({ now: () => NOW, fetchImpl: async () => { throw new Error('PRIVATE_RAW_ERROR'); } });
  const respond = createResponder({ market });
  const failed = await respond(input('/check ' + CA), allowed);
  assert.match(failed.text, /No token assessment was made/);
  assert.ok(!failed.text.includes('PRIVATE_RAW_ERROR'));
  assert.match((await respond(input('/status'), allowed)).text, /last request failed/);
  const controller = new AbortController();
  controller.abort();
  const stopped = createResponder({ market: { check: async () => { throw new Error(); } } });
  assert.equal(await stopped(input('/check ' + CA), allowed, controller.signal), null);
});
