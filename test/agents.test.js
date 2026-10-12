import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAgentStore, AgentStoreError } from '../src/agent-store.js';
import { createAgentSetup } from '../src/agent-setup.js';
import { evaluateRules, evaluateAgent, assertApprovable } from '../src/rules.js';
import { createResponder } from '../src/commands.js';
import { normalisePairs } from '../src/market.js';
import { runPolling } from '../src/polling.js';
import { TelegramError } from '../src/telegram.js';

const allowed = new Set([42, 57]);
let sequence = 0;
const input = (text, id = 42) => ({ update_id: ++sequence,
  message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });
const callback = (data, id = 42) => ({ update_id: ++sequence,
  callback_query: { id: 'callback-' + sequence, data, from: { id, is_bot: false },
    message: { chat: { id, type: 'private' } } } });
const buttons = (reply) => reply.reply_markup?.inline_keyboard.flat() ?? [];
const action = (reply, name) => buttons(reply).find((b) => b.text === name)?.callback_data;
const cap = { field: 'marketCap', mode: 'require', min: 30000, max: 50000 };
const agent = (rules = [cap]) => ({ name: 'Test agent', rules, pendingRequirements: [] });
const state = (approved = agent()) => ({ revision: 1, draft: null, approved });
const makeStore = (t) => {
  const store = openAgentStore({ memory: true });
  t.after(() => store.close());
  return store;
};
function draft(setup, id = 42, extra = 'none') {
  let reply;
  for (const text of ['/setup', 'Test agent', 'require 30k 50k', 'skip', 'skip', 'skip', extra]) {
    reply = setup(input(text, id), allowed);
  }
  return reply;
}

test('strict ranges include boundaries, unknown never uses FDV, warning unknown remains visible', () => {
  for (const marketCap of [30000, 40000, 50000]) assert.equal(evaluateRules([cap], { selected: { marketCap } }).matches, true);
  for (const marketCap of [29999, 50001, null, undefined, NaN, Infinity, '40000']) {
    assert.equal(evaluateRules([cap], { selected: { marketCap, fdv: 40000 } }).matches, false);
  }
  const result = evaluateRules([cap, { field: 'liquidityUsd', mode: 'warn', value: 10 }], { selected: { marketCap: 40000 } });
  assert.equal(result.matches, true);
  assert.equal(result.checks[1].state, 'unknown');
  assert.equal(evaluateRules([{ field: 'liquidityUsd', mode: 'require', value: 0 }], { selected: { liquidityUsd: 0 } }).matches, true);
});

test('pool age and activity use the stated measurement windows, future and missing timestamps are unknown', () => {
  const rules = [{ field: 'poolAgeMinutes', mode: 'require', value: 60 }, { field: 'volume1h', mode: 'require', value: 100 }];
  const snapshot = { fetchedAt: 7200000, selected: { createdAt: 3600000, windows: [{ window: 'm5', volume: 99999 }, { window: 'h1', volume: 100 }] } };
  assert.equal(evaluateRules(rules, snapshot).matches, true);
  snapshot.selected.windows = [{ window: 'm5', volume: 99999 }];
  assert.equal(evaluateRules(rules, snapshot).checks[1].state, 'unknown');
  for (const createdAt of [null, 7200001]) {
    snapshot.selected.createdAt = createdAt;
    assert.equal(evaluateRules(rules, snapshot).checks[0].state, 'unknown');
  }
});

test('approval rejects empty, warning-only, unsupported and unresolved strategies; extra checks block qualification', () => {
  for (const rules of [[], [{ ...cap, mode: 'warn' }], [{ field: 'bundleFree', mode: 'require', value: 1 }], [cap, cap], [{ ...cap, min: 60000 }]]) {
    assert.throws(() => assertApprovable(agent(rules)));
  }
  const unresolved = { ...agent(), pendingRequirements: ['Locked liquidity; developer still holding; check sales, coordinated buys and bundles.'] };
  assert.throws(() => assertApprovable(unresolved), /Approval blocked/);
  assert.equal(evaluateAgent(unresolved, { selected: { marketCap: 40000 } }).matches, false);
  assert.equal(evaluateAgent({ ...agent(), pendingRequirements: undefined }, { selected: { marketCap: 40000 } }).matches, false);
});

test('wizard does not invent thresholds or approve automatically; owner and revision checks protect approval', (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  const review = draft(setup);
  assert.equal(store.get(42).approved, null);
  assert.deepEqual(store.get(42).draft.rules, [cap]);
  const approve = action(review, 'Approve rules');
  assert.ok(approve);
  assert.match(setup(callback(approve, 57), allowed).callbackNotice, /does not belong/);
  assert.equal(store.get(42).approved, null);
  const approved = setup(callback(approve), allowed);
  assert.equal(approved.chat_id, 42);
  assert.deepEqual(store.get(42).approved, agent());
  assert.match(approved.callbackNotice, /Scanning is not connected/);
  assert.match(setup(callback(approve), allowed).callbackNotice, /out of date/);
  assert.equal(store.get(57).approved, null);
});

