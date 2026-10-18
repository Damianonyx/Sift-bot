import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentStore } from '../src/agent-store.js';
import { createResponder } from '../src/commands.js';
import { createWatchRunner, watchDetails } from '../src/watch.js';
import { createWatchCommands } from '../src/watch-commands.js';
import { createMarketData, normalisePairs, MarketDataError } from '../src/market.js';
import { TelegramError } from '../src/telegram.js';
import { REVIEW_TTL, TOTAL_WATCH_LIMIT } from '../src/watch-store.js';
import { createDiscoveryRunner } from '../src/discovery.js';
import { DatabaseSync } from 'node:sqlite';
import { criteriaKey } from '../src/discovery-store.js';

// SYNTHETIC fixtures: no network calls, no claims about real tokens or pools.
const NOW = 1800000000000;
const key = (n) => '1'.repeat(31) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n];
const CA = key(1), POOL = key(20);
const allowed = new Set([42,57]);
const cap = { field: 'marketCap', mode: 'require', min: 20000, max: 60000 };
const approved = { name: 'SYNTHETIC', rules: [cap], pendingRequirements: [] };
let sequence = 90000;
const message = (text, id = 42) => ({ update_id: ++sequence, message: { text, from: { id, is_bot: false }, chat: { id, type: 'private' } } });
const callback = (data, id = 42) => ({ update_id: ++sequence, callback_query: { id: 'cb' + sequence, data, from: { id, is_bot: false }, message: { chat: { id, type: 'private' } } } });
const button = (reply, title) => reply.reply_markup.inline_keyboard.flat().find((b) => b.text === title).callback_data;
const rawPair = (usd = 1000, extra = {}) => ({ chainId: 'solana', pairAddress: POOL,
  baseToken: { address: CA, name: 'SYNTHETIC', symbol: 'TEST' }, liquidity: { usd }, marketCap: 40000,
  volume: { h1: 1000 }, pairCreatedAt: NOW - 60000, ...extra });
const snap = (usd = 1000, time = NOW, extra = {}) => normalisePairs([rawPair(usd, extra)], CA, time);
const config = (rules = []) => ({ dropPercent: 20, hours: 24, rules });
const noRequest = async () => assert.fail('Unexpected outbound request');
const storeFor = (t) => { const s = openAgentStore({ memory: true }); t.after(() => s.close()); return s; };
const start = (s, id = 42, rules = []) => {
  const row = s.watchCreate(id, CA, config(rules), NOW);
  return s.watchStart(id, row.id, 0, snap(), NOW);
};

test('fixed-pool adapter never falls back to a larger, quote-only or missing pool', async () => {
  const data = [rawPair(900), rawPair(5000, { pairAddress: key(21) })];
  assert.equal(normalisePairs(data, CA, NOW).selected.address, key(21));
  const pinned = normalisePairs(data, CA, NOW, POOL);
  assert.equal(pinned.selected.address, POOL);
  assert.equal(pinned.selection, 'pinned_pool');
  assert.equal(normalisePairs(data.slice(1), CA, NOW, POOL).selected, null);
  assert.equal(normalisePairs([rawPair(900, { baseToken: { address: key(3) }, quoteToken: { address: CA } })], CA, NOW, POOL).selected, null);
  const client = createMarketData({ now: () => NOW, fetchImpl: async () => Response.json(data) });
  assert.equal((await client.check(CA, { poolAddress: POOL })).selected.address, POOL);
  await assert.rejects(client.check(CA, { poolAddress: 'invalid' }), /INVALID_ADDRESS/);
});

test('monitor setup requires user thresholds and explicit review, preserving an unresolved discovery draft', async (t) => {
  const s = storeFor(t);
  const saved = { revision: 3, approved: null, draft: { ...approved, step: 6, pendingRequirements: ['100% locked for six months; dev holding; exclude confirmed bundles'] } };
  s.put(42, saved);
  const respond = createWatchCommands({ agents: s, market: { check: noRequest }, now: () => NOW });
  for (const args of ['', CA, CA + ' 0 24', CA + ' 101 24', CA + ' 20 0', CA + ' 20 169', CA + ' 20 1.5']) {
    assert.match((await respond(message('/watch ' + args), allowed)).text, /Send \/watch/);
  }
  const review = await respond(message(`/watch ${CA} 20% 24`), allowed);
  assert.match(review.text, /Review market monitoring/);
  assert.match(review.text, /does not approve your discovery draft/);
  assert.equal(s.watchActive().length, 0);
  assert.ok(button(review, 'Start market monitoring'));
  assert.deepEqual(s.get(42), saved);
  assert.equal(s.discoveryGet(42).state, 'stopped');
});

