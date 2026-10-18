import test from 'node:test';
import assert from 'node:assert/strict';
import { createPumpFeed, normalisePumpEvent, readPumpConfig, PUMP_STREAM_URL, PUMP_TTL_MS, PUMP_CAPACITY } from '../src/pump-feed.js';
import { createCandidateSources } from '../src/candidate-sources.js';
import { createDiscoveryFeed, FEED_URL } from '../src/discovery-feed.js';
import { createDiscoveryRunner, formatDiscoveryAlert } from '../src/discovery.js';
import { createResponder } from '../src/commands.js';
import { openAgentStore } from '../src/agent-store.js';
import { criteriaKey } from '../src/discovery-store.js';
import { normalisePairs } from '../src/market.js';
import { publicKeyString } from '../src/raydium-liquidity.js';

// Synthetic protocol-shaped events. These tests make no network requests and
// do not establish live provider accuracy or on-chain safety.
const NOW = 1800000000000;
const mint = (i = 1) => { const b = Buffer.alloc(32); b.writeUInt32BE(i, 28); return publicKeyString(b); };
const signature = '1'.repeat(63) + '2';
const event = (i = 1, extra = {}) => ({ txType: 'create', mint: mint(i), signature, pool: 'pump', ...extra });
class Socket extends EventTarget {
  sent = [];
  closes = 0;
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closes++; this.dispatchEvent(new Event('close')); }
  open() { this.dispatchEvent(new Event('open')); }
  message(raw) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(raw) })); }
  error() { this.dispatchEvent(new Event('error')); }
}
function fixture(options = {}) {
  let time = NOW;
  const sockets = [];
  const pump = createPumpFeed({ ...options, now: () => time, socketFactory: (url) => {
    assert.equal(url, PUMP_STREAM_URL);
    const socket = new Socket(); sockets.push(socket); return socket;
  } });
  return { pump, sockets, advance: (ms) => { time += ms; }, now: () => time,
    connect() { pump.tick(true); sockets.at(-1).open(); return sockets.at(-1); } };
}
const gecko = (mints = []) => createDiscoveryFeed({ now: () => NOW, fetchImpl: async () => Response.json({ data: mints.map((address, i) => ({
  type: 'pool', id: `solana_${mint(i + 1000)}`, attributes: { address: mint(i + 1000) },
  relationships: { base_token: { data: { type: 'token', id: `solana_${address}` } } },
})) }) });
const missingGecko = { read: async () => { throw new Error('private source error'); }, status: () => ({ state: 'unavailable' }) };
const cap = { field: 'marketCap', mode: 'require', min: 30000, max: 50000 };
const agent = () => ({ name: 'SYNTHETIC', rules: [cap], pendingRequirements: [] });
const pair = (address = mint(1), extra = {}) => ({ chainId: 'solana', pairAddress: mint(999), baseToken: { address, name: 'Synthetic', symbol: 'TEST' },
  marketCap: 40000, liquidity: { usd: 30000 }, volume: { h1: 60000 }, pairCreatedAt: NOW - 60000, ...extra });
const storeFor = (t) => { const store = openAgentStore({ memory: true }); t.after(() => store.close()); return store; };
function activate(store, approved = agent()) {
  store.put(42, { revision: 1, approved, draft: null });
  store.discoverySet(42, 'active', criteriaKey(approved));
}
let sequence = 50000;
const input = (text, id = 42) => ({ update_id: ++sequence, message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });

test('Pump feed only accepts valid identities; provider reserves and safety claims never become screening metrics', () => {
  const candidate = normalisePumpEvent(event(1, { marketCapSol: 40000, usd_market_cap: 40000, vSolInBondingCurve: 100,
    liquidityLocked: true, creator: mint(8), uri: 'https://untrusted.invalid', complete: true }), NOW);
  assert.deepEqual(Object.keys(candidate), ['address', 'provenance']);
  assert.deepEqual(Object.keys(candidate.provenance[0]).sort(), ['source', 'kind', 'receivedAt', 'signature', 'sourceUrl'].sort());
  for (const bad of [null, [], event(1, { mint: 'bad' }), event(1, { signature: '1'.repeat(65) }),
    event(1, { signature: 'x'.repeat(1000) }), event(1, { txType: 'buy' }), event(1, { pool: 'bonk' })]) {
    assert.equal(normalisePumpEvent(bad, NOW), null);
  }
  assert.equal(normalisePumpEvent(event(1, { txType: 'migrate', pool: 'pump-amm' }), NOW).provenance[0].kind, 'migrate');
  assert.deepEqual(readPumpConfig({}), { enabled: true });
  assert.deepEqual(readPumpConfig({ SIFT_PUMPFUN_ENABLED: 'false' }), { enabled: false });
  assert.throws(() => readPumpConfig({ SIFT_PUMPFUN_ENABLED: 'yes' }), /true or false/);
});

