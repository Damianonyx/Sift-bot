import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolanaRpc, RPC_URL, SolanaRpcError } from '../src/solana-rpc.js';
import { RAYDIUM_V4, TOKEN_PROGRAM, publicKeyBytes, publicKeyString, decodeRaydiumPool, observeLpAccounts, LiquidityEvidenceError } from '../src/raydium-liquidity.js';
import { createLiquidityData, formatLiquidityReport } from '../src/liquidity.js';
import { createResponder } from '../src/commands.js';
import { openAgentStore } from '../src/agent-store.js';

// Deliberately synthetic binary fixtures. These are not findings about real
// pools and never leave the test process. Byte offsets follow documented layouts.
const NOW = 1800000000000;
const address = (n) => publicKeyString(Buffer.alloc(32, n));
const CA = address(1), QUOTE = address(2), POOL = address(3), LP = address(4), BASE_VAULT = address(5), QUOTE_VAULT = address(6);
const AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const account = (bytes, owner) => ({ owner, executable: false, data: [bytes.toString('base64'), 'base64'] });
function fixture(supply = 0n) {
  const pool = Buffer.alloc(752); pool.writeBigUInt64LE(6n, 0); pool.writeBigUInt64LE(254n, 8);
  for (const [key, offset] of [[BASE_VAULT,336],[QUOTE_VAULT,368],[CA,400],[QUOTE,432],[LP,464]]) publicKeyBytes(key).copy(pool, offset);
  pool.writeBigUInt64LE(10_000_000_000n, 720);
  const mint = Buffer.alloc(82); mint.writeUInt32LE(1, 0); publicKeyBytes(AUTHORITY).copy(mint, 4);
  mint.writeBigUInt64LE(supply, 36); mint[44] = 9; mint[45] = 1;
  const vault = (key) => {
    const bytes = Buffer.alloc(165); publicKeyBytes(key).copy(bytes, 0); publicKeyBytes(AUTHORITY).copy(bytes, 32);
    bytes.writeBigUInt64LE(100_000_000n, 64); bytes[108] = 1;
    return bytes;
  };
  const bytes = [pool, mint, vault(CA), vault(QUOTE)];
  return { bytes, accounts: () => bytes.map((data, i) => account(data, i ? TOKEN_PROGRAM : RAYDIUM_V4)) };
}
const marketSnapshot = () => ({ address: CA, selected: { address: POOL }, poolCount: 2, selection: 'reported_liquidity', fetchedAt: NOW });
const stubRpc = (f = fixture(), time = NOW - 5000) => ({
  accounts: async (keys) => ({ slot: 1234, accounts: keys.length === 1 ? [f.accounts()[0]] : f.accounts() }),
  blockTime: async () => time,
});
const update = (text, id = 42) => ({ update_id: 100, message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });
const noRequest = async () => assert.fail('Unexpected outbound request');

test('public-key and Raydium decoding retain exact 32-byte keys and the known authority', () => {
  assert.equal(publicKeyString(Buffer.alloc(32)), '11111111111111111111111111111111');
  assert.equal(publicKeyBytes('11111111111111111111111111111111').length, 32);
  assert.equal(publicKeyString(publicKeyBytes(RAYDIUM_V4)), RAYDIUM_V4);
  assert.throws(() => publicKeyBytes('not an address'), LiquidityEvidenceError);
  const pool = decodeRaydiumPool(fixture().accounts()[0], CA);
  assert.equal(pool.authority, AUTHORITY);
  assert.equal(pool.lpMint, LP); assert.equal(pool.baseVault, BASE_VAULT); assert.equal(pool.quoteVault, QUOTE_VAULT);
  assert.equal(decodeRaydiumPool(fixture().accounts()[0], QUOTE).quoteMint, QUOTE);
});

test('zero and nonzero LP supplies remain observations, never invented burn percentages or strict passes', () => {
  for (const supply of [0n, 1n, 1_234_000_000n]) {
    const accounts = fixture(supply).accounts();
    const result = observeLpAccounts(decodeRaydiumPool(accounts[0], CA), accounts.slice(1));
    assert.equal(result.outstandingLp, supply.toString());
    assert.equal(result.noOutstandingLp, supply === 0n);
    assert.equal(result.protectionRequirement, 'unknown');
    assert.equal(result.burnHistory, 'unknown');
    assert.equal(result.timedLocks, 'unknown');
  }
});