test('extra requirements cannot be skipped, forged into approval or silently erased by editing', (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  const instructions = 'Liquidity locked, developer still holding; report sales separately from transfers; no suspected bundles.';
  const review = draft(setup, 42, instructions);
  assert.equal(action(review, 'Approve rules'), undefined);
  assert.match(review.text, /Approval blocked/);
  const blocked = setup(callback(`agent:42:approve:${store.get(42).revision}`), allowed);
  assert.match(blocked.callbackNotice, /Approval blocked/);
  assert.equal(store.get(42).approved, null);
  setup(callback(action(review, 'Edit rules')), allowed);
  for (const text of ['Revised agent', 'require 30k 50k', 'skip', 'skip', 'skip']) setup(input(text), allowed);
  const before = store.get(42);
  setup(callback(`agent:42:skip:${before.revision}`), allowed);
  assert.deepEqual(store.get(42), before); // final extra-requirement review is mandatory
  const after = setup(input('none'), allowed);
  assert.deepEqual(store.get(42).draft.pendingRequirements, [instructions]);
  assert.equal(action(after, 'Approve rules'), undefined);
});

test('natural descriptions stay unresolved; restarting setup preserves a draft and cancelling preserves approved rules', (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  store.put(42, state());
  const text = 'Find $30k to $50k coins with locked liquidity, developer holdings and no suspicious buying.';
  const response = setup(input('/setup ' + text), allowed);
  assert.match(response.text, /not yet interpreted or checked/);
  assert.deepEqual(store.get(42).draft.pendingRequirements, [text]);
  assert.deepEqual(store.get(42).draft.rules, []); // no fake AI interpretation
  const before = store.get(42);
  setup(input('/setup'), allowed);
  assert.deepEqual(store.get(42), before);
  setup(input('/cancel'), allowed);
  assert.equal(store.get(42).draft, null);
  assert.deepEqual(store.get(42).approved, agent());
});

test('partial setup, approved rules, offset and retry receipts survive closing and reopening the database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sift-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = openAgentStore({ directory });
  let setup = createAgentSetup(store);
  store.put(57, state());
  setup(input('/setup'), allowed);
  const nameUpdate = input('Restart test');
  const reply = setup(nameUpdate, allowed);
  const saved = store.get(42);
  store.close();
  store = openAgentStore({ directory });
  setup = createAgentSetup(store);
  assert.deepEqual(store.get(42), saved);
  assert.deepEqual(store.get(57).approved, agent());
  assert.deepEqual(setup(nameUpdate, allowed), reply);
  assert.deepEqual(store.get(42), saved); // duplicate name must not answer the next question
  store.acknowledge(nameUpdate.update_id);
  store.close();
  store = openAgentStore({ directory });
  assert.equal(store.offset(), nameUpdate.update_id + 1);
  store.close();
});

