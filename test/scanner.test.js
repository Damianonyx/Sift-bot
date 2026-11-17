import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_FRESHNESS_MS, mergeTokenLevel, runScanCycle, withDiscoveryBackoff } from '../src/scanner.js';
import { MAX_ALERT_ATTEMPTS, openStore } from '../src/store.js';
import { TelegramError } from '../src/telegram.js';

const silent = { warn() {}, info() {} };
const MIN = 60_000;
const START = Date.parse('2026-11-17T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const value = (v, provider, at) => ({ value: v, source: 'live', provider, asOf: iso(at) });
const UNKNOWN = { value: null, source: 'unknown', provider: null, asOf: null };
// The 'z' separator keeps addresses unique: 'T1' and 'T11' padded with '1's collide.
const token = (n) => `T${n}z`.padEnd(44, '1');
const poolAddr = (n) => `P${n}z`.padEnd(44, '1');

// A pool as discovery reports it: pool values from GeckoTerminal, no market cap.
const launched = (n, at, { liquidity = 5_000 } = {}) => ({
  poolAddress: poolAddr(n), tokenAddress: token(n), name: `T${n} / SOL`, dexId: 'pump-fun',
  url: `https://www.geckoterminal.com/solana/pools/${poolAddr(n)}`,
  metrics: {
    liquidityUsd: value(liquidity, 'GeckoTerminal', at), volume1hUsd: value(100, 'GeckoTerminal', at),
    txns1h: value(12, 'GeckoTerminal', at), poolAgeMinutes: value(1, 'GeckoTerminal', at),
    marketCapUsd: UNKNOWN, fdvUsd: UNKNOWN,
  },
});
// DexScreener's view of a token: market cap known, bonding curve has no liquidity.
const dexscreener = (n, at, { marketCap, liquidity = null }) => ({
  metrics: {
    marketCapUsd: value(marketCap, 'DexScreener', at), fdvUsd: value(marketCap, 'DexScreener', at),
    liquidityUsd: liquidity === null ? UNKNOWN : value(liquidity, 'DexScreener', at),
    volume1hUsd: value(800, 'DexScreener', at), txns1h: value(40, 'DexScreener', at), poolAgeMinutes: value(6, 'DexScreener', at),
  },
  pool: { name: `T${n} / SOL`, dexId: 'pumpfun', pairAddress: poolAddr(n), url: `https://dexscreener.com/solana/${n}`, poolCount: null, selection: 'DexScreener main pool' },
});

const rule = (over) => ({ op: 'gte', severity: 'require', evidence: 'quoted', ...over });
const LIQ_AND_MCAP = {
  rules: [rule({ field: 'liquidityUsd', value: 1_000, evidence: '1k liquidity' }),
    rule({ field: 'marketCapUsd', op: 'lte', value: 500_000, evidence: 'mcap under 500k' })],
  unresolved: [],
};
const MCAP_ONLY = { rules: [rule({ field: 'marketCapUsd', op: 'lte', value: 500_000, evidence: 'mcap under 500k' })], unresolved: [] };

function world({ criteria = MCAP_ONLY, testers = [42], allowed = testers } = {}) {
  const store = openStore(':memory:');
  for (const id of testers) {
    store.setDraft(id, criteria);
    store.approveDraft(id);
    store.setScanning(id, true);
  }
  const clock = { now: START };
  const state = { pools: [], data: new Map(), refreshCalls: [], discoveryCalls: 0, sent: [], refreshFails: false };
  const deps = {
    store,
    log: silent,
    allowedUserIds: new Set(allowed),
    now: () => clock.now,
    pace: async () => {},
    signal: new AbortController().signal,
    discovery: async () => { state.discoveryCalls += 1; return { ok: true, pools: state.pools, pages: 1, checkedAt: iso(clock.now) }; },
    refresh: async (tokens) => {
      state.refreshCalls.push([...tokens]);
      if (state.refreshFails) return { ok: false, reason: 'RATE_LIMITED' };
      const byToken = new Map(tokens.filter((t) => state.data.has(t)).map((t) => [t, state.data.get(t)]));
      return { ok: true, byToken, checkedAt: iso(clock.now) };
    },
    send: async (message) => { state.sent.push(message); },
  };
  return { store, clock, state, cycle: (over = {}) => runScanCycle({ ...deps, ...over }) };
}

test('token-level values fill gaps only; pool-level values stay those of the discovered pool', () => {
  const gt = launched(1, START).metrics;
  const ds = dexscreener(1, START, { marketCap: 40_000, liquidity: 99 }).metrics;
  const merged = mergeTokenLevel(gt, ds);
  assert.equal(merged.marketCapUsd.provider, 'DexScreener');
  assert.equal(merged.liquidityUsd.provider, 'GeckoTerminal'); // not replaced by another pool's figure
  assert.equal(merged.liquidityUsd.value, 5_000);
  assert.equal(mergeTokenLevel(gt, undefined), gt);
  // Even when the discovered pool's liquidity is unknown, another pool's
  // figure is never borrowed: pool values describe the discovered pool.
  const noLiquidity = mergeTokenLevel({ ...gt, liquidityUsd: UNKNOWN }, ds);
  assert.equal(noLiquidity.liquidityUsd.source, 'unknown');
});

test('at launch: GeckoTerminal liquidity plus DexScreener market cap can match, once, with providers named', async () => {
  const { state, cycle, store } = world({ criteria: LIQ_AND_MCAP });
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  await cycle();
  assert.equal(state.sent.length, 1);
  const { text, entities } = state.sent[0];
  assert.match(text, /^Sift alert: T1 \/ SOL matches your criteria v1\./);
  assert.match(text, /✓ require selected-pool liquidity ≥ \$1,000 — \$5,000 \(GeckoTerminal, 14:00 UTC\)/);
  assert.match(text, /✓ require market cap ≤ \$500,000 — \$40,000 \(DexScreener, 14:00 UTC\)/);
  assert.match(text, /most scams live: verify before acting/);
  // The token address is tap-to-copy.
  const code = entities.find((e) => e.type === 'code');
  assert.equal(text.slice(code.offset, code.offset + code.length), token(1));
  await cycle(); // same pool and token again: no second alert
  assert.equal(state.sent.length, 1);
  assert.equal(store.getLastScan().newMatches, 0);
});

test('missing market cap at launch is unknown, so nothing alerts', async () => {
  const { state, cycle } = world();
  state.pools = [launched(1, START)]; // DexScreener has not indexed the token yet
  await cycle();
  assert.equal(state.sent.length, 0);
});

test('the watch list catches a token that only matches minutes after launch', async () => {
  const { state, cycle, clock } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 2_000_000 })); // too big at launch
  await cycle();
  assert.equal(state.sent.length, 0);

  clock.now = START + 7 * MIN;
  state.pools = []; // no new launches this minute
  state.data.set(token(1), dexscreener(1, clock.now, { marketCap: 300_000 }));
  await cycle();
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /\$300,000 \(DexScreener, 14:07 UTC\)/);
  assert.match(state.sent[0].text, /First seen by Sift 14:00 UTC .* values checked 14:07 UTC/);
  assert.match(state.sent[0].text, /pool age 6 min/);
});

