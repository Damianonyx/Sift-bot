import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentStore} from '../src/agent-store.js';
import {createResponder} from '../src/commands.js';
import {createDiscoveryRunner} from '../src/discovery.js';
import {createSignalTracker,paperResult,followChanges} from '../src/signal-tracking.js';
import {criteriaKey} from '../src/discovery-store.js';
import {DEFAULT_PREFERENCES,quietNow} from '../src/intelligence-store.js';
import {createPositionQuotes,USDC,QUOTE_ORIGIN} from '../src/position-size.js';
import {createHolderData,formatHolders} from '../src/holders.js';
import {createSolanaRpc} from '../src/solana-rpc.js';
import {parseDescription} from '../src/description-data.js';
import {evaluateAgent} from '../src/rules.js';
import {signalCard,evidencePages,promotionLabel} from '../src/signal-report.js';
import {performanceSummary} from '../src/intelligence-commands.js';
import {CA,POOL,NOW,address} from './fixtures/risk.js';

const strategy={name:'Test scout',rules:[{field:'marketCap',mode:'require',min:20000,max:60000}],pendingRequirements:[]};
const snapshot=(overrides={})=>({address:CA,fetchedAt:NOW,poolCount:1,sourceUrl:'https://api.dexscreener.com/token-pairs/v1/solana/'+CA,
  selected:{address:POOL,marketCap:40000,fdv:null,liquidityUsd:30000,priceUsd:1,createdAt:NOW-60000,windows:[]},...overrides});
const feed={read:async()=>({fetchedAt:NOW,candidates:[{address:CA}],sourceUrl:'https://example.invalid'})};
let seq=900000;
const input=(text,user=42)=>({update_id:++seq,message:{text,from:{id:user,is_bot:false},chat:{id:user,type:'private'}}});
const callback=(data,user=42)=>({update_id:++seq,callback_query:{id:'cb'+seq,data,from:{id:user,is_bot:false},message:{chat:{id:user,type:'private'}}}});
function setup(t) {
  const agents=openAgentStore({memory:true});t.after(()=>agents.close());
  agents.put(42,{revision:1,approved:strategy,draft:null});agents.discoverySet(42,'active',criteriaKey(strategy));
  const allowedUserIds=new Set([42]),calls=[];
  const call=async(method,body)=>{calls.push({method,body});return {message_id:1};};
  return {agents,allowedUserIds,calls,call};
}
function record(s,time=NOW,snap=snapshot(),delivery='sent') {
  const event=s.agents.discoveryReserve(42,criteriaKey(strategy),snap.address,time,{text:'saved',snapshot:snap,strategy,evidence:['one','two']});
  s.agents.discoveryDelivery(42,event,delivery);
  return s.agents.signalForDelivery(42,42,event);
}

test('discovery sends compact evidence controls and atomically saves the immutable all-call record',async t=>{
  const s=setup(t),market={check:async()=>snapshot()};
  await createDiscoveryRunner({...s,market,feed,now:()=>NOW}).cycle();
  const row=s.agents.signalList(42)[0];assert.equal(row.delivery,'sent');assert.equal(row.snapshot.selected.priceUsd,1);
  const message=s.calls[0].body;assert.ok(message.reply_markup.inline_keyboard.flat().some(b=>b.text==='View evidence'));
  const respond=createResponder({agents:s.agents});
  const evidence=await respond(callback('evidence:42:1:0'),s.allowedUserIds);assert.match(evidence.text,/original observation/);assert.ok(evidence.text.length<=4096);
  const before=structuredClone(row);s.agents.discoveryDelivery(42,1,'dismissed');
  s.agents.preferencesPut(42,{...DEFAULT_PREFERENCES,feeBps:200},NOW+1000);
  assert.deepEqual(s.agents.signalGet(42,row.id),before);assert.equal(s.agents.signalCounts(42)[0].n,1);
  assert.match((await respond(callback('evidence:42:1:0',57),new Set([42,57]))).callbackNotice,/another tester/);
});

