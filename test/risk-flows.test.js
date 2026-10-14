import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentStore } from '../src/agent-store.js';
import { createAgentSetup } from '../src/agent-setup.js';
import { createResponder } from '../src/commands.js';
import { createDiscoveryRunner } from '../src/discovery.js';
import { criteriaKey } from '../src/discovery-store.js';
import { normalisePairs } from '../src/market.js';
import { TEST_RISK_RULES, createRiskData } from '../src/risk.js';
import { evaluateRules } from '../src/rules.js';
import { NOW, CA, POOL, DEV, LP, snapshot, address } from './fixtures/risk.js';
const allowed=new Set([42,57]);let sequence=50000;
const input=(text,id=42)=>({update_id:++sequence,message:{text,from:{id,is_bot:false},chat:{id,type:'private'}}});
const cb=(data,id=42)=>({update_id:++sequence,callback_query:{id:'cb'+sequence,data,from:{id,is_bot:false},message:{chat:{id,type:'private'}}}});
const action=(reply,label)=>reply.reply_markup?.inline_keyboard.flat().find(b=>b.text===label)?.callback_data;
const cap={field:'marketCap',mode:'require',min:20000,max:60000};
const storeFor=t=>{const s=openAgentStore({memory:true});t.after(()=>s.close());return s;};
const noRequest=async()=>assert.fail('Unexpected outbound request');
const agent=()=>({name:'Synthetic',rules:[cap,...TEST_RISK_RULES],pendingRequirements:[]});
const risk=()=>({address:CA,pool:POOL,checkedAt:NOW,liquidityProtection:{state:'pass',kind:'burn',protectedPercent:100,observedAt:NOW,links:['https://solscan.io/tx/synthetic'],reason:'Synthetic burn'},developerHolding:{state:'pass',wallet:DEV,amount:'1',observedAt:NOW,links:['https://solscan.io/account/'+DEV],reason:'Synthetic holding'},buyingCoordination:{state:'unknown',links:[],reason:'Incomplete bundle coverage'},events:[],warnings:[],history:'Synthetic bounded sample'});

test('guided risk option is explicit, reviewable and does not start discovery',t=>{
  const store=storeFor(t),setup=createAgentSetup(store);let reply;
  for(const text of ['/setup','Synthetic','require 20k 60k','skip','skip','skip','risk'])reply=setup(input(text),allowed);
  assert.deepEqual(store.get(42).draft.rules,[cap,...TEST_RISK_RULES]);assert.equal(store.get(42).approved,null);
  assert.match(reply.text,/100%/);assert.match(reply.text,/six UTC calendar months/);assert.match(reply.text,/Partial|partial/);assert.match(reply.text,/unknown.*blocks/);
  const approve=action(reply,'Approve rules');assert.ok(approve);setup(cb(approve),allowed);
  assert.equal(store.discoveryGet(42).state,'stopped');assert.deepEqual(store.get(42).approved.rules,[cap,...TEST_RISK_RULES]);
  setup(cb(action(setup(input('/agent'),allowed),'Edit rules')),allowed);
  for(const text of ['Edited','require 20k 60k','skip','skip','skip','none'])setup(input(text),allowed);
  assert.equal(store.get(42).draft.rules.filter(r=>r.policy).length,3); // Editing cannot silently drop required risk rules.
});

