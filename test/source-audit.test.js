import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeteora, normaliseMeteoraFeed, normaliseMeteoraPool, readMeteoraConfig } from '../src/meteora.js';
import { createPublicJson, nonnegative } from '../src/public-json.js';
import { createSourceAudit, normaliseGeckoPool, compareMetric, formatSourceAudit } from '../src/source-audit.js';
import { createCandidateSources, formatCandidateSource } from '../src/candidate-sources.js';
import { createPumpFeed } from '../src/pump-feed.js';
import { normalisePairs } from '../src/market.js';
import { publicKeyString } from '../src/raydium-liquidity.js';
import { createResponder } from '../src/commands.js';
import { openAgentStore } from '../src/agent-store.js';
import { formatDiscoveryAlert } from '../src/discovery.js';

const NOW = 1800000000000;
const key = (i) => { const b = Buffer.alloc(32); b.writeUInt32BE(i, 28); return publicKeyString(b); };
const row = (i = 1) => ({ address: key(1000 + i), token_x: { address: key(i) }, token_y: { address: key(i + 100) },
  tvl: 30000, volume: { '1h': 10000 }, permanent_lock_liquidity: 100, current_price: 999 });
const page = (rows = [row()]) => ({ current_page: 1, page_size: 20, data: rows });
const dex = (extra = {}) => normalisePairs([{ chainId: 'solana', pairAddress: key(1001), dexId: 'meteora',
  baseToken: { address: key(1), name: 'Synthetic', symbol: 'TEST' }, quoteToken: { address: key(101), symbol: 'QUOTE' },
  priceUsd: '0.1', marketCap: 40000, liquidity: { usd: 30000 }, volume: { h1: 10000 }, ...extra }], key(1), NOW);
const gecko = (extra = {}) => ({ data: { type: 'pool', id: `solana_${key(1001)}`,
  attributes: { address: key(1001), base_token_price_usd: '0.11', quote_token_price_usd: '100',
    market_cap_usd: null, fdv_usd: '40000', reserve_in_usd: '31000', volume_usd: { h1: '0' }, ...extra },
  relationships: { base_token: { data: { type: 'token', id: `solana_${key(1)}` } },
    quote_token: { data: { type: 'token', id: `solana_${key(101)}` } } } } });
const unavailable = { read: async () => { throw new Error('private provider response'); }, status: () => ({ state: 'unavailable' }) };

test('Meteora discovers both mints with protocol provenance and no inferred USD, lock or risk metrics', () => {
  const batch = normaliseMeteoraFeed(page([row(), row(), { address: 'bad' }, row(2)]), 'meteora-dlmm', NOW);
  assert.equal(batch.invalidPools, 1);
  assert.equal(batch.pools.length, 2);
  assert.deepEqual(batch.candidates.map((c) => c.address), [key(1), key(101), key(2), key(102)]);
  assert.deepEqual(Object.keys(batch.candidates[0]).sort(), ['address', 'poolAddress', 'provenance']);
  assert.equal(batch.pools[0].providerUpdatedAt, null);
  assert.equal(batch.pools[0].liquidityProtection, undefined);
  for (const r of [page([{ address: 'bad' }]), { data: [row()], current_page: 2 }, page(Array(21).fill(row()))]) {
    assert.throws(() => normaliseMeteoraFeed(r, 'meteora-dlmm', NOW));
  }
  assert.throws(() => normaliseMeteoraPool({ ...row(), token_y: row().token_x }, 'meteora-dlmm', NOW));
  assert.throws(() => normaliseMeteoraPool(row(), 'invented', NOW));
  assert.equal(normaliseMeteoraPool({ ...row(), tvl: '0', volume: { '1h': null } }, 'meteora-dlmm', NOW).tvl, 0);
  assert.deepEqual(readMeteoraConfig({}), { enabled: true });
  assert.throws(() => readMeteoraConfig({ SIFT_METEORA_ENABLED: 'yes' }));
});

test('Meteora cache expires, failed refresh clears old success, and disabled feeds never call providers', async () => {
  let time = NOW, calls = 0, fail = false;
  const service = createMeteora({ now: () => time, fetchImpl: async () => { calls++; if (fail) throw new Error('secret response'); return Response.json(page()); } });
  const first = await service.read(); assert.equal(calls, 2);
  const second = await service.read(); assert.equal(calls, 2);
  assert.equal(first.candidates[0].provenance[0].cached, false);
  assert.equal(second.candidates[0].provenance[0].cached, true);
  time += 60000; fail = true;
  const failed = await service.read();
  assert.equal(failed.partial, true); assert.deepEqual(failed.candidates, []);
  assert.equal(service.status().every((s) => s.state === 'unavailable'), true);
  assert.deepEqual((await service.read()).candidates, []);
  assert.equal(calls, 4);
  const disabled = createMeteora({ enabled: false, fetchImpl: () => assert.fail('disabled') });
  assert.deepEqual((await disabled.read()).candidates, []);
  assert.equal(disabled.status().every((s) => s.state === 'disabled'), true);
  assert.equal((await disabled.pools(key(1001))).every((s) => s.state === 'DISABLED'), true);
  const c = new AbortController(); c.abort();
  await assert.rejects(disabled.read({ signal: c.signal }), /STOPPED/);
});

