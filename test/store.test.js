import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

const proposal = { rules: [{ field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: '10k liquidity' }], unresolved: [] };

test('offset starts at zero and only persists safe positive integers', () => {
  const store = openStore(':memory:');
  assert.equal(store.getOffset(), 0);
  store.setOffset(7);
  assert.equal(store.getOffset(), 7);
  for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) store.setOffset(bad);
  assert.equal(store.getOffset(), 7);
  store.close();
});

test('draft lifecycle: propose, approve bumps the version, discard clears', () => {
  const store = openStore(':memory:');
  assert.equal(store.getAgent(42), null);
  assert.equal(store.approveDraft(42), null);
  assert.equal(store.clearDraft(42), false);

  store.setDraft(42, proposal);
  assert.deepEqual(store.getAgent(42).draft, proposal);
  assert.equal(store.getAgent(42).approved, null);

  const first = store.approveDraft(42);
  assert.deepEqual(first, { approved: proposal, version: 1 });
  assert.equal(store.getAgent(42).draft, null);
  assert.equal(store.approveDraft(42), null); // approving twice needs a new draft

  store.setDraft(42, { ...proposal, unresolved: ['dev must be clean'] });
  assert.equal(store.clearDraft(42), true); // discard keeps the approved set
  assert.deepEqual(store.getAgent(42).approved, proposal);
  assert.equal(store.getAgent(42).version, 1);

  store.setDraft(42, proposal);
  assert.equal(store.approveDraft(42).version, 2);
  assert.equal(store.getAgent(57), null); // other users unaffected
  store.close();
});

test('the alert ledger: one alert per tester and token, pending until sent, bounded attempts', () => {
  const store = openStore(':memory:');
  assert.equal(store.createAlert(42, 'TokenA', 'PoolA', 'alert text'), true);
  assert.equal(store.createAlert(42, 'TokenA', 'PoolB', 'same token, other pool'), false); // once per token
  assert.equal(store.createAlert(57, 'TokenA', 'PoolA', 'other tester'), true);
  // Pending alerts are only for testers whose scanning is on.
  assert.equal(store.pendingAlerts(EPOCH).length, 0);
  for (const id of [42, 57]) { store.setDraft(id, proposal); store.approveDraft(id); store.setScanning(id, true); }
  let pending = store.pendingAlerts(EPOCH);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].message, 'alert text');
  assert.equal(pending[0].token_address, 'TokenA');
  // Alerts created before the freshness cutoff are not pending any more.
  assert.equal(store.pendingAlerts(new Date(Date.now() + 60_000).toISOString()).length, 0);

  store.recordAttempt(pending[0].id);
  store.markSent(pending[0].id);
  assert.deepEqual(store.pendingAlerts(EPOCH).map((a) => a.user_id), [57]);
  store.setScanning(57, false);
  assert.equal(store.pendingAlerts(EPOCH).length, 0); // /scan off empties the queue
  store.setScanning(57, true);
  store.abandonAlert(pending[1].id);
  assert.equal(store.pendingAlerts(EPOCH).length, 0);

  store.markSeen('PoolA', '2026-11-17T08:00:00.000Z');
  assert.equal(store.wasSeen('PoolA'), true);
  store.pruneSeen('2026-11-18T00:00:00.000Z');
  assert.equal(store.wasSeen('PoolA'), false);
  store.close();
});

test('the watch list: added once per token, due oldest-checked first, expired by time', () => {
  const store = openStore(':memory:');
  const add = (token, lastChecked) => store.addCandidate({ tokenAddress: token, poolAddress: `pool-${token}`, name: token,
    dexId: 'pump-fun', discoveredAt: '2026-11-17T14:00:00.000Z', expiresAt: '2026-11-17T14:30:00.000Z', lastChecked });
  assert.equal(add('A', '2026-11-17T14:00:00.000Z'), true);
  assert.equal(add('A', null), false); // same token, second pool: one watch entry
  add('B', null);
  add('C', '2026-11-17T13:59:00.000Z');
  assert.deepEqual(store.dueCandidates('2026-11-17T14:01:00.000Z', 10).map((c) => c.tokenAddress), ['B', 'C', 'A']);
  assert.deepEqual(store.dueCandidates('2026-11-17T14:01:00.000Z', 2).map((c) => c.tokenAddress), ['B', 'C']);
  store.markChecked(['B'], '2026-11-17T14:02:00.000Z');
  assert.deepEqual(store.dueCandidates('2026-11-17T14:02:00.000Z', 1).map((c) => c.tokenAddress), ['C']);
  assert.equal(store.countCandidates(), 3);
  assert.deepEqual(store.dueCandidates('2026-11-17T14:30:00.000Z', 10), []); // expired: never due
  store.expireCandidates('2026-11-17T14:30:00.000Z');
  assert.equal(store.countCandidates(), 0);
  store.close();
});

test('transactions commit together or roll back together', () => {
  const store = openStore(':memory:');
  assert.throws(() => store.transaction(() => { store.markSeen('X', 'now'); throw new Error('boom'); }), /boom/);
  assert.equal(store.wasSeen('X'), false);
  store.transaction(() => store.markSeen('Y', 'now'));
  assert.equal(store.wasSeen('Y'), true);
  store.close();
});

test('criteria and the offset survive closing and reopening the database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sift-store-'));
  try {
    const store = openStore(dir);
    store.setOffset(123);
    store.setDraft(42, proposal);
    store.approveDraft(42);
    store.close();

    const reopened = openStore(dir);
    assert.equal(reopened.getOffset(), 123);
    assert.deepEqual(reopened.getAgent(42), { draft: null, approved: proposal, version: 1, scanning: false });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