test('tokens leave the watch list after the window and are no longer checked', async () => {
  const { state, cycle, clock, store } = world();
  state.pools = [launched(1, START)];
  await cycle({ watchMs: 30 * MIN });
  assert.equal(store.countCandidates(), 1);
  clock.now = START + 31 * MIN;
  state.pools = [];
  state.refreshCalls.length = 0;
  await cycle({ watchMs: 30 * MIN });
  assert.equal(store.countCandidates(), 0);
  assert.deepEqual(state.refreshCalls, []);
});

test('nobody allowed and scanning means no data source is contacted', async () => {
  const off = world({ testers: [42], allowed: [] }); // scanning, but removed from the allow-list
  off.state.pools = [launched(1, START)];
  await off.cycle();
  assert.equal(off.state.discoveryCalls, 0);
  assert.equal(off.state.refreshCalls.length, 0);
});

test('removing a tester from the allow-list stops their queued alerts at once', async () => {
  const { state, cycle } = world({ testers: [42, 57] });
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  await cycle({ send: async () => { throw new TelegramError(500); } }); // queued, first sends fail
  await cycle({ allowedUserIds: new Set([57]) }); // 42 revoked before the retry
  assert.deepEqual(state.sent.map((m) => m.chat_id), [57]);
});

test('/scan off also stops alerts that were already queued', async () => {
  const { state, cycle, store } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  await cycle({ send: async () => { throw new TelegramError(500); } });
  store.setScanning(42, false);
  await cycle();
  assert.equal(state.sent.length, 0);
});

