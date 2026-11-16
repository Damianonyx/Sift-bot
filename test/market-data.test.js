import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarketData, metricsFromPair, SOLANA_ADDRESS } from '../src/market-data.js';

// Real recorded DexScreener responses (2026-11-16): SOL's top pool has no
// marketCap field, and BONK's top pool reports a genuine 0 for 1h volume.
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

test('selects the highest-liquidity Solana pool and tags every metric with provenance', async () => {
  const market = createMarketData({ fetchImpl: fetchJson(fixture('dexscreener-bonk.json')), now: () => 1_800_000_000_000 });
  const result = await market(BONK);
  assert.equal(result.ok, true);
  assert.equal(result.pool.dexId, 'meteora');
  assert.equal(result.pool.base, 'Bonk');
  assert.equal(result.pool.poolCount, 30);
  assert.ok(result.pool.url.startsWith('https://dexscreener.com/'));
  assert.equal(result.metrics.liquidityUsd.source, 'live');
  assert.ok(result.metrics.liquidityUsd.value > 1_000_000);
  // marketCap and fdv are mapped separately, never substituted for each other.
  assert.notEqual(result.metrics.marketCapUsd.value, result.metrics.fdvUsd.value);
  // A real 0 from the API is a live value, not unknown.
  assert.deepEqual(result.metrics.volume1hUsd, { value: 0, source: 'live', asOf: result.checkedAt });
  assert.equal(result.metrics.txns1h.value, 0);
  assert.ok(result.metrics.poolAgeMinutes.value > 0);
});

test('a metric the API does not provide is unknown, never a guess', async () => {
  const market = createMarketData({ fetchImpl: fetchJson(fixture('dexscreener-sol.json')) });
  const result = await market(SOL);
  assert.equal(result.ok, true);
  // The recorded SOL/USDC pool carries no marketCap field.
  assert.deepEqual(result.metrics.marketCapUsd, { value: null, source: 'unknown', asOf: result.checkedAt });
  assert.equal(result.metrics.liquidityUsd.source, 'live');
});

test('timestamps in the future or malformed pairs degrade to unknown', () => {
  const asOf = '2026-11-16T19:00:00.000Z';
  const metrics = metricsFromPair({ pairCreatedAt: 2_000_000_000_000, fdv: 123_456, liquidity: {}, txns: { h1: { buys: 3 } } }, asOf, 1_800_000_000_000);
  // FDV being known never stands in for an absent market cap.
  assert.equal(metrics.marketCapUsd.source, 'unknown');
  assert.deepEqual(metrics.fdvUsd, { value: 123_456, source: 'live', asOf });
  assert.equal(metrics.poolAgeMinutes.source, 'unknown'); // created "in the future"
  assert.equal(metrics.liquidityUsd.source, 'unknown');
  assert.equal(metrics.txns1h.source, 'unknown'); // sells missing: no invented half-count
});

test('no Solana pools, API failures and network errors fail closed without throwing', async () => {
  const noSolana = { pairs: fixture('dexscreener-sol.json').pairs.map((p) => ({ ...p, chainId: 'ethereum' })) };
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson(noSolana) })(SOL), { ok: false, reason: 'NO_SOLANA_POOLS' });
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson({ pairs: null }) })(SOL), { ok: false, reason: 'NO_SOLANA_POOLS' });
  assert.deepEqual(await createMarketData({ fetchImpl: fetchJson({}, 500) })(SOL), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await createMarketData({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) })(SOL), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await createMarketData({ fetchImpl: async () => { throw new Error('network down'); } })(SOL), { ok: false, reason: 'UNAVAILABLE' });
});