test('start fetches the actual baseline once and delivery retry replays receipt without mutation or requests', async (t) => {
  const s = storeFor(t); let requests = 0, time = NOW;
  const respond = createWatchCommands({ agents: s, market: { check: async () => { requests++; return snap(1500, time); } }, now: () => time });
  const request = message(`/watch ${CA} 20 24`);
  const review = await respond(request, allowed);
  assert.deepEqual(await respond(request, allowed), review);
  assert.equal(s.watchList(42).length, 1);
  time += 60000;
  const activation = callback(button(review, 'Start market monitoring'));
  const result = await respond(activation, allowed);
  assert.match(result.text, /\$1,500/);
  assert.equal(s.watchGet(42, 1).ends_at, time + 86400000);
  assert.deepEqual(await respond(activation, allowed), result);
  assert.equal(requests, 1);
  assert.equal(s.watchGet(42, 1).revision, 1);
});

test('unlisted users, groups, bots and stolen callbacks cannot fetch, start or read another user monitor', async (t) => {
  const s = storeFor(t), respond = createResponder({ agents: s, market: { check: noRequest }, now: () => NOW });
  const review = await respond(message(`/watch ${CA} 20 24`), allowed);
  const data = button(review, 'Start market monitoring');
  assert.equal((await respond(callback(data, 57), allowed)).chat_id, undefined);
  assert.equal((await respond(callback('watch:57:view:1:0', 57), allowed)).chat_id, undefined);
  assert.equal((await respond(callback(data), new Set())).chat_id, undefined);
  const group = callback(data); group.callback_query.message.chat.type = 'group';
  assert.equal(await respond(group, allowed), null);
  const bot = callback(data); bot.callback_query.from.is_bot = true;
  assert.equal(await respond(bot, allowed), null);
  const unlisted = await respond(message(`/watch ${CA} 20 24`, 99), allowed);
  assert.match(unlisted.text, /does not have tester access/);
  assert.equal(s.watchActive().length, 0);
});

test('unknown, zero, stale or future baselines and cancelled requests never start a monitor', async (t) => {
  const s = storeFor(t); let snapshot = snap(null), time = NOW;
  const respond = createWatchCommands({ agents: s, now: () => time, market: { check: async () => snapshot } });
  const review = await respond(message(`/watch ${CA} 20 24`), allowed);
  const data = button(review, 'Start market monitoring');
  for (const value of [snap(null), snap(0), snap(1000,NOW - 120001), snap(1000,NOW + 1), { ...snap(), selected: null }]) {
    snapshot = value;
    assert.match((await respond(callback(data), allowed)).text, /Monitoring has not started/);
  }
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await respond(callback(data), allowed, aborted.signal), null);
  assert.equal(s.watchActive().length, 0);
  time += REVIEW_TTL;
  assert.match((await respond(callback(data), allowed)).callbackNotice, /expired/);
});

test('a complete synthetic start-to-pinned-pool alert includes evidence, fires at the boundary and does not duplicate', async (t) => {
  const s = storeFor(t), sends = []; start(s);
  let time = NOW + 60000, usd = 801;
  const runner = createWatchRunner({ agents: s, allowedUserIds: allowed, now: () => time,
    market: { check: async (token, options) => { assert.equal(token, CA); assert.equal(options.poolAddress, POOL); return snap(usd,time); } },
    call: async (method, body) => { assert.equal(method, 'sendMessage'); sends.push(body); } });
  await runner.cycle(); assert.equal(sends.length, 0);
  usd = 800; await runner.cycle();
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /20.00%/);
  assert.match(sends[0].text, /does not prove liquidity removal, a developer sale/);
  assert.ok(sends[0].text.includes(CA) && sends[0].text.includes(POOL));
  assert.match(sends[0].text, /https:\/\/api.dexscreener.com/);
  assert.equal(sends[0].link_preview_options.is_disabled, true);
  assert.equal(sends[0].reply_markup.inline_keyboard[0][0].copy_text.text, CA);
  assert.deepEqual(sends[0].entities.map((e) => sends[0].text.slice(e.offset, e.offset + e.length)), [CA]);
  const respond = createResponder({ agents: s, market: { check: noRequest }, now: () => time });
  const saved = await respond(callback(`watch:42:event:${s.watchHistory(42)[0].id}:0`), allowed);
  assert.equal(saved.reply_markup.inline_keyboard[0][0].copy_text.text, CA);
  assert.deepEqual(saved.entities.map((e) => saved.text.slice(e.offset, e.offset + e.length)), [CA]);
  usd = 0; time += 60000; await runner.cycle();
  assert.equal(sends.length, 1);
  assert.equal(s.watchHistory(42)[0].state, 'sent');
  assert.equal(s.watchGet(42,1).baseline.selected.liquidityUsd, 1000);
});