test('undelivered alerts older than the freshness window are dropped, not sent late', async () => {
  const { state, cycle, clock } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  await cycle({ send: async () => { throw new TelegramError(500); } });
  clock.now = Date.now() + ALERT_FRESHNESS_MS + MIN; // alerts were recorded at real time
  state.pools = [];
  await cycle();
  assert.equal(state.sent.length, 0);
});

test('a rate-limited refresh stops for the cycle, and unfetched tokens keep their turn', async () => {
  const { state, cycle, clock } = world();
  state.pools = Array.from({ length: 90 }, (_, i) => launched(i + 1, START));
  await cycle({ maxRefreshRequests: 3 }); // launch enrichment uses all 3 requests
  clock.now = START + MIN;
  state.pools = [];
  state.refreshFails = true;
  state.refreshCalls.length = 0;
  await cycle({ maxRefreshRequests: 1 }); // budget: 30 of 90 tokens, and that request fails
  const failed = state.refreshCalls.flat();
  assert.equal(failed.length, 30);
  state.refreshFails = false;
  state.refreshCalls.length = 0;
  clock.now = START + 2 * MIN;
  await cycle({ maxRefreshRequests: 1 });
  // The same 30 are asked for again; they did not lose their turn to the other 60.
  assert.deepEqual(state.refreshCalls.flat().sort(), failed.sort());
});

test('the watch list rotates: least recently checked first, within the request budget', async () => {
  const { state, cycle, clock } = world();
  state.pools = Array.from({ length: 70 }, (_, i) => launched(i + 1, START));
  await cycle({ maxRefreshRequests: 3 }); // 70 new tokens: enrichment uses all 3 requests
  clock.now = START + MIN;
  state.pools = [];
  state.refreshCalls.length = 0;
  await cycle({ maxRefreshRequests: 2 }); // 60 of 70 refreshed
  const first = new Set(state.refreshCalls.flat());
  assert.equal(first.size, 60);
  clock.now = START + 2 * MIN;
  state.refreshCalls.length = 0;
  await cycle({ maxRefreshRequests: 2 });
  const second = state.refreshCalls.flat();
  // The 10 not refreshed last time come first now.
  const skipped = Array.from({ length: 70 }, (_, i) => token(i + 1)).filter((t) => !first.has(t));
  assert.deepEqual(second.slice(0, 10).sort(), skipped.sort());
});

test('a transient delivery failure is retried next cycle and delivered exactly once', async () => {
  const { state, cycle } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  const attempts = [];
  const flaky = async (message) => { attempts.push(message.chat_id); if (attempts.length === 1) throw new TelegramError(500); };
  await cycle({ send: flaky });
  await cycle({ send: flaky });
  await cycle({ send: flaky });
  assert.deepEqual(attempts, [42, 42]);
});

test('a permanently rejected alert turns that tester\'s scanning off', async () => {
  const { state, cycle, store } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  const logs = [];
  await cycle({ send: async () => { throw new TelegramError(403); }, log: { warn: (m) => logs.push(m) } });
  assert.equal(store.getAgent(42).scanning, false);
  assert.match(logs.at(-1), /scanning was turned off/);
  state.discoveryCalls = 0;
  await cycle();
  assert.equal(state.discoveryCalls, 0); // nobody scanning any more
});

test('delivery attempts are bounded', async () => {
  const { state, cycle, store } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  for (let i = 0; i < MAX_ALERT_ATTEMPTS + 3; i += 1) await cycle({ send: async () => { throw new TelegramError(500); } });
  assert.equal(store.pendingAlerts(iso(0)).length, 0);
});