test('uncertain sends remain in the ledger and never enter paper performance or blind retry',async t=>{
  const s=setup(t),runner=createDiscoveryRunner({...s,market:{check:async()=>snapshot()},feed,now:()=>NOW,call:async()=>{throw Error('transport');}});
  await runner.cycle();await runner.cycle();
  assert.equal(s.agents.signalList(42).length,1);assert.equal(s.agents.signalList(42)[0].delivery,'uncertain');
  assert.equal(s.agents.signalDue(NOW+3600000).length,0);assert.match(performanceSummary(s.agents,42),/uncertain: 1/);
});

test('fixed horizons retain losses and missing observations; no retroactive price backfill',async t=>{
  const s=setup(t);record(s);let time=NOW+15*60000;
  const tracker=createSignalTracker({...s,now:()=>time,market:{check:async()=>snapshot({fetchedAt:time,selected:{...snapshot().selected,priceUsd:0.5}})}});
  await tracker.cycle();let outcomes=s.agents.signalOutcomes(1);assert.equal(outcomes[0].state,'observed');assert.equal(outcomes[0].data.grossPct,-50);assert.ok(outcomes[0].data.netPct<-50);
  time=NOW+2*3600000;await tracker.cycle();outcomes=s.agents.signalOutcomes(1);assert.equal(outcomes.find(o=>o.horizon===60).state,'missed');
  assert.equal(outcomes.find(o=>o.horizon===15).data.grossPct,-50);
  assert.match(performanceSummary(s.agents,42),/Paper wins 0\/1/);
});

test('unknown prices and a missing pinned pool are unavailable, never zero-return wins',async t=>{
  const s=setup(t);record(s);
  await createSignalTracker({...s,now:()=>NOW+900000,market:{check:async()=>snapshot({fetchedAt:NOW+900000,selected:null})}}).cycle();
  const o=s.agents.signalOutcomes(1)[0];assert.equal(o.state,'unavailable');assert.equal(o.data.netPct,undefined);
  assert.equal(paperResult(null,2,DEFAULT_PREFERENCES),null);assert.equal(paperResult(1,0,DEFAULT_PREFERENCES).netPct,-100);
});

test('follow-ups retain captured rules, report a rule break, and do not mislabel a liquidity fall',async t=>{
  const s=setup(t);s.agents.preferencesPut(42,{...DEFAULT_PREFERENCES,followHours:24},NOW);record(s);
  s.agents.put(42,{revision:2,draft:null,approved:{...strategy,rules:[{...strategy.rules[0],max:100000}]}});
  const time=NOW+60000,snap=snapshot({fetchedAt:time,selected:{...snapshot().selected,marketCap:90000,liquidityUsd:10000}});
  const tracker=createSignalTracker({...s,now:()=>time,market:{check:async()=>snap}});await tracker.cycle();await tracker.cycle();
  assert.match(s.calls[0].body.text,/FAIL/);assert.match(s.calls.map(c=>c.body.text).join('\n'),/no withdrawal or broken lock is proved/);
  assert.equal(s.calls.length,3);assert.ok(s.agents.signalEvents(42,1).length>=3);
});

test('access revocation and stopping during follow-up reads prevent a stale notification',async t=>{
  const s=setup(t);s.agents.preferencesPut(42,{...DEFAULT_PREFERENCES,followHours:24},NOW);record(s);
  await createSignalTracker({...s,now:()=>NOW+60000,market:{check:async()=>{s.allowedUserIds.clear();return snapshot({fetchedAt:NOW+60000});}}}).cycle();
  assert.equal(s.calls.length,0);
  s.allowedUserIds.add(42);await createSignalTracker({...s,now:()=>NOW+120000,market:{check:async()=>{s.agents.signalStop(42,1);return snapshot({fetchedAt:NOW+120000,selected:null});}}}).cycle();
  assert.equal(s.calls.length,0);
});