test('pool layout, owner, token linkage, initialization and executable mismatches fail closed', () => {
  for (const mutate of [
    (f) => { f.bytes[0] = Buffer.alloc(751); },
    (f) => f.bytes[0].writeBigUInt64LE(0n, 0),
    (f) => f.bytes[0].writeBigUInt64LE(256n, 8),
    (f) => f.bytes[0].writeBigUInt64LE(0n, 720),
    (f) => publicKeyBytes(LP).copy(f.bytes[0], 336),
  ]) { const f = fixture(); mutate(f); assert.throws(() => decodeRaydiumPool(f.accounts()[0], CA), LiquidityEvidenceError); }
  const pool = fixture().accounts()[0];
  assert.throws(() => decodeRaydiumPool({ ...pool, owner: TOKEN_PROGRAM }, CA), /UNSUPPORTED_POOL/);
  assert.throws(() => decodeRaydiumPool({ ...pool, executable: true }, CA), /ACCOUNT_OWNER/);
  assert.throws(() => decodeRaydiumPool(pool, address(7)), /TOKEN_POOL_MISMATCH/);
  assert.throws(() => decodeRaydiumPool(null, CA), /MISSING_ACCOUNT/);
  assert.throws(() => decodeRaydiumPool({ ...pool, data: [pool.data[0] + '\n', 'base64'] }, CA), /ACCOUNT_LAYOUT/);
});

test('wrong LP mint or vault authority, frozen accounts and supply inconsistencies never qualify', () => {
  for (const mutate of [
    (f) => { f.bytes[1][45] = 0; },
    (f) => f.bytes[1].writeUInt32LE(0, 0),
    (f) => f.bytes[1].writeUInt32LE(1, 46),
    (f) => publicKeyBytes(CA).copy(f.bytes[1], 4),
    (f) => f.bytes[1].writeBigUInt64LE(10_000_000_001n, 36),
    (f) => publicKeyBytes(CA).copy(f.bytes[2], 32),
    (f) => { f.bytes[2][108] = 2; },
    (f) => f.bytes[2].writeUInt32LE(1, 72),
    (f) => f.bytes[2].writeUInt32LE(1, 129),
    (f) => f.bytes[3].writeBigUInt64LE(0n, 64),
  ]) {
    const f = fixture(); mutate(f); const accounts = f.accounts();
    assert.throws(() => observeLpAccounts(decodeRaydiumPool(accounts[0], CA), accounts.slice(1)), LiquidityEvidenceError);
  }
  const accounts = fixture().accounts(); accounts[1].owner = address(12);
  assert.throws(() => observeLpAccounts(decodeRaydiumPool(accounts[0], CA), accounts.slice(1)), /ACCOUNT_OWNER/);
});

test('RPC uses fixed anonymous read-only requests and rejects malformed or mismatched envelopes', async () => {
  const requests = [];
  const rpc = createSolanaRpc({ fetchImpl: async (url, options) => {
    assert.equal(url, RPC_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'content-type': 'application/json' });
    const body = JSON.parse(options.body); requests.push(body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'getBlockTime' ? NOW / 1000 : { context: { slot: 1234 }, value: [fixture().accounts()[0]] } });
  } });
  await rpc.accounts([POOL], { minContextSlot: 1200 }); await rpc.blockTime(1234);
  assert.deepEqual(requests[0].params, [[POOL], { encoding: 'base64', commitment: 'finalized', minContextSlot: 1200 }]);
  assert.equal(requests[1].method, 'getBlockTime');
  for (const payload of [{ jsonrpc: '2.0', id: 99, result: null }, { jsonrpc: '2.0', id: 1, error: { message: 'PRIVATE_DETAILS' } }, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } }]) {
    const bad = createSolanaRpc({ fetchImpl: async () => Response.json(payload) });
    await assert.rejects(bad.accounts([POOL]), (error) => error instanceof SolanaRpcError && !error.stack.includes('PRIVATE_DETAILS'));
  }
  await assert.rejects(createSolanaRpc({ fetchImpl: noRequest }).accounts(['bad']), /INVALID_REQUEST/);
  await assert.rejects(createSolanaRpc({ fetchImpl: noRequest }).accounts(Array(5).fill(POOL)), /INVALID_REQUEST/);
});

test('RPC rate limits, oversized responses, errors and cancelled reads never appear as protection', async () => {
  let calls = 0;
  const rpc = createSolanaRpc({ now: () => NOW, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } });
  await assert.rejects(rpc.accounts([POOL]), (e) => e.code === 'RATE_LIMITED' && e.retryAfter === 120);
  await assert.rejects(rpc.accounts([POOL]), /RATE_LIMITED/); assert.equal(calls, 1);
  for (const response of [new Response('{'), new Response('x'.repeat(256 * 1024 + 1)), new Response('', { status: 403 })]) {
    await assert.rejects(createSolanaRpc({ fetchImpl: async () => response }).accounts([POOL]), SolanaRpcError);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createSolanaRpc({ fetchImpl: noRequest }).accounts([POOL], { signal: controller.signal }), /STOPPED/);
  await assert.rejects(createSolanaRpc({ fetchImpl: async () => { throw new Error('PRIVATE_URL'); } }).accounts([POOL]), (e) => !e.stack.includes('PRIVATE_URL'));
});