test('a burst of alerts is paced between sends', async () => {
  const { state, cycle } = world({ testers: [42, 57] });
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  const paces = [];
  await cycle({ pace: async (ms) => { paces.push(ms); } });
  assert.equal(state.sent.length, 2);
  assert.deepEqual(paces, [1100]);
});

test('a discovery outage does not freeze the watch list: watched tokens are still re-checked', async () => {
  const { state, cycle, clock, store } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 2_000_000 }));
  await cycle();
  clock.now = START + 5 * MIN;
  state.data.set(token(1), dexscreener(1, clock.now, { marketCap: 250_000 }));
  await cycle({ discovery: async () => ({ ok: false, reason: 'RATE_LIMITED' }) });
  assert.equal(state.sent.length, 1);
  assert.deepEqual({ ok: store.getLastScan().ok, reason: store.getLastScan().reason, refreshed: store.getLastScan().refreshed },
    { ok: false, reason: 'RATE_LIMITED', refreshed: 1 });
});

test('a discovery outage is recorded for /scan status and scanning continues', async () => {
  const { state, cycle, store } = world();
  await cycle({ discovery: async () => ({ ok: false, reason: 'UNAVAILABLE' }) });
  assert.equal(store.getLastScan().ok, false);
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  await cycle();
  assert.equal(state.sent.length, 1);
  assert.equal(store.getLastScan().ok, true);
});

test('a rate-limited discovery source is paused with exponential backoff, then resumes', async () => {
  let clock = START;
  let calls = 0;
  let limited = true;
  const gated = withDiscoveryBackoff(async () => { calls += 1; return limited ? { ok: false, reason: 'RATE_LIMITED' } : { ok: true, pools: [] }; }, () => clock);
  const at = async (ms) => { clock = START + ms; return gated(); };
  await at(0);                                // 429: paused for 1 minute
  assert.deepEqual(await at(30_000), { ok: false, reason: 'RATE_LIMITED', paused: true });
  await at(61_000);                           // asks again, 429 again: paused for 2 minutes
  await at(150_000);                          // still paused
  assert.equal(calls, 2);
  limited = false;
  assert.equal((await at(182_000)).ok, true); // resumes
  await at(183_000);
  assert.equal(calls, 4);                     // no pause after a success
});

test('/scan off during a burst cancels the alerts not yet sent; they can match again later', async () => {
  const { state, cycle, store, clock } = world();
  state.pools = [launched(1, START), launched(2, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 40_000 }));
  state.data.set(token(2), dexscreener(2, START, { marketCap: 50_000 }));
  // The tester sends /scan off right after the first alert arrives.
  await cycle({ send: async (message) => { state.sent.push(message); store.setScanning(42, false); } });
  assert.equal(state.sent.length, 1);
  // Back on a minute later: the cancelled token still matches on the watch
  // list, so it alerts now; the delivered one never repeats.
  store.setScanning(42, true);
  clock.now = START + MIN;
  state.pools = [];
  await cycle();
  assert.equal(state.sent.length, 2);
  assert.notEqual(state.sent[0].text.match(/Token: (\S+)/)[1], state.sent[1].text.match(/Token: (\S+)/)[1]);
});

test('approving new criteria cancels alerts queued under the old version', async () => {
  const { state, cycle, store, clock } = world();
  state.pools = [launched(1, START)];
  state.data.set(token(1), dexscreener(1, START, { marketCap: 400_000 }));
  await cycle({ send: async () => { throw new TelegramError(500); } }); // matched v1 ($500k ceiling), delivery failed
  store.setDraft(42, { rules: [rule({ field: 'marketCapUsd', op: 'lte', value: 100_000, evidence: 'mcap under 100k' })], unresolved: [] });
  store.approveDraft(42); // v2 is stricter
  clock.now = START + MIN;
  state.pools = [];
  await cycle();
  assert.equal(state.sent.length, 0); // the v1 match is not sent under v2
  // A token that matches v2 later is alerted under v2.
  clock.now = START + 2 * MIN;
  state.data.set(token(1), dexscreener(1, clock.now, { marketCap: 90_000 }));
  await cycle();
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].text, /matches your criteria v2/);
});