test('saved unresolved instructions survive risk reads and require explicit owner revision-bound replacement plus approval',async t=>{
  const store=storeFor(t);const saved={revision:2,approved:null,draft:{name:'Original',rules:[cap],pendingRequirements:['Protect everything and keep all extra requirements'],step:6}};store.put(42,saved);
  const respond=createResponder({agents:store,market:{check:async()=>snapshot()},risk:{check:async()=>risk()},liquidity:{check:async()=>({address:CA,pool:null,fetchedAt:NOW,marketFetchedAt:NOW,slot:null,protectionRequirement:'unknown'}),status:()=>({state:'not_checked',checkedAt:null})}});
  await respond(input('/risk '+CA),allowed);await respond(input('/liquidity '+CA),allowed);assert.deepEqual(store.get(42),saved);
  const review=await respond(input('/riskrules'),allowed);assert.deepEqual(store.get(42),saved);assert.match(review.text,/Protect everything/);
  const use=action(review,'Use this risk policy in draft');assert.ok(use);
  assert.match((await respond(cb(use,57),allowed)).callbackNotice,/does not belong/);assert.deepEqual(store.get(42),saved);
  const draft=await respond(cb(use),allowed);assert.equal(store.get(42).approved,null);assert.equal(store.discoveryGet(42).state,'stopped');
  assert.deepEqual(store.get(42).draft.rules,[cap,...TEST_RISK_RULES]);assert.deepEqual(store.get(42).draft.pendingRequirements,[]);
  assert.match((await respond(cb(use),allowed)).callbackNotice,/out of date/);
  await respond(cb(action(draft,'Approve rules')),allowed);assert.deepEqual(store.get(42).approved.rules,[cap,...TEST_RISK_RULES]);assert.equal(store.discoveryGet(42).state,'stopped');
});

test('risk keyword never clears an earlier natural-language instruction implicitly',t=>{
  const store=storeFor(t),setup=createAgentSetup(store);
  let reply=setup(input('/setup Require a separate condition'),allowed);
  setup(cb(action(reply,'Edit rules')),allowed);
  for(const text of ['Synthetic','require 20k 60k','skip','skip','skip','risk'])reply=setup(input(text),allowed);
  assert.deepEqual(store.get(42).draft.pendingRequirements,['Require a separate condition']);assert.equal(action(reply,'Approve rules'),undefined);
});

test('unlisted users, groups, bots and commands for another bot cannot fetch risk data or change rules',async t=>{
  const store=storeFor(t),respond=createResponder({agents:store,market:{check:noRequest},risk:{check:noRequest}});
  assert.match((await respond(input('/risk '+CA,99),allowed)).text,/does not have tester access/);
  const group=input('/risk '+CA);group.message.chat.type='group';assert.equal(await respond(group,allowed),null);
  const bot=input('/risk '+CA);bot.message.from.is_bot=true;assert.equal(await respond(bot,allowed),null);
  assert.equal(await respond(input('/risk@OtherBot '+CA),allowed),null);
  assert.match((await respond(input('/risk bad'),allowed)).text,/full Solana/);
  assert.equal(store.get(42).draft,null);
});

test('full seven-rule /check report fits Telegram and never reports incomplete coverage as a match',async t=>{
  const store=storeFor(t);const rules=[cap,{field:'liquidityUsd',mode:'require',value:30000},{field:'volume1h',mode:'require',value:60000},{field:'poolAgeMinutes',mode:'require',value:20},...TEST_RISK_RULES];
  store.put(42,{revision:1,draft:null,approved:{...agent(),rules,name:'N'.repeat(32)}});
  const market=normalisePairs([{chainId:'solana',pairAddress:POOL,dexId:'d'.repeat(40),baseToken:{address:CA,name:'N'.repeat(200),symbol:'S'.repeat(30)},quoteToken:{symbol:'SOL'},marketCap:40000,fdv:50000,priceUsd:'0.01',liquidity:{usd:40000},volume:{m5:10000,h1:80000,h24:90000},txns:{m5:{buys:100,sells:100},h1:{buys:100,sells:100},h24:{buys:100,sells:100}},pairCreatedAt:NOW-60000}],CA,NOW);
  const respond=createResponder({agents:store,market:{check:async()=>market},risk:{check:async()=>risk()}});
  const reply=await respond(input('/check '+CA),allowed);
  assert.match(reply.text,/not all satisfied/);assert.match(reply.text,/UNKNOWN.*Bundles|UNKNOWN.*Exclude confirmed/);
  assert.ok(reply.text.length<=4096,`Report length ${reply.text.length}`);
  const detail=await respond(input('/risk '+CA),allowed);assert.ok(detail.text.length<4000);assert.match(detail.text,/https:\/\/solscan/);
});

