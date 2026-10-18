import test from 'node:test';
import assert from 'node:assert/strict';
import { readDiagnosticTarget, runLiveDiagnostic } from '../src/live-diagnostic.js';
import { normalisePairs } from '../src/market.js';
import { TelegramError } from '../src/telegram.js';

const NOW = 1800000000000;
const CA = '1'.repeat(31) + '2';
const OTHER = '1'.repeat(31) + '3';
const POOL = '1'.repeat(31) + '4';
const config = { TELEGRAM_BOT_TOKEN: '12345:synthetic_token_for_offline_tests', SIFT_ALLOWED_USER_IDS: '42,57' };
function setup({ events = true, indexed = true } = {}) {
  let time = NOW, closed = false;
  const pump = { tick() {}, status: () => ({ state: events ? 'receiving' : 'connected' }),
    read: async () => ({ health: pump.status(), candidates: events ? [{ address: CA }] : [] }), close: () => { closed = true; } };
  return { pump, gecko: { read: async () => ({ fetchedAt: time, candidates: [{ address: OTHER }], invalidPools: 0 }) },
    market: { check: async (address) => normalisePairs(indexed ? [{ chainId: 'solana', baseToken: { address }, pairAddress: POOL, marketCap: 40000 }] : [], address, time) },
    now: () => time, wait: async (ms) => { time += ms; }, signal: new AbortController().signal, closed: () => closed };
}

test('diagnostic uses actual event mints and market responses without claiming rule qualification or sending by default', async () => {
  const fixture = setup();
  const report = await runLiveDiagnostic(fixture);
  assert.equal(report.pumpToMarketVerified, true);
  assert.equal(report.approvedRuleMatchVerified, false);
  assert.equal(report.telegram.state, 'not_requested');
  assert.equal(report.market[0].address, CA);
  assert.equal(report.market[0].liquidityUsd, null);
  assert.equal(report.market[0].providerUpdateTime, 'unknown');
  assert.equal(fixture.closed(), true);
});

test('a socket without events and fresh launches without indexed pools remain incomplete', async () => {
  for (const options of [{ events: false }, { indexed: false }]) {
    const fixture = setup(options);
    const report = await runLiveDiagnostic(fixture);
    assert.equal(report.pumpToMarketVerified, false);
    assert.equal(fixture.closed(), true);
  }
});

test('observation includes events arriving after the original short window and is still bounded', async () => {
  const fixture = setup({ events: false });
  fixture.pump.status = () => ({ state: fixture.now() - NOW >= 15_000 ? 'receiving' : 'connected' });
  fixture.pump.read = async () => ({ health: fixture.pump.status(),
    candidates: fixture.now() - NOW >= 15_000 ? [{ address: CA }, { address: OTHER }] : [] });
  const report = await runLiveDiagnostic(fixture);
  assert.equal(report.pumpToMarketVerified, true);
  assert.equal(report.market.length, 2);
  assert.deepEqual(report.market[1].sources, ['pumpportal', 'geckoterminal']);
  assert.ok(fixture.now() - NOW < 30_000);
});

test('private delivery requires an explicit allowed positive user ID; read-only mode needs no token', () => {
  assert.equal(readDiagnosticTarget({}, undefined), null);
  for (const id of ['-100123', '99', '0', '42,57', '', '9007199254740993']) {
    assert.throws(() => readDiagnosticTarget(config, id));
  }
  assert.throws(() => readDiagnosticTarget({}, '42'));
  assert.equal(readDiagnosticTarget(config, '42').userId, 42);
});

test('private delivery verifies Sift identity and sends exactly one diagnostic without polling or group requests', async () => {
  const calls = [];
  const report = await runLiveDiagnostic({ ...setup(), telegram: { userId: 42, call: async (method, body) => {
    calls.push({ method, body });
    if (method === 'getMe') return { is_bot: true, username: 'SiftAgentbot' };
    assert.equal(body.chat_id, 42);
    assert.match(body.text, /DIAGNOSTIC ONLY/);
    assert.match(body.text, /no screening rules were evaluated/);
    assert.ok(body.text.includes(CA));
    assert.ok(body.text.length < 4096);
    return { message_id: 1, chat: { type: 'private', id: 42 } };
  } } });
  assert.deepEqual(calls.map((c) => c.method), ['getMe', 'sendMessage']);
  assert.equal(report.telegram.state, 'accepted_by_telegram');
  assert.equal(report.approvedRuleMatchVerified, false);
});

test('wrong bot and ambiguous send results never become verified delivery or trigger an automatic retry', async () => {
  for (const mode of ['wrong_bot', 'network', 'wrong_chat', 'rate_limit']) {
    let sends = 0;
    const report = await runLiveDiagnostic({ ...setup(), telegram: { userId: 42, call: async (method) => {
      if (method === 'getMe') return { is_bot: true, username: mode === 'wrong_bot' ? 'OtherBot' : 'SiftAgentbot' };
      sends++;
      if (mode === 'network') throw new Error('PRIVATE_TOKEN_DETAILS');
      if (mode === 'rate_limit') throw new TelegramError(429, 60);
      return { message_id: 1, chat: { id: -100, type: 'supergroup' } };
    } } });
    assert.equal(sends, mode === 'wrong_bot' ? 0 : 1);
    assert.equal(report.telegram.state, mode === 'wrong_bot' ? 'wrong_bot' : mode === 'rate_limit' ? 'failed' : 'uncertain');
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOKEN_DETAILS/);
  }
});

test('source errors and stale or wrong-mint snapshots are incomplete and do not leak provider text', async () => {
  const fixture = setup();
  fixture.gecko.read = async () => { throw new Error('PRIVATE_ERROR'); };
  fixture.market.check = async () => ({ address: OTHER, fetchedAt: NOW, selected: { address: POOL } });
  let report = await runLiveDiagnostic(fixture);
  assert.equal(report.pumpToMarketVerified, false);
  assert.equal(report.gecko.state, 'unavailable');
  assert.equal(report.market[0].state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ERROR/);
  const stale = setup();
  stale.market.check = async (address) => ({ address, fetchedAt: NOW - 120000, selected: { address: POOL } });
  report = await runLiveDiagnostic(stale);
  assert.equal(report.pumpToMarketVerified, false);
});

test('cancellation closes the stream and never sends a late private diagnostic', async () => {
  const fixture = setup();
  const stop = new AbortController(); stop.abort();
  const report = await runLiveDiagnostic({ ...fixture, signal: stop.signal,
    telegram: { userId: 42, call: async () => assert.fail('Cancelled check sent a request') } });
  assert.equal(report.deadlineReached, true);
  assert.equal(report.telegram.state, 'not_attempted_deadline');
  assert.equal(fixture.closed(), true);
});
