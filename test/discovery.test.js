import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscoveryFeed, normaliseCandidates, FEED_URL, DiscoveryFeedError } from '../src/discovery-feed.js';
import { createDiscoveryRunner, formatDiscoveryAlert } from '../src/discovery.js';
import { criteriaKey } from '../src/discovery-store.js';
import { openAgentStore } from '../src/agent-store.js';
import { createResponder } from '../src/commands.js';
import { createMarketData, normalisePairs, MarketDataError } from '../src/market.js';
import { TelegramError } from '../src/telegram.js';

// Synthetic fixtures only. These format-valid addresses and numbers are not
// findings about real tokens. No test contacts a provider or Telegram.
const NOW = 1800000000000;
const address = (n) => '1'.repeat(31) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n];
const CA = address(1);
const allowed = new Set([42, 57]);
let sequence = 10000;
const input = (text, id = 42) => ({ update_id: ++sequence, message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });
const callback = (data, id = 42) => ({ update_id: ++sequence, callback_query: { id: 'cb' + sequence, data, from: { id, is_bot: false }, message: { chat: { id, type: 'private' } } } });
const cap = { field: 'marketCap', mode: 'require', min: 20000, max: 60000 };
const agent = () => ({ name: 'SYNTHETIC TEST', rules: [cap], pendingRequirements: [] });
const state = () => ({ revision: 1, approved: agent(), draft: null });
const pool = (mint = CA, poolAddress = address(20)) => ({ type: 'pool', id: `solana_${poolAddress}`,
  attributes: { address: poolAddress }, relationships: { base_token: { data: { id: `solana_${mint}`, type: 'token' } } } });
const pair = (mint = CA, overrides = {}) => ({ chainId: 'solana', pairAddress: address(20),
  baseToken: { address: mint, name: 'SYNTHETIC TOKEN', symbol: 'TEST' }, marketCap: 40000, fdv: 40000,
  liquidity: { usd: 30000 }, volume: { h1: 60000 }, pairCreatedAt: NOW - 60000, ...overrides });
const batch = (mints = [CA]) => normaliseCandidates({ data: mints.map((mint, i) => pool(mint, address(i + 20))) }, NOW);
const feedStub = (data = batch()) => ({ read: async () => data, status: () => ({ state: 'not_checked' }) });
const noRequest = async () => assert.fail('Unexpected outbound request');
const storeFor = (t) => { const store = openAgentStore({ memory: true }); t.after(() => store.close()); return store; };
const approve = (store, id = 42) => store.put(id, state());
const activate = (store, id = 42) => { approve(store, id); store.discoverySet(id, 'active', criteriaKey(agent())); };
const startButton = (reply) => reply.reply_markup?.inline_keyboard.flat().find((b) => b.text === 'Start discovery')?.callback_data;

test('candidate identities come from Solana base-token relationships, with deduplication and malformed-coverage reporting', () => {
  const good = pool();
  const wrongChain = { ...pool(), id: `eth_${address(20)}` };
  const wrongToken = pool(); wrongToken.relationships.base_token.data.id = `eth_${CA}`;
  const quoteOnly = pool(); delete quoteOnly.relationships.base_token; quoteOnly.relationships.quote_token = good.relationships.base_token;
  const result = normaliseCandidates({ data: [good, pool(CA, address(21)), wrongChain, wrongToken, quoteOnly] }, NOW);
  assert.deepEqual(result.candidates, [{ address: CA, poolAddress: address(20) }]);
  assert.equal(result.invalidPools, 3);
  assert.equal(result.returnedPools, 5);
  assert.throws(() => normaliseCandidates({ data: [wrongChain] }, NOW), /INVALID_RESPONSE/);
  assert.throws(() => normaliseCandidates({ unexpected: [] }, NOW), /INVALID_RESPONSE/);
  assert.deepEqual(normaliseCandidates({ data: [] }, NOW).candidates, []);
});