test('discovery persists unknown risk outcomes, rechecks approval after evidence and makes no false alerts',async t=>{
  const store=storeFor(t),approved=agent();store.put(42,{revision:1,draft:null,approved});store.discoverySet(42,'active',criteriaKey(approved));
  let checks=0;
  const feed={read:async()=>({candidates:[{address:CA}],invalidPools:0,sourceUrl:'https://example.invalid',fetchedAt:NOW})};
  const runner=createDiscoveryRunner({agents:store,market:{check:async()=>snapshot()},risk:{check:async()=>{checks++;return risk();}},feed,call:noRequest,allowedUserIds:allowed,now:()=>NOW});
  await runner.cycle();assert.equal(checks,1);assert.equal(store.discoveryGet(42).matched,0);assert.equal(store.discoveryGet(42).issue,'RISK_UNKNOWN');assert.equal(store.discoveryHistory(42).length,0);
  const stopped=createDiscoveryRunner({agents:store,market:{check:async()=>snapshot()},risk:{check:async()=>{store.discoverySet(42,'paused',criteriaKey(approved));return risk();}},feed,call:noRequest,allowedUserIds:allowed,now:()=>NOW});
  await stopped.cycle();assert.equal(store.discoveryGet(42).state,'paused');assert.equal(store.discoveryHistory(42).length,0);
});

test('missing risk service, source errors and a provider claiming bundle-free all fail closed',async t=>{
  const store=storeFor(t),approved=agent(),feed={read:async()=>({candidates:[{address:CA}],invalidPools:0})};
  for(const source of [undefined,{check:async()=>{throw Error('PRIVATE_ERROR');}},{check:async()=>({...risk(),buyingCoordination:{state:'pass',observedAt:NOW,links:['synthetic']}})}]){
    store.put(42,{revision:1,draft:null,approved});store.discoverySet(42,'active',criteriaKey(approved));
    await createDiscoveryRunner({agents:store,market:{check:async()=>snapshot()},risk:source,feed,call:noRequest,allowedUserIds:allowed,now:()=>NOW}).cycle();
    assert.equal(store.discoveryGet(42).matched,0);assert.equal(store.discoveryHistory(42).length,0);
  }
});

test('RPC evidence work is skipped when required market criteria already fail',async t=>{
  const store=storeFor(t),approved=agent();store.put(42,{revision:1,draft:null,approved});store.discoverySet(42,'active',criteriaKey(approved));
  const s=snapshot();s.selected.marketCap=1;
  await createDiscoveryRunner({agents:store,market:{check:async()=>s},risk:{check:noRequest},feed:{read:async()=>({candidates:[{address:CA}],invalidPools:0})},call:noRequest,allowedUserIds:allowed,now:()=>NOW}).cycle();
  assert.equal(store.discoveryGet(42).matched,0);
});

test('elapsed lock duration is rechecked at evaluation and stale underlying evidence cannot qualify',()=>{
  const s={...snapshot(),risk:risk()};s.risk.liquidityProtection={...s.risk.liquidityProtection,kind:'lock',unlockAt:Date.UTC(2027,3,14,12)};
  assert.equal(evaluateRules([TEST_RISK_RULES[0]],s,{now:NOW}).matches,true);
  assert.equal(evaluateRules([TEST_RISK_RULES[0]],s,{now:NOW+1}).matches,false);
  s.risk.liquidityProtection.kind='burn';s.risk.liquidityProtection.observedAt=NOW-120001;
  assert.equal(evaluateRules([TEST_RISK_RULES[0]],s,{now:NOW}).matches,false);
});

test('risk service source failures never expose raw errors or pass required checks',async()=>{
  const error=async()=>{throw Error('PRIVATE_DETAILS');};
  const service=createRiskData({rpc:{signatures:error},liquidity:{check:error},now:()=>NOW});
  const result=await service.check(snapshot());assert.ok(['liquidityProtection','developerHolding','buyingCoordination'].every(f=>result[f].state==='unknown'));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DETAILS/);
});