test('state and receipt writes roll back together; corrupt data fails closed without exposing contents', (t) => {
  const store = makeStore(t);
  assert.throws(() => store.process(++sequence, () => { store.put(42, state()); throw new Error('PRIVATE_CONTENT'); }), AgentStoreError);
  assert.equal(store.get(42).approved, null);
  const directory = mkdtempSync(join(tmpdir(), 'sift-corrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const disk = openAgentStore({ directory });
  disk.close();
  const db = new DatabaseSync(join(directory, 'agents.sqlite'));
  db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?)').run(42, 1, null, '{"name":"PRIVATE_CONTENT"}');
  db.close();
  const corrupt = openAgentStore({ directory });
  assert.throws(() => corrupt.get(42), (e) => e instanceof AgentStoreError && !e.stack.includes('PRIVATE_CONTENT'));
  corrupt.close();
  writeFileSync(join(directory, 'agents.sqlite'), 'PRIVATE_CONTENT');
  assert.throws(() => openAgentStore({ directory }), AgentStoreError);
});

test('unlisted users, groups and callbacks for other users cannot read or change agent settings', (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  draft(setup);
  const before = store.get(42);
  assert.equal(setup(input('/agent', 99), allowed), null);
  const group = input('/setup'); group.message.chat.type = 'group';
  assert.equal(setup(group, allowed), null);
  const mismatched = input('/agent'); mismatched.message.chat.id = 57;
  assert.equal(setup(mismatched, allowed), null);
  assert.match(setup(callback('agent:42:approve:0', 99), allowed).callbackNotice, /private testing/);
  assert.deepEqual(store.get(42), before);
  const other = setup(input('/agent', 57), allowed);
  assert.doesNotMatch(other.text, /Test agent|30,000/);
});

// Synthetic market data: no network or live token facts are used below.
const CA = 'So11111111111111111111111111111111111111112';
function snapshot(overrides = {}) {
  return normalisePairs([{ chainId: 'solana', pairAddress: CA,
    baseToken: { address: CA, name: 'SYNTHETIC TEST', symbol: 'TEST' },
    marketCap: 40000, fdv: 40000, liquidity: { usd: 0 }, ...overrides,
  }], CA, 1800000000000);
}

test('manual checks use only approved rules; unavailable strict data cannot pass and another user sees no strategy', async (t) => {
  const store = makeStore(t);
  let data = snapshot({ marketCap: null });
  const respond = createResponder({ agents: store, market: { check: async () => data } });
  await respond(input('/setup'), allowed);
  assert.doesNotMatch((await respond(input('/check ' + CA), allowed)).text, /Your approved rules/);
  store.put(42, state());
  const reply = await respond(input('/check ' + CA), allowed);
  assert.match(reply.text, /UNKNOWN · Required · Market cap/);
  assert.doesNotMatch(reply.text, /Available data passes|No strategy has been applied/);
  const stranger = await respond(input('/check ' + CA, 57), allowed);
  assert.doesNotMatch(stranger.text, /Your approved rules|Test agent/);
  data = snapshot();
  assert.match((await respond(input('/check ' + CA), allowed)).text, /Available data passes/);
});

test('maximum guided review and four-rule market report fit one Telegram message', async (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  let review;
  for (const text of ['/setup', 'N'.repeat(32), 'require 0 1000000000000', 'warn 1000000000000', 'warn 1000000000000', 'warn 1000000000000', 'none']) review = setup(input(text), allowed);
  assert.ok(review.text.length <= 4096);
  setup(callback(action(review, 'Approve rules')), allowed);
  const huge = { usd: Number.MAX_VALUE };
  const data = snapshot({ baseToken: { address: CA, name: 'N'.repeat(64), symbol: 'S'.repeat(64) },
    marketCap: Number.MAX_VALUE, fdv: Number.MAX_VALUE, liquidity: huge,
    volume: { m5: Number.MAX_VALUE, h1: Number.MAX_VALUE, h24: Number.MAX_VALUE } });
  const respond = createResponder({ agents: store, market: { check: async () => data } });
  assert.ok((await respond(input('/check ' + CA), allowed)).text.length <= 4096);
  setup(input('/setup ' + 'A'.repeat(800)), allowed);
  const draftView = setup(input('/agent'), allowed);
  assert.ok(draftView.text.length <= 4096);
});

test('polling retries failed delivery without repeating setup mutations and persists offset after delivery', async (t) => {
  const store = makeStore(t);
  const respond = createResponder({ agents: store });
  const update = input('/setup');
  let polls = 0, sends = 0, waits = 0;
  const controller = new AbortController();
  const replies = [];
  const call = async (method, body) => {
    if (method === 'getUpdates') {
      polls++;
      assert.deepEqual(body.allowed_updates, ['message', 'callback_query']);
      if (polls === 3) { controller.abort(); return []; }
      assert.equal(body.offset, 0); // failed send was not acknowledged
      return [update];
    }
    if (method === 'sendMessage') {
      replies.push(body); sends++;
      if (sends === 1) throw new TelegramError(500);
      return {};
    }
    assert.fail('Unexpected call');
  };
  await runPolling({ call, respond, agents: store, allowedUserIds: allowed, signal: controller.signal,
    wait: async () => { waits++; }, log: { warn() {} } });
  assert.equal(waits, 1);
  assert.equal(store.get(42).revision, 1);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(store.offset(), update.update_id + 1);
});

test('expired callback acknowledgement does not discard the saved reply or send internal fields to Telegram', async (t) => {
  const store = makeStore(t);
  const setup = createAgentSetup(store);
  const update = callback(action(draft(setup), 'Approve rules'));
  const controller = new AbortController();
  let polls = 0, sends = 0;
  const call = async (method, body) => {
    if (method === 'getUpdates') {
      if (++polls === 2) { controller.abort(); return []; }
      return [update];
    }
    if (method === 'answerCallbackQuery') throw new TelegramError(400);
    if (method === 'sendMessage') {
      sends++;
      assert.equal(body.callbackQueryId, undefined);
      assert.equal(body.callbackNotice, undefined);
      assert.equal(body.chat_id, 42);
      return {};
    }
    assert.fail('Unexpected call');
  };
  await runPolling({ call, respond: createResponder({ agents: store }), agents: store,
    allowedUserIds: allowed, signal: controller.signal });
  assert.equal(sends, 1);
  assert.equal(store.offset(), update.update_id + 1);
  assert.deepEqual(store.get(42).approved, agent());
});