test('a single lazy socket subscribes only to free launches/migrations; acknowledgements cannot establish delivery', async () => {
  const f = fixture();
  f.pump.status(); await f.pump.read(); f.pump.tick(false);
  assert.equal(f.sockets.length, 0);
  const socket = f.connect();
  assert.deepEqual(socket.sent, [{ method: 'subscribeNewToken' }, { method: 'subscribeMigration' }]);
  for (let i = 0; i < 20; i++) f.pump.tick(true);
  assert.equal(f.sockets.length, 1);
  socket.message({ message: 'Successfully subscribed to token creation events.' });
  assert.equal(f.pump.status().state, 'connected');
  assert.equal((await f.pump.read()).partial, true);
  socket.message(event());
  assert.equal(f.pump.status().state, 'receiving');
  assert.equal((await f.pump.read()).candidates[0].address, mint(1));
  f.pump.tick(false);
  assert.equal(socket.closes, 1);
  assert.equal(f.pump.status().state, 'idle');
  assert.equal((await f.pump.read()).candidates.length, 0);
  f.pump.close();
});

test('diagnostics have a short lease, disabled configuration and cancelled reads make no connection', async () => {
  const f = fixture();
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(f.pump.read({ diagnostic: true, signal: stopped.signal }));
  assert.equal(f.sockets.length, 0);
  await f.pump.read({ diagnostic: true });
  assert.equal(f.sockets.length, 1);
  f.sockets[0].open(); f.sockets[0].message(event());
  f.advance(29_000); f.pump.tick(false);
  assert.equal(f.sockets[0].closes, 0);
  f.advance(1000); f.pump.tick(false);
  assert.equal(f.sockets[0].closes, 1);
  const disabled = fixture({ enabled: false });
  await disabled.pump.read({ diagnostic: true }); disabled.pump.tick(true);
  assert.equal(disabled.sockets.length, 0);
  assert.equal(disabled.pump.status().state, 'disabled');
});

test('disconnects discard stale batches, back off, ignore late events and accept new events after reconnection', async () => {
  const f = fixture(), first = f.connect();
  first.message(event()); first.error();
  assert.equal(f.pump.status().state, 'unavailable');
  assert.equal((await f.pump.read()).candidates.length, 0);
  first.message(event(2));
  f.pump.tick(true); assert.equal(f.sockets.length, 1);
  f.advance(10_000); const second = f.connect();
  second.message(event(3));
  assert.deepEqual((await f.pump.read()).candidates.map((c) => c.address), [mint(3)]);
  assert.equal((await f.pump.read()).partial, true); // Lost intervals remain disclosed.
  assert.equal(f.pump.status().interruptions, 1);
  f.pump.close(); f.advance(400_000); f.pump.tick(true); first.message(event(4));
  assert.equal(f.sockets.length, 2);
  assert.equal(f.pump.status().state, 'stopped');
});

test('connecting timeouts and silent streams reconnect without parallel sockets or stale-event loops', () => {
  const f = fixture();
  f.pump.tick(true); f.advance(10_001); f.pump.tick(true);
  assert.equal(f.pump.status().state, 'unavailable');
  assert.equal(f.sockets[0].closes, 1);
  f.advance(10_000); const second = f.connect(); second.message(event());
  f.advance(90_001); f.pump.tick(true);
  assert.equal(f.pump.status().state, 'unavailable');
  f.advance(10_000); f.connect(); f.pump.tick(true);
  assert.equal(f.pump.status().state, 'connected');
  assert.equal(f.sockets.length, 3);
  f.pump.close();
});

test('malformed/oversized messages and provider errors cannot masquerade as an empty working stream', async () => {
  for (const payload of ['{', 'x'.repeat(65537), JSON.stringify({ errors: ['private error'] }),
    JSON.stringify({ message: 'API key required' })]) {
    const f = fixture(), socket = f.connect();
    socket.dispatchEvent(new MessageEvent('message', { data: payload }));
    assert.equal(f.pump.status().state, 'unavailable');
    assert.equal((await f.pump.read()).candidates.length, 0);
    assert.doesNotMatch(JSON.stringify(f.pump.status()), /private error|API key required/);
    f.pump.close();
  }
  const f = fixture(), socket = f.connect();
  socket.message(event(1, { mint: 'bad' })); socket.message(event());
  assert.equal(f.pump.status().rejected, 1);
  assert.equal((await f.pump.read()).partial, true);
  f.pump.close();
});