test('pool disappearance, wrong identities, stale data and provider failure are unknown, never false drains', async (t) => {
  for (const result of [null, snap(null), { ...snap(0), selected: null }, snap(0,NOW - 180001), snap(0,NOW + 60001), snap(0,NOW,{pairAddress:key(21)}), { ...snap(0), address: key(2) }]) {
    const s = storeFor(t), sent = []; start(s);
    const runner = createWatchRunner({ agents: s, allowedUserIds: allowed, now: () => NOW + 60000,
      market: { check: async () => { if (result === null) throw new Error('private provider details'); return result; } }, call: async (_, body) => sent.push(body.text) });
    await runner.cycle(); await runner.cycle();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /UNKNOWN, not zero/);
    assert.doesNotMatch(sent[0], /USD liquidity fell|private provider details/);
    assert.ok(s.watchGet(42,1).issue);
  }
});

test('market rule failures and unknown values use captured rules and never replace cap with FDV', async (t) => {
  const s = storeFor(t); start(s,42,[cap]);
  const sent = []; let snapshot = snap(1000,NOW+60000,{marketCap:null,fdv:40000});
  s.put(42, { revision: 1, draft: null, approved: { ...approved, rules: [{...cap,max:1000000}] } });
  const runner = createWatchRunner({ agents:s, allowedUserIds:allowed, now:()=>NOW+60000,
    market:{check:async()=>snapshot},call:async(_,body)=>sent.push(body.text) });
  await runner.cycle(); assert.ok(sent.some((s)=>s.includes('UNKNOWN · Required')));
  assert.ok(sent.every((s)=>!s.includes('FDV')));
  snapshot = snap(1000,NOW+60000,{marketCap:70000}); await runner.cycle();
  assert.ok(sent.some((s)=>s.includes('FAIL · Required') && s.includes('$60,000')));
  assert.deepEqual(s.watchGet(42,1).config.rules,[cap]);
});

test('pause, stop, access removal or expiry during a pending source call prevent stale delivery', async (t) => {
  for (const action of ['pause','stop','revoke','expire']) {
    const s=storeFor(t), row=start(s), ids=new Set([42]); let time=NOW+60000;
    const runner=createWatchRunner({agents:s,allowedUserIds:ids,now:()=>time,call:noRequest,market:{check:async()=>{
      if(action==='revoke') ids.clear();
      else if(action==='expire') time=row.ends_at;
      else s.watchControl(42,row.id,row.revision,action,time);
      return snap(0,time);
    }}});
    await runner.cycle(); assert.equal(s.watchHistory(42).length,0);
  }
});

test('private controls are revision-bound; global pause/stop includes monitors without affecting other testers', async (t) => {
  const s=storeFor(t); start(s); start(s,57);
  const respond=createResponder({agents:s,feed:{},market:{check:noRequest},now:()=>NOW+60000});
  const old=callback('watch:42:pause:1:0'); assert.match((await respond(old,allowed)).callbackNotice,/old/);
  await respond(message('/pause'),allowed);
  assert.equal(s.watchGet(42,1).state,'paused'); assert.equal(s.watchGet(57,2).state,'active');
  assert.equal(s.watchGet(42,1).ends_at,NOW+86400000);
  const row=s.watchGet(42,1);
  await respond(callback(`watch:42:resume:1:${row.revision}`),allowed);
  assert.equal(s.watchGet(42,1).state,'active');
  const rev=s.watchGet(42,1).revision;
  const extended=callback(`watch:42:extend:1:${rev}`);
  const result=await respond(extended,allowed);
  assert.deepEqual(await respond(extended,allowed),result);
  assert.equal(s.watchGet(42,1).ends_at,NOW+2*86400000);
  await respond(message('/stop'),allowed);
  assert.equal(s.watchGet(42,1).state,'stopped'); assert.equal(s.watchGet(57,2).state,'active');
});