test('quiet hours wrap midnight, suppress discovery without changing rules, and validate input',async t=>{
  const s=setup(t),p={...DEFAULT_PREFERENCES,quietStart:22,quietEnd:7};
  assert.equal(quietNow(p,Date.UTC(2026,0,1,23)),true);assert.equal(quietNow(p,Date.UTC(2026,0,2,6)),true);assert.equal(quietNow(p,Date.UTC(2026,0,2,7)),false);
  const respond=createResponder({agents:s.agents});const original=s.agents.get(42);
  await respond(input('/preferences quiet 0 24'),s.allowedUserIds);assert.deepEqual(s.agents.preferences(42),DEFAULT_PREFERENCES);
  await respond(input('/preferences follow 24'),s.allowedUserIds);assert.equal(s.agents.preferences(42).followHours,24);assert.deepEqual(s.agents.get(42),original);
  const hour=new Date(NOW).getUTCHours();s.agents.preferencesPut(42,{...DEFAULT_PREFERENCES,quietStart:hour,quietEnd:(hour+1)%24},NOW);
  await createDiscoveryRunner({...s,now:()=>NOW,market:{check:async()=>snapshot()},feed}).cycle();assert.equal(s.calls.length,0);assert.equal(s.agents.discoveryGet(42).suppressed,1);
});

test('private sizing, feedback and history authenticate before requests and enforce ownership',async t=>{
  const s=setup(t),respond=createResponder({agents:s.agents,quotes:{check:()=>assert.fail('Unauthorized quote')}});
  await respond(input('/size '+CA+' 100',99),s.allowedUserIds);
  const row=record(s);assert.equal(s.agents.signalFeedback(99,row.id,5,'profit',NOW),false);
  const reply=await respond(input('/feedback 1 1 loss'),s.allowedUserIds);assert.match(reply.text,/unverified self-report/);
  assert.match(performanceSummary(s.agents,42),/loss: 1/);
  assert.match((await respond(input('/performance 1',57),new Set([42,57]))).text,/unavailable/);
});

function quoteFixture(input,output,amount) {return {success:true,data:{swapType:'BaseIn',inputMint:input,outputMint:output,inputAmount:amount,
  outputAmount:output===USDC?'95000000':'1000000',otherAmountThreshold:output===USDC?'94000000':'990000',slippageBps:100,
  routePlan:[{poolId:POOL,inputMint:input,outputMint:output,feeMint:input,feeAmount:'10'}]}};}
test('position sizing validates both quote directions without a wallet, build or send endpoint',async()=>{
  const calls=[],service=createPositionQuotes({now:()=>NOW,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(u.origin,QUOTE_ORIGIN);assert.equal(u.pathname,'/compute/swap-base-in');assert.equal(options.method,'GET');assert.equal(options.headers.authorization,undefined);
    return Response.json(quoteFixture(u.searchParams.get('inputMint'),u.searchParams.get('outputMint'),u.searchParams.get('amount')));
  }});
  const r=await service.check(CA,100);assert.equal(r.state,'quoted');assert.equal(r.roundTripUsdc,95);assert.ok(Math.abs(r.roundTripLossPct-5)<1e-9);assert.equal(calls.length,2);
  assert.equal((await service.check(CA,100)).state,'unavailable');assert.equal(calls.length,2);
});

test('wrong mints, amount, route, malformed output or unavailable exit cannot become a position quote',async()=>{
  for(const mutate of [q=>q.data.inputMint=CA,q=>q.data.inputAmount='1',q=>q.data.routePlan[0].inputMint=CA,q=>q.data.outputAmount='NaN',q=>q.success=false]) {
    const service=createPositionQuotes({now:()=>NOW,fetchImpl:async()=>{const q=quoteFixture(USDC,CA,'100000000');mutate(q);return Response.json(q);}});
    assert.equal((await service.check(CA,100)).state,'unavailable');
  }
});