test('queue capacity, rotation and expiry stay bounded; duplicate events do not extend lifetime', async () => {
  const f = fixture(), socket = f.connect();
  for (let i = 1; i <= PUMP_CAPACITY + 2; i++) socket.message(event(i));
  assert.equal(f.pump.status().candidateCount, PUMP_CAPACITY);
  assert.equal(f.pump.status().dropped, 2);
  const first = (await f.pump.read()).candidates.slice(0, 10);
  f.pump.selected(first);
  assert.equal((await f.pump.read()).candidates[0].address, mint(11));
  f.advance(PUMP_TTL_MS - 1); socket.message(event(1));
  assert.equal((await f.pump.read()).candidates.find((c) => c.address === mint(1)).provenance[0].receivedAt, NOW);
  f.advance(1);
  assert.equal(f.pump.status().candidateCount, 0);
  assert.equal(f.pump.status().expired, PUMP_CAPACITY);
  f.pump.close();
});

test('migration refreshes a queued launch once; later creation/duplicate migration cannot reset it', async () => {
  const f = fixture(), socket = f.connect(); socket.message(event());
  f.advance(60_000); socket.message(event(1, { txType: 'migrate', pool: 'pump-amm' }));
  const candidate = (await f.pump.read()).candidates[0];
  assert.equal(candidate.provenance[0].kind, 'migrate');
  assert.equal(candidate.provenance[0].receivedAt, NOW + 60_000);
  f.advance(60_000); socket.message(event()); socket.message(event(1, { txType: 'migrate', pool: 'pump-amm' }));
  assert.deepEqual((await f.pump.read()).candidates, [candidate]);
  f.pump.close();
});

test('combined sources share a fair cap, merge provenance and leave diagnostic reads out of scheduling', async () => {
  const f = fixture(), socket = f.connect();
  for (let i = 1; i <= 30; i++) socket.message(event(i));
  const feed = createCandidateSources({ gecko: gecko(Array.from({ length: 20 }, (_, i) => mint(i + 21))), pump: f.pump, now: f.now });
  const first = await feed.read({ diagnostic: true });
  assert.equal(first.candidates.length, 20);
  assert.equal(new Set(first.candidates.map((c) => c.address)).size, 20);
  assert.equal(first.deferred, 20);
  assert.equal(first.partial, true);
  assert.equal(first.candidates.filter((c) => c.provenance.some((p) => p.source === 'geckoterminal')).length, 10);
  assert.equal(first.candidates.filter((c) => c.provenance.some((p) => p.source === 'pumpportal')).length, 20);
  const second = await feed.read();
  assert.deepEqual(first.candidates.map((c) => c.address), second.candidates.map((c) => c.address));
  feed.selected(first.candidates);
  assert.equal((await feed.read()).candidates[0].address, mint(11));
  f.pump.close();
});

test('one failed source leaves visible partial coverage; two failed sources never report an empty successful scan', async () => {
  const f = fixture(), socket = f.connect(); socket.message(event());
  const feed = createCandidateSources({ gecko: missingGecko, pump: f.pump, now: f.now });
  assert.equal((await feed.read()).candidates[0].address, mint(1));
  assert.equal(feed.status().state, 'partial');
  socket.error();
  await assert.rejects(feed.read(), /SOURCES_UNAVAILABLE/);
  const workingGecko = createCandidateSources({ gecko: gecko([mint(9)]), pump: f.pump, now: f.now });
  const partial = await workingGecko.read();
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.candidates.map((c) => c.address), [mint(9)]);
  const disabled = fixture({ enabled: false });
  const onlyGecko = createCandidateSources({ gecko: gecko([mint(9)]), pump: disabled.pump, now: f.now });
  assert.equal((await onlyGecko.read()).partial, false);
  assert.equal(onlyGecko.status().state, 'responded');
  f.pump.close();
});

test('a stream disconnect during a slow HTTP read cannot reuse the earlier live snapshot', async () => {
  const f = fixture(), socket = f.connect(); socket.message(event());
  const slowGecko = { status: () => ({ state: 'unavailable' }), read: async () => {
    await Promise.resolve(); socket.error(); throw new Error('Source unavailable');
  } };
  const feed = createCandidateSources({ gecko: slowGecko, pump: f.pump, now: f.now });
  await assert.rejects(feed.read(), /SOURCES_UNAVAILABLE/);
  assert.equal(feed.status().state, 'unavailable');
  f.pump.close();
});

