import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarketData, createTokenBatch, metricsFromPair, SOLANA_ADDRESS, selectPair } from '../src/market-data.js';

// Real recorded DexScreener responses: SOL's top pool has no marketCap field,
// BONK's top pool reports a genuine 0 for 1h volume (2026-11-16), and the v1
// batch holds BONK plus five pump.fun tokens under a minute old (2026-11-17),
// which have market cap but no liquidity while on their bonding curve.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const fetchJson = (payload, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload });

test('address validation blocks anything that is not base58 before any request', async () => {
  let fetched = 0;
  const market = createMarketData({ fetchImpl: async () => { fetched += 1; } });
  for (const bad of ['', 'short', '0OIl'.repeat(10), `${SOL} extra`, '../etc/passwd', 'x'.repeat(45), 42, null]) {
    assert.deepEqual(await market(bad), { ok: false, reason: 'INVALID_ADDRESS' });
  }
  assert.equal(fetched, 0);
  assert.equal(SOLANA_ADDRESS.test(SOL), true);
});

test('selects the highest-liquidity pool and labels every value with its provider', async () => {
  const market = createMarketData({ fetchImpl: fetchJson(fixture('dexscreener-bonk.json')), now: () => 1_800_000_000_000 });
  const result = await market(BONK);
  assert.equal(result.ok, true);
  assert.equal(result.pool.dexId, 'meteora');
  assert.equal(result.pool.name, 'Bonk / JUP');
  assert.equal(result.pool.selection, 'highest liquidity');
  assert.equal(result.pool.poolCount, 30);
  assert.ok(result.pool.url.startsWith('https://dexscreener.com/'));
  assert.equal(result.metrics.liquidityUsd.provider, 'DexScreener');
  assert.ok(result.metrics.liquidityUsd.value > 1_000_000);
  // marketCap and fdv are mapped separately, never substituted for each other.
  assert.notEqual(result.metrics.marketCapUsd.value, result.metrics.fdvUsd.value);
  // A real 0 from the API is a live value, not unknown.
  assert.deepEqual(result.metrics.volume1hUsd, { value: 0, source: 'live', provider: 'DexScreener', asOf: result.checkedAt });
  assert.equal(result.metrics.txns1h.value, 0);
});

test('only pools where the token is the base are used: pair market cap describes the base token', async () => {
  const pairs = fixture('dexscreener-bonk.json').pairs;
  // BONK as the quote of a pool with far more liquidity must not be selected.
  const quoteSide = { ...pairs[0], pairAddress: 'Quote1111111111111111111111111111111111111111', marketCap: 1,
    baseToken: { address: SOL, symbol: 'SOL' }, quoteToken: { address: BONK, symbol: 'Bonk' }, liquidity: { usd: 9e12 } };
  const result = await createMarketData({ fetchImpl: fetchJson({ pairs: [quoteSide, ...pairs] }) })(BONK);
  assert.notEqual(result.pool.pairAddress, quoteSide.pairAddress);
  assert.notEqual(result.metrics.marketCapUsd.value, 1);
});

test('a metric the API does not provide is unknown, never a guess', async () => {
  const market = createMarketData({ fetchImpl: fetchJson(fixture('dexscreener-sol.json')) });
  const result = await market(SOL);
  assert.equal(result.ok, true);
  // The recorded SOL/USDC pool carries no marketCap field.
  assert.deepEqual(result.metrics.marketCapUsd, { value: null, source: 'unknown', provider: null, asOf: result.checkedAt });
  assert.equal(result.metrics.liquidityUsd.source, 'live');
});

test('when no pool reports liquidity, the most active pool is used and the reason is stated', () => {
  const pump = { dexId: 'pumpfun', volume: { h1: 900 } };
  const quiet = { dexId: 'other', volume: { h1: 10 } };
  assert.deepEqual(selectPair([quiet, pump]), { pair: pump, selection: 'most 1h volume; no pool reports liquidity' });
  const amm = { dexId: 'pumpswap', liquidity: { usd: 5 }, volume: { h1: 1 } };
  assert.deepEqual(selectPair([quiet, pump, amm]), { pair: amm, selection: 'highest liquidity' });
});