test('one Meteora protocol can fail visibly; combined pipeline still scans the other and rotates retained candidates', async () => {
  const service = createMeteora({ now: () => NOW, fetchImpl: async (url) => {
    if (url.includes('damm-v2')) throw new Error('private response');
    return Response.json(page(Array.from({ length: 20 }, (_, i) => row(i + 1))));
  } });
  const feed = createCandidateSources({ gecko: unavailable, pump: createPumpFeed({ enabled: false }), meteora: service, now: () => NOW });
  const first = await feed.read();
  assert.equal(first.candidates.length, 20); assert.equal(first.partial, true);
  assert.equal(first.deferred, 20); assert.equal(feed.status().state, 'partial');
  feed.selected(first.candidates);
  const next = await feed.read();
  assert.equal(next.candidates.length, 20);
  assert.ok(next.candidates.every((c) => !first.candidates.some((p) => p.address === c.address)));
  assert.match(formatCandidateSource(next.candidates[0], next), /Meteora DLMM/);
  const dead = createCandidateSources({ gecko: unavailable, pump: createPumpFeed({ enabled: false }),
    meteora: createMeteora({ fetchImpl: async () => { throw new Error('private'); } }) });
  await assert.rejects(dead.read(), /SOURCES_UNAVAILABLE/);
});

test('new HTTP clients bound bodies, reject redirects and foreign origins, sanitize errors and honor Retry-After', async () => {
  let calls = 0, time = NOW;
  const get = createPublicJson({ origin: 'https://dlmm.datapi.meteora.ag', now: () => time, fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, undefined);
    return new Response('private upstream error', { status: 429, headers: { 'retry-after': '100' } });
  } });
  await assert.rejects(get('/pools'), (e) => e.code === 'RATE_LIMITED' && e.retryAfter === 100 && !e.message.includes('private'));
  time += 99000; await assert.rejects(get('/pools'), /COOLDOWN/); assert.equal(calls, 1);
  await assert.rejects(get('https://evil.invalid'), /INVALID_REQUEST/); assert.equal(calls, 1);
  time += 1000; await assert.rejects(get('/pools'), /RATE_LIMITED/); assert.equal(calls, 2);
  const big = createPublicJson({ origin: 'https://dlmm.datapi.meteora.ag', fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(big('/pools'), /OVERSIZED_RESPONSE/);
  const bad = createPublicJson({ origin: 'https://dlmm.datapi.meteora.ag', fetchImpl: async () => Response.json({ secret: true }, { status: 503 }) });
  await assert.rejects(bad('/pools'), (e) => e.code === 'SOURCE_UNAVAILABLE' && !e.message.includes('secret'));
});

test('same-pool comparisons reject wrong chain, pool and mint identities; reversed orientation cannot borrow base market cap', () => {
  const base = normaliseGeckoPool(gecko(), dex(), NOW);
  assert.equal(base.priceUsd, .11); assert.equal(base.marketCap, null); assert.equal(base.volume1h, 0);
  for (const mutate of [p => { p.id = `eth_${key(1001)}`; }, p => { p.attributes.address = key(999); },
    p => { p.relationships.quote_token.data.id = `solana_${key(333)}`; }]) {
    const raw = gecko(); mutate(raw.data); assert.throws(() => normaliseGeckoPool(raw, dex(), NOW), /MISMATCH/);
  }
  const reversed = gecko();
  [reversed.data.relationships.base_token, reversed.data.relationships.quote_token] = [reversed.data.relationships.quote_token, reversed.data.relationships.base_token];
  const result = normaliseGeckoPool(reversed, dex(), NOW);
  assert.equal(result.priceUsd, 100); assert.equal(result.marketCap, null); assert.equal(result.reversed, true);
  assert.throws(() => normaliseGeckoPool(gecko(), dex({ quoteToken: {} }), NOW), /INCOMPLETE_DEX_IDENTITY/);
  for (const v of [null, true, '', ' ', '-1', Infinity, {}, 'NaN']) assert.equal(nonnegative(v), null);
  assert.equal(compareMetric(0, 1).differencePct, null);
  assert.equal(compareMetric(0, 0).state, 'equal');
  assert.equal(compareMetric(1, null).state, 'unknown');
  assert.equal(compareMetric(undefined, 1).state, 'unknown');
});

