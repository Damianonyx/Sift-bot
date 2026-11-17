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
  assert.equal(pool.metrics.liquidityUsd.provider, 'GeckoTerminal');
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

// Pages of 20 distinct fake pools, built from the real fixture's first entry.
// Addresses must be valid base58 (no 0, O, I or l) or the parser drops them.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const page = (n) => ({ data: Array.from({ length: 20 }, (_, i) => {
  const entry = structuredClone(fixture.data[0]);
  entry.attributes.address = `Pg${n}x${B58[i]}z`.padEnd(44, '1');
  entry.relationships.base_token.data.id = `solana_Tk${n}x${B58[i]}z`.padEnd(51, '1');
  return entry;
}) });
const pagedFetch = (pages, urls = []) => async (url) => {
  urls.push(url);
  const n = Number(new URL(url).searchParams.get('page'));
  const payload = pages[n - 1];
  return payload === undefined ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => payload };
};

test('busy minutes: reads further pages until it reaches pools already seen', async () => {
  const urls = [];
  const known = new Set([page(2).data[5].attributes.address]);
  const discovery = createDiscovery({ fetchImpl: pagedFetch([page(1), page(2), page(3)], urls), now: () => NOW });
  const result = await discovery(undefined, { isKnown: (address) => known.has(address) });
  assert.equal(result.pages, 2); // page 2 reached a known pool, so page 3 was never read
  assert.equal(urls.length, 2);
  assert.equal(result.pools.length, 40);
});

test('paging is capped, and a failing later page keeps the pools already read', async () => {
  const capped = await createDiscovery({ fetchImpl: pagedFetch([page(1), page(2), page(3), page(4)]), maxPages: 3 })();
  assert.equal(capped.pages, 3);
  assert.equal(capped.pools.length, 60);
  const partial = await createDiscovery({ fetchImpl: pagedFetch([page(1)]) })(); // page 2 fails
  assert.equal(partial.ok, true);
  assert.equal(partial.pools.length, 20);
  const short = await createDiscovery({ fetchImpl: pagedFetch([{ data: page(1).data.slice(0, 7) }, page(2)]) })();
  assert.equal(short.pages, 1); // a short page is the last page
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
  for (const discovery of [createDiscovery({ fetchImpl: fetchJson({}, 429) })]) {
    assert.deepEqual(await discovery(), { ok: false, reason: 'RATE_LIMITED' });
  }
});