test('expiry sends one end notice without a source call, paused timers do not silently extend', async (t) => {
  const s=storeFor(t), row=start(s), sent=[];
  s.watchControl(42,1,row.revision,'pause',NOW);
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>row.ends_at,market:{check:noRequest},call:async(_,body)=>sent.push(body.text)});
  await runner.cycle(); await runner.cycle();
  assert.equal(sent.length,1); assert.match(sent[0],/Monitoring ended/);
  assert.equal(s.watchGet(42,1).state,'expired');
  assert.equal(s.watchControl(42,1,s.watchGet(42,1).revision,'extend',row.ends_at),null);
});

test('network ambiguity is retained without blind retries; reports and callbacks enforce ownership', async (t) => {
  const s=storeFor(t);start(s);let calls=0;
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,market:{check:async()=>snap(0,NOW+60000)},call:async()=>{calls++;throw new Error('sensitive network detail');}});
  await runner.cycle();await runner.cycle();assert.equal(calls,1);
  const report=s.watchHistory(42)[0];assert.equal(report.state,'uncertain');
  const respond=createWatchCommands({agents:s,market:{check:noRequest},now:()=>NOW+60000});
  assert.match((await respond(message('/watchalerts'),allowed)).text,/uncertain/);
  assert.equal((await respond(callback(`watch:57:event:${report.id}:0`,57),allowed)).chat_id,undefined);
  assert.match((await respond(callback(`watch:42:event:${report.id}:0`),allowed)).text,/Saved monitoring report/);
});

test('rate limits suppress later reports visibly, 403 pauses only that tester, fatal authorization stops runner', async (t) => {
  for (const code of [429,403,401]) {
    const s=storeFor(t);start(s);start(s,57);let calls=0;
    const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,market:{check:async()=>snap(0,NOW+60000)},call:async(_,body)=>{calls++;if(code!==403 || body.chat_id===42) throw new TelegramError(code,120);}});
    if(code===401) { await assert.rejects(runner.cycle(),TelegramError); continue; }
    await runner.cycle();
    assert.equal(s.watchHistory(42)[0].state,'failed');
    if(code===429) {assert.equal(calls,1);assert.equal(s.watchHistory(57)[0].state,'suppressed');}
    else {assert.equal(s.watchGet(42,1).state,'paused');assert.equal(s.watchGet(57,2).state,'active');}
  }
});

test('state, fixed baseline, uncertain reports and deduplication survive reopening the same database', async (t) => {
  const directory=mkdtempSync(join(tmpdir(),'sift-watch-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let s=openAgentStore({directory}), row=start(s);
  s.watchReserve(42,1,'liquidity_drop',NOW,'SYNTHETIC saved report');
  s.close();s=openAgentStore({directory});t.after(()=>s.close());
  assert.deepEqual(s.watchGet(42,1),row);
  const sent=[];
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+240000,market:{check:async()=>snap(0,NOW+240000)},call:async(_,body)=>sent.push(body.text)});
  await runner.cycle(); assert.equal(sent.length,1);assert.match(sent[0],/after a gap/);
  assert.equal(s.watchHistory(42).find((r)=>r.kind==='liquidity_drop').state,'pending');
  assert.equal(s.watchGet(42,1).baseline.selected.liquidityUsd,1000);
});

test('resource caps bound per-user and total open monitors, duplicate requests do not use capacity twice', (t) => {
  const s=storeFor(t);
  assert.ok(s.watchCreate(42,CA,config(),NOW));
  assert.equal(s.watchCreate(42,CA,config(),NOW),null);
  assert.ok(s.watchCreate(42,key(2),config(),NOW));assert.ok(s.watchCreate(42,key(3),config(),NOW));
  assert.equal(s.watchCreate(42,key(4),config(),NOW),null);
  for(let i=3;i<TOTAL_WATCH_LIMIT;i++) assert.ok(s.watchCreate(100+i,CA,config(),NOW));
  assert.equal(s.watchCreate(1000,CA,config(),NOW),null);
  assert.ok(s.watchCreate(1000,CA,config(),NOW+REVIEW_TTL));
});