test('public feed sends no credentials, declares caching and drops stale success after a failed refresh', async () => {
  let time = NOW, requests = 0;
  const feed = createDiscoveryFeed({ now: () => time, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, FEED_URL);
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    if (requests > 1) throw new Error('PRIVATE_DETAILS');
    return Response.json({ data: [pool()] });
  } });
  assert.equal((await feed.read()).cached, false);
  time += 59000;
  assert.equal((await feed.read()).cached, true);
  assert.equal(requests, 1);
  time += 1000;
  await assert.rejects(feed.read(), (e) => e instanceof DiscoveryFeedError && !e.stack.includes('PRIVATE_DETAILS'));
  assert.equal(feed.status().state, 'unavailable');
  await assert.rejects(feed.read(), /COOLDOWN/);
});

test('feed rate limits, oversized bodies, malformed JSON and cancellation do not become successful empty scans', async () => {
  let requests = 0;
  const limited = createDiscoveryFeed({ now: () => NOW, fetchImpl: async () => {
    requests++; return new Response('', { status: 429, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(limited.read(), (e) => e.code === 'RATE_LIMITED' && e.retryAfter === 120);
  await assert.rejects(limited.read(), /COOLDOWN/);
  assert.equal(requests, 1);
  for (const response of [new Response('{'), Response.json({ error: 'provider error' }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const feed = createDiscoveryFeed({ fetchImpl: async () => response });
    await assert.rejects(feed.read(), DiscoveryFeedError);
    assert.equal(feed.status().state, 'unavailable');
  }
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(createDiscoveryFeed({ fetchImpl: noRequest }).read({ signal: stopped.signal }), /STOPPED/);
});

test('full unresolved drafts cannot activate and inactive or unlisted accounts cannot cause background requests', async (t) => {
  const store = storeFor(t);
  const saved = state(); saved.approved = null;
  saved.draft = { ...agent(), step: 6, pendingRequirements: ['100% protected liquidity, six months remaining; developer holding; no confirmed bundles.'] };
  store.put(42, saved);
  const feed = { read: noRequest, status: () => ({ state: 'not_checked' }) };
  const respond = createResponder({ agents: store, feed });
  assert.equal(startButton(await respond(input('/scan'), allowed)), undefined);
  const blocked = await respond(callback('scan:42:start:1'), allowed);
  assert.match(blocked.callbackNotice, /blocked/);
  assert.equal(store.discoveryGet(42).state, 'stopped');
  activate(store, 99); // previously allowed account removed from configuration
  await createDiscoveryRunner({ agents: store, feed, market: { check: noRequest }, call: noRequest, allowedUserIds: allowed }).cycle();
  assert.match((await respond(input('/sources', 99), allowed)).text, /does not have tester access/);
});

test('scan activation requires a current owner button; pause, resume and stop are per user', async (t) => {
  const store = storeFor(t); approve(store); approve(store, 57);
  const respond = createResponder({ agents: store, feed: feedStub() });
  const review = await respond(input('/scan'), allowed);
  assert.equal(store.discoveryGet(42).state, 'stopped');
  const start = startButton(review);
  assert.ok(start);
  assert.match((await respond(callback(start, 57), allowed)).callbackNotice, /does not belong/);
  const changed = store.get(42); changed.revision++; store.put(42, changed);
  assert.match((await respond(callback(start), allowed)).callbackNotice, /Rules changed/);
  await respond(callback(startButton(await respond(input('/scan'), allowed))), allowed);
  assert.equal(store.discoveryGet(42).state, 'active');
  await respond(input('/pause'), allowed);
  assert.equal(store.discoveryGet(42).state, 'paused');
  await respond(input('/resume'), allowed);
  assert.equal(store.discoveryGet(42).state, 'active');
  await respond(input('/stop'), allowed);
  assert.equal(store.discoveryGet(42).state, 'stopped');
  await respond(input('/resume'), allowed);
  assert.equal(store.discoveryGet(42).state, 'stopped');
  assert.equal(store.discoveryGet(57).state, 'stopped');
});

test('a complete synthetic feed-to-market-to-Telegram cycle sends the CA and evidence once', async (t) => {
  const store = storeFor(t); activate(store);
  const feed = createDiscoveryFeed({ now: () => NOW, fetchImpl: async () => Response.json({ data: [pool()] }) });
  const market = createMarketData({ now: () => NOW, fetchImpl: async () => Response.json([pair()]) });
  const sent = [];
  const runner = createDiscoveryRunner({ feed, market, agents: store, allowedUserIds: allowed, now: () => NOW,
    call: async (method, body) => { assert.equal(method, 'sendMessage'); sent.push(body); }, wait: async () => {} });
  await runner.cycle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 42);
  assert.match(sent[0].text, /Discovery match/);
  assert.ok(sent[0].text.includes('CA: ' + CA));
  assert.deepEqual(sent[0].entities.map((e) => sent[0].text.slice(e.offset, e.offset + e.length)), [CA]);
  assert.equal(sent[0].reply_markup.inline_keyboard.flat().find((b) => b.text === 'Copy CA').copy_text.text, CA);
  assert.ok(sent[0].reply_markup.inline_keyboard.flat().find((b) => b.text === 'Monitor').callback_data);
  assert.ok(sent[0].text.includes('https://dexscreener.com/solana/' + address(20)));
  assert.match(sent[0].text, /PASS · Required · Market cap/);
  assert.match(sent[0].text, /Provider update time: unknown/);
  assert.doesNotMatch(sent[0].text, /Manual market snapshot|Automatic discovery is not running|No strategy has been applied/);
  assert.equal(store.discoveryHistory(42)[0].state, 'sent');
  assert.equal(store.discoveryHistory(57).length, 0);
  const respond = createResponder({ agents: store, feed, market });
  const history = await respond(input('/alerts'), allowed);
  assert.equal(history.reply_markup.inline_keyboard.flat().find((b) => b.copy_text).copy_text.text, CA);
  const view = history.reply_markup.inline_keyboard.flat().find((b) => b.text.startsWith('View report'));
  const saved = await respond(callback(view.callback_data), allowed);
  assert.equal(saved.reply_markup.inline_keyboard.flat().find((b) => b.copy_text).copy_text.text, CA);
  assert.deepEqual(saved.entities.map((e) => saved.text.slice(e.offset, e.offset + e.length)), [CA]);
  // Use a non-throttled market stub for the next cycle; identity dedup survives a fresh snapshot.
  await createDiscoveryRunner({ feed: feedStub(), market: { check: async () => normalisePairs([pair()], CA, NOW) },
    agents: store, allowedUserIds: allowed, call: noRequest, now: () => NOW }).cycle();
  assert.equal(store.discoveryHistory(42).length, 1);
});

test('missing strict market cap never substitutes FDV; source outages remain visible', async (t) => {
  const store = storeFor(t); activate(store);
  const run = (feed, market) => createDiscoveryRunner({ feed, market, agents: store, allowedUserIds: allowed, call: noRequest, now: () => NOW }).cycle();
  await run(feedStub(), { check: async () => normalisePairs([pair(CA, { marketCap: null, fdv: 40000 })], CA, NOW) });
  assert.equal(store.discoveryGet(42).matched, 0);
  await run({ read: async () => { throw new Error('PRIVATE'); } }, { check: noRequest });
  assert.equal(store.discoveryGet(42).issue, 'FEED_UNAVAILABLE');
  await run(feedStub(), { check: async () => { throw new MarketDataError('SOURCE_UNAVAILABLE'); } });
  assert.equal(store.discoveryGet(42).issue, 'MARKET_UNAVAILABLE');
  assert.equal(store.discoveryHistory(42).length, 0);
});

test('pausing or replacing approved rules during a market request prevents the stale alert', async (t) => {
  const store = storeFor(t);
  for (const mutation of [() => store.discoverySet(42, 'paused', criteriaKey(agent())), () => {
    const saved = store.get(42); saved.approved.rules = [{ ...cap, min: 50000 }]; saved.revision++; store.put(42, saved);
  }]) {
    activate(store);
    const market = { check: async () => { mutation(); return normalisePairs([pair()], CA, NOW); } };
    await createDiscoveryRunner({ feed: feedStub(), market, agents: store, allowedUserIds: allowed, call: noRequest }).cycle();
    assert.equal(store.discoveryGet(42).state, 'paused');
  }
  assert.equal(store.discoveryHistory(42).length, 0);
});

test('late, future and wrong-token market snapshots cannot produce discovery matches',async t=>{
  for(const returned of [normalisePairs([pair()],CA,NOW-120001),normalisePairs([pair()],CA,NOW+1),normalisePairs([pair(address(2))],address(2),NOW)]) {
    const store=storeFor(t);activate(store);
    await createDiscoveryRunner({agents:store,allowedUserIds:allowed,now:()=>NOW,feed:feedStub(),market:{check:async()=>returned},call:noRequest}).cycle();
    assert.equal(store.discoveryGet(42).issue,'MARKET_UNAVAILABLE');
    assert.equal(store.discoveryHistory(42).length,0);
  }
});

test('a delayed first recipient cannot cause a second user to receive an expired snapshot',async t=>{
  const store=storeFor(t);activate(store,42);activate(store,57);
  let clock=NOW;const sends=[];
  await createDiscoveryRunner({agents:store,allowedUserIds:allowed,now:()=>clock,feed:feedStub(),market:{check:async()=>normalisePairs([pair()],CA,NOW)},
    call:async(_,body)=>{sends.push(body.chat_id);clock=NOW+120001;}}).cycle();
  assert.deepEqual(sends,[42]);
  assert.equal(store.discoveryGet(57).issue,'MARKET_UNAVAILABLE');
  assert.equal(store.discoveryGet(57).matched,0);
});

test('candidate and alert limits are bounded, suppression is visible and muted tokens stay silent', async (t) => {
  const store = storeFor(t); activate(store);
  const mints = Array.from({ length: 21 }, (_, i) => address(i + 1));
  store.discoveryMute(42, mints[0]);
  let sends = 0;
  const runner = createDiscoveryRunner({ agents: store, feed: feedStub(batch(mints)),
    market: { check: async (ca) => normalisePairs([pair(ca)], ca, NOW) },
    call: async () => { sends++; }, allowedUserIds: allowed, now: () => NOW });
  await runner.cycle();
  assert.equal(sends, 3);
  assert.equal(store.discoveryGet(42).checked, 20);
  assert.equal(store.discoveryGet(42).suppressed, 17);
  assert.equal(store.discoveryGet(42).issue, 'PARTIAL_COVERAGE');
  assert.equal(store.discoveryHistory(42).some((row) => row.token === mints[0]), false);
});

test('Telegram rate limits defer other matches and revoked chat access pauses only that user', async (t) => {
  const store = storeFor(t); activate(store); activate(store, 57);
  let time = NOW, sends = 0;
  const runner = createDiscoveryRunner({ agents: store, feed: feedStub(batch([CA, address(2)])),
    market: { check: async (ca) => normalisePairs([pair(ca)], ca, time) }, allowedUserIds: allowed, now: () => time,
    call: async () => { sends++; throw new TelegramError(429, 120); } });
  await runner.cycle();
  assert.equal(sends, 1);
  assert.equal(store.discoveryIssues(42), 1);
  assert.equal(store.discoveryGet(57).issue, 'DELIVERY_LIMITED');
  time += 60_000;
  await runner.cycle();
  assert.equal(sends, 1);
  // A separate runtime verifies that one blocked chat does not halt other users.
  const delivered = [];
  await createDiscoveryRunner({ agents: store, feed: feedStub(batch([address(3)])),
    market: { check: async (ca) => normalisePairs([pair(ca)], ca, time) }, allowedUserIds: allowed, now: () => time,
    call: async (_method, body) => { if (body.chat_id === 42) throw new TelegramError(403); delivered.push(body.chat_id); } }).cycle();
  assert.equal(store.discoveryGet(42).state, 'paused');
  assert.equal(store.discoveryGet(42).issue, 'CHAT_UNAVAILABLE');
  assert.equal(store.discoveryGet(57).state, 'active');
  assert.deepEqual(delivered, [57]);
});

test('a crash after reserving delivery leaves a recoverable report without an automatic duplicate', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sift-pending-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = openAgentStore({ directory }); activate(store);
  const eventId = store.discoveryReserve(42, criteriaKey(agent()), CA, NOW, { text: 'SYNTHETIC saved report' });
  store.close(); store = openAgentStore({ directory }); t.after(() => store.close());
  await createDiscoveryRunner({ agents: store, feed: feedStub(),
    market: { check: async () => normalisePairs([pair()], CA, NOW) }, allowedUserIds: allowed, call: noRequest }).cycle();
  const respond = createResponder({ agents: store, feed: feedStub() });
  assert.equal(store.discoveryIssues(42), 1);
  assert.match((await respond(input('/alerts'), allowed)).text, /delivery uncertain/);
  assert.match((await respond(callback(`scan:42:view:${eventId}`), allowed)).text, /SYNTHETIC saved report/);
});

test('the source diagnostic preserves a blocked draft and never activates discovery', async (t) => {
  const store = storeFor(t);
  const saved = state(); saved.approved = null;
  saved.draft = { ...agent(), step: 6, pendingRequirements: ['Verified liquidity lock required.'] };
  store.put(42, saved);
  const respond = createResponder({ agents: store, feed: feedStub() });
  const reply = await respond(input('/sources'), allowed);
  assert.match(reply.text, /1 distinct Solana base-token/);
  assert.deepEqual(store.get(42), saved);
  assert.equal(store.discoveryGet(42).state, 'stopped');
});

test('uncertain delivery is recorded and not retried blindly; alert history and mute buttons enforce ownership', async (t) => {
  const store = storeFor(t); activate(store);
  const feed = feedStub();
  const market = { check: async () => normalisePairs([pair()], CA, NOW) };
  let sends = 0;
  const runner = createDiscoveryRunner({ agents: store, feed, market, allowedUserIds: allowed, now: () => NOW,
    call: async () => { sends++; throw new TelegramError('NETWORK_OR_RESPONSE'); } });
  await runner.cycle(); await runner.cycle();
  assert.equal(sends, 1);
  assert.equal(store.discoveryIssues(42), 1);
  const event = store.discoveryHistory(42)[0];
  assert.equal(event.state, 'uncertain');
  const respond = createResponder({ agents: store, feed, market });
  assert.match((await respond(input('/alerts'), allowed)).text, /uncertain/);
  assert.doesNotMatch((await respond(input('/alerts', 57), allowed)).text, new RegExp(CA));
  assert.match((await respond(callback(`scan:57:view:${event.id}`, 57), allowed)).callbackNotice, /not available/);
  assert.match((await respond(callback(`scan:42:view:${event.id}`), allowed)).text, /not a fresh check/);
  await respond(callback(`scan:42:mute:${event.id}`), allowed);
  assert.equal(store.discoveryMuted(42, CA), true);
  assert.equal(store.discoveryMuted(57, CA), false);
  await respond(input('/unmute ' + CA), allowed);
  assert.equal(store.discoveryMuted(42, CA), false);
});

test('discovery state, history and deduplication survive a restart without changing the existing criteria schema', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sift-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = openAgentStore({ directory }); activate(store);
  let sends = 0;
  const cycle = () => createDiscoveryRunner({ agents: store, feed: feedStub(), market: { check: async () => normalisePairs([pair()], CA, NOW) },
    allowedUserIds: allowed, now: () => NOW, call: async () => { sends++; } }).cycle();
  await cycle(); store.close();
  store = openAgentStore({ directory });
  assert.deepEqual(store.get(42).approved, agent());
  assert.equal(store.discoveryGet(42).state, 'active');
  await cycle();
  assert.equal(sends, 1);
  store.discoverySet(42, 'paused', criteriaKey(agent())); store.close();
  store = openAgentStore({ directory });
  assert.equal(store.discoveryGet(42).state, 'paused');
  store.close();
});

test('discovery and saved-report messages stay within Telegram limits with four rules and maximum metadata', () => {
  const approved = agent(); approved.name = 'N'.repeat(32);
  approved.rules.push({ field: 'liquidityUsd', mode: 'warn', value: 1e12 }, { field: 'volume1h', mode: 'warn', value: 1e12 }, { field: 'poolAgeMinutes', mode: 'warn', value: 1e12 });
  const snapshot = normalisePairs([pair(CA, { baseToken: { address: CA, name: 'X'.repeat(64), symbol: 'Y'.repeat(64) },
    dexId: 'D'.repeat(64), quoteToken: { symbol: 'Q'.repeat(64) },
    liquidity: { usd: Number.MAX_VALUE }, volume: { m5: Number.MAX_VALUE, h1: Number.MAX_VALUE, h24: Number.MAX_VALUE } })], CA, NOW);
  assert.ok(formatDiscoveryAlert(approved, snapshot, batch()).length < 4000);
});