test('timestamps in the future or malformed pairs degrade to unknown', () => {
  const asOf = '2026-11-16T19:00:00.000Z';
  const metrics = metricsFromPair({ pairCreatedAt: 2_000_000_000_000, fdv: 123_456, liquidity: {}, txns: { h1: { buys: 3 } } }, asOf, 1_800_000_000_000);
  // FDV being known never stands in for an absent market cap.
  assert.equal(metrics.marketCapUsd.source, 'unknown');
  assert.deepEqual(metrics.fdvUsd, { value: 123_456, source: 'live', provider: 'DexScreener', asOf });
  assert.equal(metrics.poolAgeMinutes.source, 'unknown'); // created "in the future"
  assert.equal(metrics.liquidityUsd.source, 'unknown');
  assert.equal(metrics.txns1h.source, 'unknown'); // sells missing: no invented half-count
});

test('no Solana pools, API failures and network errors fail closed without throwing', async () => {
  const noSolana = { pairs: fixture('dexscreener-sol.json').pairs.map((p) => ({ ...p, chainId: 'ethereum' })) };
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson(noSolana) })(SOL), { ok: false, reason: 'NO_SOLANA_POOLS' });
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson({ pairs: null }) })(SOL), { ok: false, reason: 'NO_SOLANA_POOLS' });
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson({}, 500) })(SOL), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson({}, 429) })(SOL), { ok: false, reason: 'RATE_LIMITED' });
  assert.deepEqual(await createMarketData({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) })(SOL), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await createMarketData({ fetchImpl: async () => { throw new Error('network down'); } })(SOL), { ok: false, reason: 'UNAVAILABLE' });
});

test('batch: one request for many tokens via the uncapped endpoint, each token mapped', async () => {
  const batch = fixture('dexscreener-v1-batch.json');
  const tokens = batch.map((p) => p.baseToken.address);
  const urls = [];
  const fetchTokens = createTokenBatch({ fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => batch }; } });
  const result = await fetchTokens([...tokens, tokens[0], 'not an address']);
  assert.equal(result.ok, true);
  assert.equal(urls.length, 1);
  // The capped /latest/dex/tokens endpoint would let BONK's 30 pools crowd out
  // the new tokens (observed live); batches must use /tokens/v1.
  assert.match(urls[0], /^https:\/\/api\.dexscreener\.com\/tokens\/v1\/solana\//);
  assert.equal(urls[0].split('/').pop().split(',').length, tokens.length); // deduplicated, invalid dropped
  assert.equal(result.byToken.size, tokens.length);
  const young = result.byToken.get(tokens.find((t) => t !== BONK));
  assert.equal(young.metrics.marketCapUsd.source, 'live'); // market cap exists within a minute
  assert.equal(young.metrics.liquidityUsd.source, 'unknown'); // bonding curve: no liquidity figure
  assert.equal(young.pool.selection, 'DexScreener main pool');
});

test('batch: empty input makes no request; failures and rate limits are reported, not thrown', async () => {
  let fetched = 0;
  const none = await createTokenBatch({ fetchImpl: async () => { fetched += 1; } })(['bad']);
  assert.equal(none.byToken.size, 0);
  assert.equal(fetched, 0);
  const token = [fixture('dexscreener-v1-batch.json')[1].baseToken.address];
  assert.deepEqual(await createTokenBatch({ fetchImpl: fetchJson([], 429) })(token), { ok: false, reason: 'RATE_LIMITED' });
  assert.deepEqual(await createTokenBatch({ fetchImpl: fetchJson({ not: 'an array' }) })(token), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await createTokenBatch({ fetchImpl: async () => { throw new Error('down'); } })(token), { ok: false, reason: 'UNAVAILABLE' });
});