test('three per-cycle monitoring delivery attempts are bounded and extra conditions remain saved', async (t) => {
  const s=storeFor(t);start(s,42,[cap,{field:'liquidityUsd',mode:'require',value:500},{field:'volume1h',mode:'warn',value:500},{field:'poolAgeMinutes',mode:'require',value:2}]);
  const sent=[],time=NOW+120000;
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>time,market:{check:async()=>snap(0,time,{marketCap:90000,volume:{h1:0}})},call:async(_,body)=>sent.push(body.text)});
  await runner.cycle();assert.equal(sent.length,3);assert.equal(s.watchHistory(42).filter((r)=>r.state==='suppressed').length,2);
  for(const text of sent) assert.ok(text.length<3900);
  assert.ok(watchDetails(s.watchGet(42,1),time).length<4096);
});

test('discovery report Monitor button opens setup for its actual CA and cannot cross users', async (t) => {
  const s=storeFor(t);s.put(42,{revision:1,draft:null,approved});s.discoverySet(42,'active',criteriaKey(approved));
  const sent=[];
  await createDiscoveryRunner({agents:s,allowedUserIds:allowed,now:()=>NOW,feed:{read:async()=>({candidates:[{address:CA}],fetchedAt:NOW,sourceUrl:'https://api.geckoterminal.com/api/v2/networks/solana/new_pools'})},market:{check:async()=>snap()},call:async(_,body)=>sent.push(body)}).cycle();
  const data=button(sent[0],'Monitor');
  const respond=createWatchCommands({agents:s,market:{check:noRequest},now:()=>NOW});
  assert.ok((await respond(callback(data),allowed)).text.includes(`/watch ${CA}`));
  assert.equal((await respond(callback(data,57),allowed)).chat_id,undefined);
  assert.equal(s.watchActive().length,0);
});

test('identical pool watches share a cycle response but private events and access remain separate', async (t) => {
  const s=storeFor(t);start(s);start(s,57);let requests=0;
  const sent=[];
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,
    market:{check:async()=>{requests++;return snap(0,NOW+60000);}},call:async(_,body)=>sent.push(body)});
  await runner.cycle();assert.equal(requests,1);assert.equal(sent.length,2);
  assert.deepEqual(sent.map((r)=>r.chat_id),[42,57]);
  assert.equal(s.watchEvent(57,s.watchHistory(42)[0].id),null);
  const removed=createWatchRunner({agents:s,allowedUserIds:new Set(),market:{check:noRequest},call:noRequest});
  await removed.cycle();
});

test('short market cooldown is respected, longer rate limiting becomes an unavailable observation', async (t) => {
  const s=storeFor(t);start(s);let requests=0,waited=0;
  const runner=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,wait:async(ms)=>{waited+=ms;},
    market:{check:async()=>{if(++requests===1) throw new MarketDataError('COOLDOWN',3);return snap(1000,NOW+60000);}},call:noRequest});
  await runner.cycle();assert.equal(requests,2);assert.equal(waited,3000);assert.equal(s.watchGet(42,1).issue,null);
  const sent=[];
  await createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,wait:noRequest,
    market:{check:async()=>{throw new MarketDataError('COOLDOWN',120);}},call:async(_,body)=>sent.push(body)}).cycle();
  assert.equal(sent.length,1);assert.match(sent[0].text,/UNKNOWN/);
});

test('background scheduler executes monitoring even with no active discovery, and cancellation stops both', async (t) => {
  const s=storeFor(t);start(s);const abort=new AbortController();let observed=0;
  const monitoring=createWatchRunner({agents:s,allowedUserIds:allowed,now:()=>NOW+60000,
    market:{check:async()=>{observed++;return snap(1000,NOW+60000);}},call:noRequest});
  const runner=createDiscoveryRunner({agents:s,allowedUserIds:allowed,market:{check:noRequest},feed:{read:noRequest},call:noRequest,
    wait:async()=>abort.abort()});
  await runner.run({signal:abort.signal,beforeCycle:monitoring.cycle});
  assert.equal(observed,1);
});

test('corrupt persisted baselines stop reads without replacing data or exposing stored contents', (t) => {
  const directory=mkdtempSync(join(tmpdir(),'sift-watch-corrupt-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const s=openAgentStore({directory});start(s);s.close();
  const raw=new DatabaseSync(join(directory,'agents.sqlite'));
  raw.prepare('UPDATE watches SET baseline=?').run(JSON.stringify({private:'NEVER_LOG_THIS'}));raw.close();
  const reopened=openAgentStore({directory});t.after(()=>reopened.close());
  assert.throws(()=>reopened.watchGet(42,1),(error)=>/Saved agent data/.test(error.message) && !error.message.includes('NEVER_LOG_THIS'));
});
