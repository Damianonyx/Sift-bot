import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentStore } from '../src/agent-store.js';
import { DEFAULT_PREFERENCES } from '../src/intelligence-store.js';
import { createSignalTracker, paperResult } from '../src/signal-tracking.js';
import { replayRecordedCalls, replayRecordedCall, CallReplayError } from '../src/call-replay.js';
import { CA, POOL, NOW } from './fixtures/risk.js';

const strategy={name:'Frozen rules',rules:[{field:'marketCap',mode:'require',min:20000,max:60000}],pendingRequirements:[]};
const snap=(time=NOW,price=1)=>({address:CA,fetchedAt:time,selected:{address:POOL,priceUsd:price,marketCap:40000,liquidityUsd:30000}});
function setup(t,{disk=false,follow=0}={}) {
  const directory=disk?mkdtempSync(join(tmpdir(),'sift-replay-')):undefined;
  const agents=openAgentStore(disk?{directory}:{memory:true});
  t.after(()=>{agents.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  agents.preferencesPut(42,{...DEFAULT_PREFERENCES,followHours:follow},NOW);
  let id=0;
  return {agents,directory,allowedUserIds:new Set([42]),call:async()=>assert.fail('Unexpected Telegram message'),
    record(delivery='sent',user=42,time=NOW){const result=agents.signalRecord(user,user,++id,snap(time),strategy,time);if(delivery!=='pending')agents.signalDelivery(result,delivery);return result;}};
}

test('paper-only tracking uses no requests between horizons and records downtime without backfill requests',async t=>{
  const s=setup(t);s.record();let time=NOW+60000,requests=0;
  const tracker=createSignalTracker({...s,now:()=>time,market:{check:async()=>{requests++;return snap(time,0.5);}}});
  await tracker.cycle();assert.equal(requests,0);
  time=NOW+15*60000;await tracker.cycle();assert.equal(requests,1);
  time+=60000;await tracker.cycle();assert.equal(requests,1);
  time=NOW+2*3600000;await tracker.cycle();assert.equal(requests,1);
  assert.equal(s.agents.signalOutcomes(1).find(o=>o.horizon===60).state,'missed');
  time=NOW+6*3600000;await tracker.cycle();assert.equal(requests,2);
  time=NOW+25*3600000;await tracker.cycle();assert.equal(requests,2);
  assert.equal(s.agents.signalOutcomes(1).length,4);assert.deepEqual(s.agents.signalDue(time),[]);
});

test('pre-horizon fetches and snapshots aged by risk checks never become observed horizon prices',async t=>{
  for(const elapsed of [2000,121000]) {
    const s=setup(t,{follow:24});s.record();let time=NOW+15*60000-1000;
    const tracker=createSignalTracker({...s,call:async()=>({message_id:1}),now:()=>time,
      market:{check:async()=>snap(time,2)},risk:{check:async()=>{time+=elapsed;return null;}}});
    await tracker.cycle();const outcome=s.agents.signalOutcomes(1)[0];
    assert.equal(outcome.state,'unavailable');assert.equal(outcome.data.netPct,undefined);
    if(elapsed===2000)assert.match(outcome.data.reason,/before this horizon/);
    else assert.match(s.agents.signalGet(42,1).issue,/became stale/);
  }
});

test('one pool failure is shared per cycle, and nonsent or revoked calls use no source requests',async t=>{
  const s=setup(t);s.record();s.record();s.record('failed');s.record('uncertain');s.record('sent',57);
  let requests=0;
  await createSignalTracker({...s,now:()=>NOW+15*60000,market:{check:async()=>{requests++;throw Error('outage');}}}).cycle();
  assert.equal(requests,1);assert.equal(s.agents.signalOutcomes(1)[0].state,'unavailable');assert.equal(s.agents.signalOutcomes(2)[0].state,'unavailable');
  for(const id of [3,4,5])assert.deepEqual(s.agents.signalOutcomes(id),[]);
});

test('offline replay preserves all deliveries, frozen rules and costs, losses and absent observations across pages',t=>{
  const s=setup(t,{disk:true});for(const state of ['sent','failed','uncertain','pending'])s.record(state);s.record('sent',57);
  const due=NOW+15*60000;
  s.agents.signalOutcome(1,15,'observed',due,{price:0.5,fetchedAt:due,providerTime:null});
  s.agents.signalOutcome(1,60,'unavailable',NOW+3600000,{reason:'Market unavailable'});
  s.agents.signalOutcome(1,360,'missed',NOW+7*3600000,{reason:'Downtime'});
  s.agents.preferencesPut(42,{...DEFAULT_PREFERENCES,feeBps:1000,slippageBps:1000},NOW+1000);
  const before=s.agents.signalGet(42,1);
  const first=replayRecordedCalls({directory:s.directory,userId:42,now:NOW+25*3600000,limit:2});
  assert.deepEqual(first.calls.map(c=>c.delivery),['sent','failed']);assert.equal(first.page.hasMore,true);
  assert.equal(first.calls[0].costs.feeBps,30);assert.deepEqual(first.calls[0].strategy,strategy);
  assert.equal(first.calls[0].horizons[0].paper.grossPct,-50);assert.ok(first.calls[0].horizons[0].paper.netPct<-50);
  assert.deepEqual(first.calls[0].horizons.map(o=>o.state),['observed','unavailable','missed','unrecorded']);
  assert.equal(first.calls[1].horizons[0].state,'not_tracked');assert.equal(first.networkRequests,0);assert.equal(first.telegramMessagesSent,0);
  const next=replayRecordedCalls({directory:s.directory,userId:42,after:first.page.nextAfter,now:NOW+25*3600000,limit:2});
  assert.deepEqual(next.calls.map(c=>c.delivery),['uncertain','pending']);assert.equal(next.page.hasMore,false);
  assert.equal(first.totals.reduce((n,r)=>n+r.count,0),4);assert.deepEqual(s.agents.signalGet(42,1),before);
  assert.equal(replayRecordedCalls({directory:s.directory,userId:99}).calls.length,0);
});

test('replay rejects fabricated timing, invalid costs and missing databases without creating a store',t=>{
  const s=setup(t);s.record();const row=s.agents.signalGet(42,1),due=NOW+15*60000;
  for(const fetchedAt of [due-1,due+300001,undefined]) {
    const result=replayRecordedCall(row,[{horizon:15,state:'observed',at:due+300000,data:{price:2,fetchedAt}}],{now:due+300000});
    assert.equal(result.horizons[0].state,'invalid_observation');assert.equal(result.horizons[0].paper,null);
  }
  assert.equal(paperResult(1,2,{feeBps:-1,slippageBps:0}),null);assert.equal(paperResult(1,2,{feeBps:0.1,slippageBps:0}),null);
  const missing=join(tmpdir(),'sift-replay-missing-'+process.pid);
  assert.throws(()=>replayRecordedCalls({directory:missing,userId:42}),CallReplayError);assert.equal(existsSync(missing),false);
  assert.throws(()=>replayRecordedCalls({userId:0}),CallReplayError);
});
