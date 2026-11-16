import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';

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
    assert.deepEqual(reopened.getAgent(42), { draft: null, approved: proposal, version: 1 });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
