import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDiscovery, poolFromEntry } from '../src/discovery.js';

// Real recorded GeckoTerminal new_pools response (2026-11-17): numbers come as
// strings, and all 20 brand-new pools carry null market_cap_usd.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/geckoterminal-new-pools.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-17T07:20:00Z');
const fetchJson = (payload, status = 200) => async () => ({ ok: status < 400, status, json: async () => payload });

test('maps the real feed: string numbers parsed, null market cap stays unknown', async () => {
  const discovery = createDiscovery({ fetchImpl: fetchJson(fixture), now: () => NOW });
  const result = await discovery();
  assert.equal(result.ok, true);
  assert.equal(result.pools.length, 20);
  const pool = result.pools[0];
  assert.equal(pool.name, 'MOONER / SOL');
  assert.equal(pool.dexId, 'pump-fun');
  assert.match(pool.url, /^https:\/\/www\.geckoterminal\.com\/solana\/pools\//);
  assert.equal(pool.metrics.liquidityUsd.source, 'live');
  assert.ok(Math.abs(pool.metrics.liquidityUsd.value - 446.0531) < 1e-6); // "446.0531" parsed
  assert.equal(pool.metrics.txns1h.value, 10); // 5 buys + 5 sells
  assert.ok(pool.metrics.poolAgeMinutes.value >= 0 && pool.metrics.poolAgeMinutes.value <= 10);
  // Every recorded brand-new pool lacks market cap: all must be unknown.
  assert.ok(result.pools.every((p) => p.metrics.marketCapUsd.source === 'unknown'));
});

test('entries that cannot be read safely are dropped, not guessed at', () => {
  const good = fixture.data[0];
  assert.notEqual(poolFromEntry(good, '2026-11-17T07:20:00.000Z', NOW), null);
  for (const bad of [
    null,
    { ...good, relationships: { ...good.relationships, base_token: { data: { id: 'solana_not!valid' } } } },
    { ...good, attributes: { ...good.attributes, address: 'nope' } },
  ]) {
    assert.equal(poolFromEntry(bad, '2026-11-17T07:20:00.000Z', NOW), null);
  }
  // A creation time in the future degrades only the age to unknown.
  const future = poolFromEntry({ ...good, attributes: { ...good.attributes, pool_created_at: '2030-01-01T00:00:00Z' } }, 'x', NOW);
  assert.equal(future.metrics.poolAgeMinutes.source, 'unknown');
  assert.equal(future.metrics.liquidityUsd.source, 'live');
});

test('API failures, bad payloads and network errors fail closed without throwing', async () => {
  for (const discovery of [
    createDiscovery({ fetchImpl: fetchJson({}, 500) }),
    createDiscovery({ fetchImpl: fetchJson({ data: 'nope' }) }),
    createDiscovery({ fetchImpl: async () => { throw new Error('down'); } }),
    createDiscovery({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) }),
  ]) {
    assert.deepEqual(await discovery(), { ok: false, reason: 'UNAVAILABLE' });
  }
});