test('source audit reports disagreements and missing data without replacing screening metrics or passing risk', async () => {
  const snapshot = dex(), before = structuredClone(snapshot);
  const audit = createSourceAudit({ now: () => NOW, fetchImpl: async () => Response.json(gecko()),
    meteora: { pools: async () => [{ state: 'responded', ...normaliseMeteoraPool(row(), 'meteora-dlmm', NOW) },
      { state: 'NOT_INDEXED', source: 'meteora-damm-v2' }] } });
  const report = await audit.check(snapshot);
  assert.equal(report.comparisons.find((c) => c.field === 'priceUsd').state, 'different');
  assert.equal(report.comparisons.find((c) => c.field === 'marketCap').state, 'unknown');
  assert.deepEqual(snapshot, before);
  const text = formatSourceAudit(report);
  assert.match(text, /not an accuracy or safety certification/);
  assert.match(text, /Provider update times are unknown/);
  assert.match(text, /USD comparability is not verified/);
  assert.match(text, /Meteora DLMM: pool and both mint identities agree/);
  assert.ok(text.length < 4000);
  await assert.rejects(audit.check(snapshot), /COOLDOWN/);
});

test('Meteora exact-pool and both-mint checks reject substituted metadata; unavailable APIs never become agreement', async () => {
  const meteora = createMeteora({ fetchImpl: async () => Response.json(row(2)) });
  assert.ok((await meteora.pools(key(1001))).every((p) => p.state === 'POOL_MISMATCH'));
  const audit = createSourceAudit({ fetchImpl: async () => { throw new Error('private'); }, meteora: { pools: async () => [
    { state: 'responded', ...normaliseMeteoraPool({ ...row(), token_y: { address: key(222) } }, 'meteora-dlmm', NOW) },
  ] } });
  const report = await audit.check(dex());
  assert.equal(report.gecko.state, 'NETWORK_OR_RESPONSE');
  assert.equal(report.meteora[0].state, 'POOL_OR_TOKEN_MISMATCH');
  assert.deepEqual(report.comparisons, []);
  assert.doesNotMatch(formatSourceAudit(report), /private|identities agree/);
});

test('/verify authenticates before source calls, preserves saved strategy and scan, and supplies Copy CA', async (t) => {
  const agents = openAgentStore({ memory: true }); t.after(() => agents.close());
  let calls = 0;
  const market = { check: async () => { calls++; return dex(); } };
  const audit = createSourceAudit({ now: () => NOW, fetchImpl: async () => Response.json(gecko()), meteora: { pools: async () => [] } });
  const respond = createResponder({ market, audit, agents });
  const input = (id, chat = 'private') => ({ update_id: 998, message: { text: `/verify ${key(1)}`, from: { id, is_bot: false }, chat: { id, type: chat } } });
  await respond(input(99), new Set([42])); await respond(input(42, 'group'), new Set([42]));
  assert.equal(calls, 0);
  const before = agents.get(42), scan = agents.discoveryGet(42);
  const response = await respond(input(42), new Set([42]));
  assert.equal(calls, 1); assert.match(response.text, /Source comparison/);
  assert.equal(response.reply_markup.inline_keyboard.at(-1)[0].copy_text.text, key(1));
  assert.deepEqual(agents.get(42), before); assert.deepEqual(agents.discoveryGet(42), scan);
});

test('four-source attribution stays within the discovery Telegram message limit', () => {
  const candidate = { address: key(1), provenance: [
    { source: 'pumpportal', kind: 'create', signature: '2'.repeat(88), receivedAt: NOW, sourceUrl: 'wss://pumpportal.fun/api/data' },
    { source: 'geckoterminal', receivedAt: NOW, sourceUrl: 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,dex&page=1' },
    ...['meteora-dlmm', 'meteora-damm-v2'].map((source) => normaliseMeteoraFeed(page(), source, NOW).candidates[0].provenance[0]),
  ] };
  const snapshot = dex({ baseToken: { address: key(1), name: 'X'.repeat(64), symbol: 'Y'.repeat(64) },
    dexId: 'D'.repeat(64), quoteToken: { address: key(101), symbol: 'Q'.repeat(64) },
    liquidity: { usd: Number.MAX_VALUE }, volume: { m5: Number.MAX_VALUE, h1: Number.MAX_VALUE, h24: Number.MAX_VALUE } });
  const approved = { name: 'N'.repeat(32), pendingRequirements: [], rules: [
    { field: 'marketCap', mode: 'require', min: 30000, max: 50000 },
    ...['liquidityUsd', 'volume1h', 'poolAgeMinutes'].map((field) => ({ field, mode: 'warn', value: 1e12 })),
  ] };
  assert.ok(formatDiscoveryAlert(approved, snapshot, {}, candidate).length < 4000);
});