test('Pump.fun candidates wait for required market data, then send one attributed CA through the existing scanner', async (t) => {
  const store = storeFor(t); activate(store);
  const f = fixture(), socket = f.connect(); t.after(() => f.pump.close());
  socket.message(event(1, { marketCapSol: 40000, liquidityLocked: true }));
  const feed = createCandidateSources({ gecko: gecko(), pump: f.pump, now: f.now });
  let indexed = false;
  const sent = [], shared = [];
  const runner = createDiscoveryRunner({ feed, agents: store, allowedUserIds: new Set([42]), now: f.now,
    market: { check: async (ca) => normalisePairs(indexed ? [pair(ca)] : [], ca, f.now()) },
    call: async (_, body) => sent.push(body), groups: { beginCycle() {}, deliver: async (...args) => shared.push(args) } });
  await runner.cycle();
  assert.equal(sent.length, 0);
  assert.equal(store.discoveryGet(42).issue, 'MARKET_NOT_INDEXED');
  indexed = true;
  await runner.cycle();
  assert.equal(sent.length, 1);
  assert.equal(shared.length, 1);
  assert.match(sent[0].text, /Pump.fun launch reported by PumpPortal/);
  assert.match(sent[0].text, /PASS · Required · Market cap/);
  assert.ok(sent[0].text.includes(`CA: ${mint(1)}`));
  assert.ok(sent[0].text.includes(`https://solscan.io/tx/${signature}`));
  await runner.cycle();
  assert.equal(sent.length, 1);
});

test('Pump metadata cannot bypass risk requirements, approve rules or activate a scan', async (t) => {
  const store = storeFor(t);
  const approved = agent(); approved.rules.push({ field: 'buyingCoordination', mode: 'require', policy: 'private-test-v1' });
  activate(store, approved);
  const f = fixture(), socket = f.connect(); t.after(() => f.pump.close());
  socket.message(event(1, { liquidityLocked: true, bundled: false, creatorHolding: true }));
  const feed = createCandidateSources({ gecko: gecko(), pump: f.pump, now: f.now });
  await createDiscoveryRunner({ feed, agents: store, allowedUserIds: new Set([42]), now: f.now,
    market: { check: async (ca) => normalisePairs([pair(ca)], ca, f.now()) },
    call: async () => assert.fail('Unknown risk must not generate an alert') }).cycle();
  assert.equal(store.discoveryGet(42).matched, 0);
  assert.equal(store.discoveryGet(42).issue, 'RISK_UNKNOWN');
  store.discoverySet(42, 'stopped', criteriaKey(approved));
  const saved = store.get(42);
  const respond = createResponder({ agents: store, feed });
  const reply = await respond(input('/sources'), new Set([42]));
  assert.match(reply.text, /Pump.fun via PumpPortal/);
  assert.match(reply.text, /does not approve rules or activate scanning/);
  assert.deepEqual(store.get(42), saved);
  assert.equal(store.discoveryGet(42).state, 'stopped');
  assert.ok(reply.text.length < 4000);
});

test('non-testers cannot open a PumpPortal diagnostic connection and idle runtime stops cleanly', async (t) => {
  const store = storeFor(t), f = fixture();
  const feed = createCandidateSources({ gecko: missingGecko, pump: f.pump, now: f.now });
  const respond = createResponder({ agents: store, feed });
  await respond(input('/sources', 99), new Set([42]));
  assert.equal(f.sockets.length, 0);
  const abort = new AbortController(); let ticks = 0;
  const sockets = [];
  const running = createPumpFeed({ socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    wait: async () => { ticks++; if (ticks === 2) abort.abort(); } });
  await running.run({ signal: abort.signal, shouldListen: () => ticks === 1 });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closes, 1);
  assert.equal(running.status().state, 'stopped');
});

test('dual-source attribution stays within Telegram limits with maximum market metadata', () => {
  const approved = agent(); approved.name = 'N'.repeat(32);
  approved.rules.push({ field: 'liquidityUsd', mode: 'warn', value: 1e12 }, { field: 'volume1h', mode: 'warn', value: 1e12 }, { field: 'poolAgeMinutes', mode: 'warn', value: 1e12 });
  const snapshot = normalisePairs([pair(mint(1), { baseToken: { address: mint(1), name: 'X'.repeat(64), symbol: 'Y'.repeat(64) },
    dexId: 'D'.repeat(64), quoteToken: { symbol: 'Q'.repeat(64) },
    liquidity: { usd: Number.MAX_VALUE }, volume: { m5: Number.MAX_VALUE, h1: Number.MAX_VALUE, h24: Number.MAX_VALUE } })], mint(1), NOW);
  const candidate = normalisePumpEvent(event(), NOW);
  candidate.provenance.push({ source: 'geckoterminal', receivedAt: NOW, sourceUrl: FEED_URL });
  assert.ok(formatDiscoveryAlert(approved, snapshot, {}, candidate).length < 4000);
});
