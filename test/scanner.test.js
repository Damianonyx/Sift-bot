import test from 'node:test';
import assert from 'node:assert/strict';
import { runScanCycle } from '../src/scanner.js';
import { MAX_ALERT_ATTEMPTS, openStore } from '../src/store.js';
import { TelegramError } from '../src/telegram.js';

const silent = { warn() {} };
const live = (value) => ({ value, source: 'live', asOf: '2026-11-17T08:00:00.000Z' });
const UNKNOWN = { value: null, source: 'unknown', asOf: '2026-11-17T08:00:00.000Z' };
const RULES = { rules: [{ field: 'liquidityUsd', op: 'gte', value: 1_000, severity: 'require', evidence: '1k liquidity' }], unresolved: [] };
const pool = (poolAddress, tokenAddress, liquidity) => ({
  poolAddress, tokenAddress, name: 'NEW / SOL', dexId: 'pump-fun',
  url: `https://www.geckoterminal.com/solana/pools/${poolAddress}`,
  metrics: { liquidityUsd: liquidity, volume1hUsd: live(5), txns1h: live(3), poolAgeMinutes: live(2), marketCapUsd: UNKNOWN, fdvUsd: UNKNOWN },
});
const P1 = 'Pool1111111111111111111111111111111111111111';
const T1 = 'Token111111111111111111111111111111111111111';
const P2 = 'Pool2222222222222222222222222222222222222222';
const T2 = 'Token222222222222222222222222222222222222222';

function setup({ approve = true, scanning = true } = {}) {
  const store = openStore(':memory:');
  if (approve) {
    store.setDraft(42, RULES);
    store.approveDraft(42);
    if (scanning) store.setScanning(42, true);
  }
  const sent = [];
  const send = async (message) => { sent.push(message); };
  return { store, sent, send };
}
const discoveryOf = (...pools) => {
  const calls = { count: 0 };
  const discovery = async () => { calls.count += 1; return { ok: true, pools, checkedAt: '2026-11-17T08:00:00.000Z' }; };
  return { discovery, calls };
};
const cycle = (deps) => runScanCycle({ log: silent, signal: new AbortController().signal, now: () => Date.parse('2026-11-17T08:00:00Z'), pace: async () => {}, ...deps });

test('a matching new pool alerts each scanning tester once, with evidence in the message', async () => {
  const { store, sent, send } = setup();
  const { discovery } = discoveryOf(pool(P1, T1, live(5_000)));
  await cycle({ discovery, store, send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 42);
  assert.match(sent[0].text, /Sift alert: a new pool matches your criteria v1/);
  assert.match(sent[0].text, new RegExp(`Token: ${T1}`));
  assert.match(sent[0].text, /✓ require selected-pool liquidity ≥ \$1,000 — \$5,000 \(live/);
  assert.match(sent[0].text, /most scams live: verify before acting/);
  // The same pool next cycle: seen, no second alert.
  await cycle({ discovery, store, send });
  assert.equal(sent.length, 1);
  assert.deepEqual(store.getLastScan(), { at: '2026-11-17T08:00:00.000Z', ok: true, pools: 1, newMatches: 0 });
});

test('failing or unknown verdicts never alert: unknown liquidity is not a match', async () => {
  const { store, sent, send } = setup();
  const { discovery } = discoveryOf(pool(P1, T1, live(500)), pool(P2, T2, UNKNOWN));
  await cycle({ discovery, store, send });
  assert.equal(sent.length, 0);
  assert.equal(store.getLastScan().newMatches, 0);
});

test('nobody scanning means the data source is not even contacted', async () => {
  const { store, send } = setup({ scanning: false });
  const { discovery, calls } = discoveryOf(pool(P1, T1, live(5_000)));
  await cycle({ discovery, store, send });
  assert.equal(calls.count, 0);
});

test('a transient delivery failure is retried next cycle and delivered exactly once', async () => {
  const { store, send: _unused } = setup();
  const attempts = [];
  const send = async (message) => { attempts.push(message.chat_id); if (attempts.length === 1) throw new TelegramError(500); };
  const { discovery } = discoveryOf(pool(P1, T1, live(5_000)));
  await cycle({ discovery, store, send }); // alert created, first delivery fails
  await cycle({ discovery, store, send }); // retried and delivered
  await cycle({ discovery, store, send }); // nothing left to deliver
  assert.deepEqual(attempts, [42, 42]);
});

test('a permanently rejected alert turns that tester\'s scanning off', async () => {
  const { store } = setup();
  const send = async () => { throw new TelegramError(403); };
  const { discovery, calls } = discoveryOf(pool(P1, T1, live(5_000)));
  const logs = [];
  await runScanCycle({ discovery, store, send, log: { warn: (m) => logs.push(m) }, signal: new AbortController().signal });
  assert.equal(store.getAgent(42).scanning, false);
  assert.equal(store.scanningAgents().length, 0);
  assert.match(logs.at(-1), /scanning was turned off/);
  // Next cycle: no scanners, so no fetch and no delivery attempts.
  await cycle({ discovery, store, send });
  assert.equal(calls.count, 1);
});

test('delivery attempts are bounded even if the counter is the only thing that survives', async () => {
  const { store } = setup();
  const send = async () => { throw new TelegramError(500); };
  const { discovery } = discoveryOf(pool(P1, T1, live(5_000)));
  for (let i = 0; i < MAX_ALERT_ATTEMPTS + 3; i += 1) await cycle({ discovery, store, send });
  // attempts capped: pendingAlerts excludes the exhausted alert.
  assert.equal(store.pendingAlerts().length, 0);
});

test('a burst of alerts is paced between sends so Telegram rate limits are respected', async () => {
  const { store, sent, send } = setup();
  store.setDraft(57, RULES); store.approveDraft(57); store.setScanning(57, true); // second tester
  const paces = [];
  const { discovery } = discoveryOf(pool(P1, T1, live(5_000)));
  await cycle({ discovery, store, send, pace: async (ms) => { paces.push(ms); } });
  assert.equal(sent.length, 2); // both testers alerted for the same new pool
  assert.deepEqual(paces, [1100]); // one gap between two sends, none before the first
});

test('a discovery outage is recorded for /scan status and scanning continues', async () => {
  const { store, sent, send } = setup();
  await cycle({ discovery: async () => ({ ok: false, reason: 'UNAVAILABLE' }), store, send });
  assert.deepEqual(store.getLastScan(), { at: '2026-11-17T08:00:00.000Z', ok: false });
  assert.equal(sent.length, 0);
  const { discovery } = discoveryOf(pool(P1, T1, live(5_000)));
  await cycle({ discovery, store, send });
  assert.equal(sent.length, 1);
});