test('linked pool, LP mint and vaults are read together at a non-regressing finalized slot', async () => {
  const f = fixture(); const calls = [];
  const rpc = { accounts: async (keys, options) => {
    calls.push({ keys, options }); return { slot: calls.length === 1 ? 1200 : 1234, accounts: calls.length === 1 ? [f.accounts()[0]] : f.accounts() };
  }, blockTime: async (slot) => { assert.equal(slot, 1234); return NOW - 5000; } };
  const result = await createLiquidityData({ rpc, now: () => NOW }).check(marketSnapshot());
  assert.deepEqual(calls[1].keys, [POOL, LP, BASE_VAULT, QUOTE_VAULT]);
  assert.equal(calls[1].options.minContextSlot, 1200);
  assert.equal(result.slot, 1234); assert.equal(result.freshness, 'recent');
  assert.equal(result.observation.noOutstandingLp, true); assert.equal(result.protectionRequirement, 'unknown');
});

test('changed account links, missing accounts and unsupported programs produce explicit unknown evidence', async () => {
  const f = fixture(); let calls = 0;
  const changed = createLiquidityData({ now: () => NOW, rpc: { accounts: async () => {
    if (++calls === 1) return { slot: 1, accounts: [f.accounts()[0]] };
    publicKeyBytes(address(8)).copy(f.bytes[0], 464); return { slot: 2, accounts: f.accounts() };
  }, blockTime: noRequest } });
  assert.equal((await changed.check(marketSnapshot())).reason, 'POOL_CHANGED');
  for (const [value, code] of [[null, 'MISSING_ACCOUNT'], [{ ...fixture().accounts()[0], owner: address(7) }, 'UNSUPPORTED_POOL']]) {
    const result = await createLiquidityData({ rpc: { accounts: async () => ({ slot: 1, accounts: [value] }), blockTime: noRequest } }).check(marketSnapshot());
    assert.equal(result.reason, code); assert.equal(result.observation, null); assert.equal(result.protectionRequirement, 'unknown');
  }
});

test('unknown, stale and future block times remain visible even when the RPC read succeeds', async () => {
  for (const [time, freshness] of [[null,'unknown'], [NOW - 121000,'stale'], [NOW + 31000,'future'], [NOW - 120000,'recent']]) {
    const result = await createLiquidityData({ rpc: stubRpc(fixture(), time), now: () => NOW }).check(marketSnapshot());
    assert.equal(result.freshness, freshness); assert.equal(result.protectionRequirement, 'unknown');
    assert.ok(formatLiquidityReport(result).includes('Snapshot freshness: ' + freshness));
  }
  const rpc = stubRpc(); rpc.blockTime = async () => { throw new SolanaRpcError('SOURCE_UNAVAILABLE'); };
  const reader = createLiquidityData({ rpc, now: () => NOW });
  assert.equal((await reader.check(marketSnapshot())).freshness, 'unknown'); assert.equal(reader.status().state, 'unavailable');
});

test('RPC slot regression and malformed account data are rejected before decoding', async () => {
  for (const result of [
    { context: { slot: 99 }, value: fixture().accounts().slice(0,1) },
    { context: { slot: 101 }, value: [{ owner: RAYDIUM_V4, executable: false, data: ['x','jsonParsed'] }] },
    { context: { slot: 101 }, value: [null, null] },
  ]) {
    const rpc = createSolanaRpc({ fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 1, result }) });
    await assert.rejects(rpc.accounts([POOL], { minContextSlot: 100 }), /INVALID_RESPONSE/);
  }
});

test('evidence checks bound repeat traffic and do not call RPC when no market pool exists', async () => {
  const reader = createLiquidityData({ rpc: stubRpc(), now: () => NOW });
  await reader.check(marketSnapshot()); await assert.rejects(reader.check(marketSnapshot()), /COOLDOWN/);
  const none = createLiquidityData({ rpc: { accounts: noRequest } });
  assert.equal((await none.check({ ...marketSnapshot(), selected: null })).reason, 'NO_POOL');
  const limited = createLiquidityData({ now: () => NOW, rpc: { accounts: async () => { throw new SolanaRpcError('RATE_LIMITED', 120); } } });
  await assert.rejects(limited.check(marketSnapshot()), /RATE_LIMITED/);
  await assert.rejects(limited.check(marketSnapshot()), (e) => e.retryAfter === 120);
});