test('finalized holder samples validate exact amounts and label accounts rather than insiders',async()=>{
  const rpc=createSolanaRpc({now:()=>NOW,fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);let result;
    if(body.method==='getTokenSupply')result={context:{slot:100},value:{amount:'1000',decimals:6}};
    else if(body.method==='getTokenLargestAccounts')result={context:{slot:100},value:[{address:POOL,amount:'100',decimals:6}]};
    else if(body.method==='getBlockTime')result=NOW/1000;else assert.fail('Unexpected RPC');
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  }});
  const value=await createHolderData({rpc,now:()=>NOW}).check(CA);assert.equal(value.state,'observed');assert.equal(value.topAccountPercent,10);
  assert.match(formatHolders(value,CA),/not unique people or wallets/);
  const invalid=createHolderData({rpc:{supply:async()=>({slot:100,amount:'100',decimals:6}),largest:async()=>({slot:100,accounts:[{amount:'101',decimals:6}]}),blockTime:async()=>NOW},now:()=>NOW});
  assert.equal((await invalid.check(CA)).state,'unknown');
});

test('explicit risk descriptions preserve all-pools scope, warning strength and unknown blocking',()=>{
  const text='market cap between 20k and 60k; require 100% all-pools liquidity protection with at least six months remaining or verified LP burns; the identified developer must still hold tokens; allow partial developer sales, but flag them; report transfers separately from sales; exclude confirmed coordinated buying or bundles; flag suspected cases; unknown required checks must not qualify';
  const parsed=parseDescription(text);assert.deepEqual(parsed.unresolved,[]);assert.equal(parsed.rules.length,4);assert.equal(parsed.rules[1].scope,'all');
  const risk={address:CA,pool:POOL,checkedAt:NOW,liquidityProtection:{state:'pass',kind:'burn',protectedPercent:100,observedAt:NOW,links:['proof']}};
  const result=evaluateAgent({...strategy,rules:parsed.rules},snapshot({risk}),{now:NOW});assert.equal(result.matches,false);assert.equal(result.checks[1].state,'unknown');
  const warning=parseDescription('market cap between 20k and 60k; warn exclude confirmed coordinated buying or bundles; flag suspected cases');
  assert.deepEqual(warning.unresolved,[]);assert.equal(warning.rules[1].mode,'warn');assert.equal(evaluateAgent({...strategy,rules:warning.rules},snapshot(),{now:NOW}).matches,true);
  assert.ok(parseDescription(text.replace('all-pools ','')).unresolved.length); // no silently chosen scope
});

test('unfamiliar risk requirements and conflicting descriptions remain unresolved',()=>{
  for(const text of ['require 90% selected-pool liquidity protection with six months remaining or verified LP burns',
    'developer must still hold tokens; never allow any developer sales',
    'market cap between 20k and 60k; exclude confirmed coordinated buying or bundles',
    'require 100% selected-pool liquidity protection with at least six months remaining or verified LP burns; no honeypots'])assert.ok(parseDescription(text).unresolved.length);
});

test('promotion and evidence reports retain unknowns and fit Telegram without altering ranking',()=>{
  assert.match(promotionLabel(snapshot()),/unknown/);assert.match(promotionLabel(snapshot({selected:{...snapshot().selected,activeBoosts:50}})),/not a ranking signal/);
  const pages=evidencePages(strategy,snapshot(),{sourceUrl:'https://example.invalid',fetchedAt:NOW},{address:CA});
  assert.ok(pages.length>=1);assert.ok(pages.every(p=>p.length<=3600));assert.ok(signalCard(strategy,snapshot(),{now:NOW}).length<2500);
});

test('ledger, preferences and rule audits survive reopening an existing SQLite database',t=>{
  const directory=mkdtempSync(join(tmpdir(),'sift-ledger-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let agents=openAgentStore({directory});agents.put(42,{revision:1,draft:null,approved:strategy});agents.discoverySet(42,'active',criteriaKey(strategy));
  const row=record({agents});agents.preferencesPut(42,{...DEFAULT_PREFERENCES,positionUsd:100},NOW);agents.close();
  agents=openAgentStore({directory});t.after(()=>agents.close());assert.equal(agents.signalGet(42,row.id).delivery,'sent');assert.equal(agents.preferences(42).positionUsd,100);assert.equal(agents.auditList(42).length,2);
});