test('private command checks actual account evidence but preserves the full unresolved draft and stopped scan', async (t) => {
  const agents = openAgentStore({ memory: true }); t.after(() => agents.close());
  const saved = { revision: 1, approved: null, draft: { name: 'SYNTHETIC TEST', rules: [], step: 6,
    pendingRequirements: ['Require 100% protected liquidity with six months remaining; developer holding; exclude confirmed bundles.'] } };
  agents.put(42, saved);
  const respond = createResponder({ agents, market: { check: async () => marketSnapshot() },
    liquidity: createLiquidityData({ rpc: stubRpc(), now: () => NOW }) });
  const reply = await respond(update('/liquidity ' + CA), new Set([42]));
  assert.match(reply.text, /zero outstanding supply/); assert.match(reply.text, /Overall liquidity protection: UNKNOWN/);
  assert.ok(reply.text.includes('https://solscan.io/account/' + LP)); assert.equal(reply.link_preview_options.is_disabled, true);
  assert.deepEqual(agents.get(42), saved); assert.equal(agents.discoveryGet(42).state, 'stopped');
});

test('invalid input, unlisted users and groups cannot request liquidity data; aborts suppress replies', async () => {
  const respond = createResponder({ market: { check: noRequest }, liquidity: { check: noRequest } });
  const allowed = new Set([42]);
  assert.match((await respond(update('/liquidity invalid'), allowed)).text, /Send \/liquidity/);
  assert.match((await respond(update('/liquidity ' + CA, 57), allowed)).text, /does not have tester access/);
  const group = update('/liquidity ' + CA); group.message.chat.type = 'group';
  assert.equal(await respond(group, allowed), null);
  const controller = new AbortController(); const rpc = stubRpc(); rpc.accounts = async () => { controller.abort(); throw new SolanaRpcError('STOPPED'); };
  const aborting = createResponder({ market: { check: async () => marketSnapshot() }, liquidity: createLiquidityData({ rpc }) });
  assert.equal(await aborting(update('/liquidity ' + CA), allowed, controller.signal), null);
});

test('maximum liquidity report fits Telegram and does not label supply gaps as burn percentages', async () => {
  const result = await createLiquidityData({ rpc: stubRpc(fixture(123456789n)), now: () => NOW }).check(marketSnapshot());
  const text = formatLiquidityReport(result);
  assert.ok(text.length < 4096); assert.match(text, /0\.123456789/);
  assert.match(text, /Burn history: unknown/); assert.match(text, /Unlock time \/ six months remaining: unknown/);
  assert.doesNotMatch(text, /(?:^|\n)PASS\b|100% burned|verified lock: yes/);
});

test('the complete synthetic RPC transport to Telegram report path reads three times and keeps exact large supplies', async () => {
  const f = fixture(9007199254740993n); f.bytes[0].writeBigUInt64LE(18446744073709551615n, 720);
  let calls = 0;
  const rpc = createSolanaRpc({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); calls++;
    const result = body.method === 'getBlockTime' ? NOW / 1000 - 5 : {
      context: { slot: calls === 1 ? 1233 : 1234 }, value: calls === 1 ? [f.accounts()[0]] : f.accounts(),
    };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const respond = createResponder({ market: { check: async () => marketSnapshot() }, liquidity: createLiquidityData({ rpc, now: () => NOW }) });
  const reply = await respond(update('/liquidity ' + CA), new Set([42]));
  assert.equal(calls, 3); assert.equal(reply.chat_id, 42);
  assert.match(reply.text, /9007199\.254740993/); assert.match(reply.text, /finalized slot 1234/);
  assert.match(reply.text, /Snapshot freshness: recent/); assert.match(reply.text, /liquidity protection: UNKNOWN/);
});

test('in-flight evidence checks do not multiply RPC traffic and cancellation after response produces no stale success', async () => {
  let release, calls = 0;
  const f = fixture();
  const reader = createLiquidityData({ now: () => NOW, rpc: {
    accounts: async () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : { slot: 1, accounts: f.accounts() },
    blockTime: async () => NOW,
  } });
  const pending = reader.check(marketSnapshot());
  await assert.rejects(reader.check(marketSnapshot()), /COOLDOWN/); assert.equal(calls, 1);
  release({ slot: 1, accounts: [f.accounts()[0]] }); await pending; assert.equal(calls, 2);
  const controller = new AbortController();
  const rpc = createSolanaRpc({ fetchImpl: async () => { controller.abort(); return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [f.accounts()[0]] } }); } });
  await assert.rejects(rpc.accounts([POOL], { signal: controller.signal }), /STOPPED/);
});
