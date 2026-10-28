import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentStore } from '../src/agent-store.js';
import { createGroups } from '../src/groups.js';
import { createDiscoveryRunner } from '../src/discovery.js';
import { criteriaKey } from '../src/discovery-store.js';
import { TelegramError } from '../src/telegram.js';
import { normalisePairs } from '../src/market.js';
import { TEST_RISK_RULES } from '../src/risk.js';
import { CA, NOW, snapshot, address } from './fixtures/risk.js';
import { sixMonthsAfter } from '../src/evidence-utils.js';
let sequence=80000;
const approved={name:'Group scout',rules:[{field:'marketCap',mode:'require',min:20000,max:60000}],pendingRequirements:[]};
const key=criteriaKey(approved), chat=-100123, botId=12345;
const marketSnapshot=(token=CA)=>normalisePairs([{chainId:'solana',pairAddress:snapshot().selected.address,
  baseToken:{address:token},marketCap:40000,liquidity:{usd:40000}}],token,NOW);
const message=(text,owner=42,group=chat)=>({update_id:++sequence,message:{text,from:{id:owner,is_bot:false},chat:{id:group,type:group<0?'supergroup':'private'}}});
const callback=(data,owner=42)=>({update_id:++sequence,callback_query:{id:'cb'+sequence,data,from:{id:owner,is_bot:false},message:{chat:{id:owner,type:'private'}}}});
const action=(r,label)=>r.reply_markup.inline_keyboard.flat().find(b=>b.text.startsWith(label)).callback_data;
function setup(t,{directory}={}) {
  const agents=openAgentStore(directory?{directory}:{memory:true});t.after(()=>agents.close());
  agents.put(42,{revision:1,approved,draft:null});agents.discoverySet(42,'active',key);
  const allowedUserIds=new Set([42,57]), calls=[];
  let time=NOW, ownerAdmin=true, botAdmin=true, error=null, beforeMember=null;
  const call=async(method,body)=>{
    calls.push({method,body});
    if(method==='getChatMember') {
      await beforeMember?.(body);
      return {status:(body.user_id===botId?botAdmin:ownerAdmin)?'administrator':'member',user:{id:body.user_id,is_bot:body.user_id===botId}};
    }
    if(error)throw error;
    return {message_id:1};
  };
  const groups=createGroups({agents,call,botId,allowedUserIds,now:()=>time});
  return {agents,groups,calls,allowedUserIds,call,setTime:v=>time=v,setAdmin:v=>ownerAdmin=v,setBot:v=>botAdmin=v,setError:v=>error=v,setBefore:v=>beforeMember=v};
}
async function enable(s) {
  await s.groups.respond(message('/group@SiftAgentbot connect'));
  const list=await s.groups.respond(message('/groups',42,42));
  const review=await s.groups.respond(callback(action(list,'Review')));
  const update=callback(action(review,'Enable'));
  await s.groups.respond(update);return update;
}

test('adding a group does nothing; admin connects then explicitly approves private disclosure',async t=>{
  const s=setup(t);
  assert.equal(await s.groups.respond(message('hello')),null);assert.equal(s.calls.length,0);
  const staged=await s.groups.respond(message('/group@SiftAgentbot connect'));
  assert.match(staged.text,/Nothing is posting/);assert.doesNotMatch(staged.text,/20,000|Group scout/);
  assert.equal(s.agents.groupGet(chat).state,'review');
  const list=await s.groups.respond(message('/groups',42,42));
  const review=await s.groups.respond(callback(action(list,'Review')));
  assert.match(review.text,/everyone in that group/);assert.match(review.text,/20,000/);
  const activate=callback(action(review,'Enable'));await s.groups.respond(activate);await s.groups.respond(activate);
  assert.equal(s.agents.groupGet(chat).state,'active');
  assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
});

test('a separately approved group strategy scans independently and keeps private edits out of group evidence',async t=>{
  const s=setup(t);await enable(s);
  const proposed=await s.groups.respond(message('/groupstrategy '+chat,42,42));
  assert.equal(s.agents.groupGet(chat).state,'review');
  await s.groups.respond(callback(action(proposed,'Enable')));
  s.agents.discoverySet(42,'stopped',key);
  s.agents.put(42,{revision:2,draft:null,approved:{name:'PRIVATE NEW NAME',rules:[{field:'marketCap',mode:'require',min:1,max:2}],pendingRequirements:[]}});
  assert.equal(s.agents.groupGet(chat).state,'active');assert.equal(s.groups.targets().length,1);
  const runner=createDiscoveryRunner({agents:s.agents,groups:s.groups,allowedUserIds:s.allowedUserIds,call:s.call,now:()=>NOW,
    market:{check:async()=>normalisePairs([{chainId:'solana',pairAddress:snapshot().selected.address,baseToken:{address:CA},marketCap:40000,liquidity:{usd:40000}}],CA,NOW)},
    feed:{read:async()=>({candidates:[{address:CA}],sourceUrl:'https://example.invalid',fetchedAt:NOW})}});
  await runner.cycle();await runner.cycle();
  const sends=s.calls.filter(c=>c.method==='sendMessage');assert.equal(sends.length,1);assert.equal(sends[0].body.chat_id,chat);assert.doesNotMatch(sends[0].body.text,/PRIVATE NEW NAME/);
  const ledger=s.agents.signalList(42);assert.equal(ledger.length,1);assert.equal(ledger[0].target,chat);assert.equal(ledger[0].delivery,'sent');
  assert.equal(s.agents.groupSettings(chat).matched,1);
  const publicCallback={update_id:++sequence,callback_query:{id:'public',data:`groupdata:${chat}:1:0`,from:{id:99,is_bot:false},message:{chat:{id:chat,type:'supergroup'}}}};
  const evidence=await s.groups.respond(publicCallback);assert.ok(evidence.text);assert.doesNotMatch(evidence.text,/PRIVATE NEW NAME/);
  publicCallback.callback_query.message.chat.id=-999;assert.match((await s.groups.respond(publicCallback)).callbackNotice,/original group/);
});

test('group cadence survives cycles, changes require review, and pause revokes posting',async t=>{
  const s=setup(t);await enable(s);
  const proposed=await s.groups.respond(message('/groupconfig '+chat+' 10 1',42,42));
  assert.equal(s.agents.groupGet(chat).state,'review');await s.groups.respond(callback(action(proposed,'Enable')));
  await s.groups.deliver(42,key,'token-a','evidence');s.groups.beginCycle();
  await s.groups.deliver(42,key,'token-b','evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,1);
  s.setTime(NOW+600001);await s.groups.deliver(42,key,'token-b','evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,2);
  await s.groups.respond(message('/grouppause '+chat,42,42));s.groups.beginCycle();s.setTime(NOW+1200002);
  await s.groups.deliver(42,key,'token-c','evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,2);
  assert.ok(s.agents.auditList(42).some(a=>a.action==='group_configuration'));
});

test('group access rejects strangers, anonymous admins, foreign bots and wrong-owner buttons',async t=>{
  const s=setup(t);
  assert.equal(await s.groups.respond(message('/group connect',99)),null);
  const anonymous=message('/group connect');anonymous.message.sender_chat={id:chat};assert.equal(await s.groups.respond(anonymous),null);
  assert.equal(await s.groups.respond(message('/group@OtherBot connect')),null);
  assert.equal(s.calls.length,0);
  s.setAdmin(false);await s.groups.respond(message('/group connect'));assert.equal(s.agents.groupGet(chat),null);
  s.setAdmin(true);await s.groups.respond(message('/group connect'));
  const list=await s.groups.respond(message('/groups',42,42));
  assert.match((await s.groups.respond(callback(action(list,'Review'),57))).callbackNotice,/another tester/);
  s.setBot(false);assert.match((await s.groups.respond(message('/group connect'))).text,/admin/);
});

test('expired reviews, changed rules and access revoked during verification cannot enable posting',async t=>{
  const s=setup(t);await s.groups.respond(message('/group connect'));
  const list=await s.groups.respond(message('/groups',42,42)),review=await s.groups.respond(callback(action(list,'Review')));
  s.setTime(NOW+600001);await s.groups.respond(callback(action(review,'Enable')));assert.equal(s.agents.groupGet(chat).state,'review');
  s.setTime(NOW);await s.groups.respond(message('/group connect'));
  const latest=await s.groups.respond(message('/groups',42,42)),newReview=await s.groups.respond(callback(action(latest,'Review')));
  s.setBefore(()=>s.allowedUserIds.delete(42));await s.groups.respond(callback(action(newReview,'Enable')));
  assert.equal(s.agents.groupGet(chat).state,'review');
  s.allowedUserIds.add(42);s.setBefore(null);await enable(s);
  s.agents.put(42,{revision:2,draft:null,approved:{...approved,rules:[{...approved.rules[0],max:70000}]}});
  assert.equal(s.agents.groupGet(chat).state,'paused');
});

test('future discovery matches are shared once with evidence and without private control buttons',async t=>{
  const s=setup(t);await enable(s);
  const runner=createDiscoveryRunner({agents:s.agents,groups:s.groups,allowedUserIds:s.allowedUserIds,call:s.call,now:()=>NOW,
    market:{check:async()=>normalisePairs([{chainId:'solana',pairAddress:snapshot().selected.address,baseToken:{address:CA},marketCap:40000,liquidity:{usd:40000}}],CA,NOW)},feed:{read:async()=>({candidates:[{address:CA}],sourceUrl:'https://example.invalid',fetchedAt:NOW})}});
  await runner.cycle();await runner.cycle();
  const sends=s.calls.filter(c=>c.method==='sendMessage');assert.equal(sends.length,2);
  const group=sends.find(c=>c.body.chat_id===chat);assert.ok(group.body.text.includes(CA));assert.match(group.body.text,/Risk checks were not requested/);
  assert.deepEqual(group.body.reply_markup.inline_keyboard,[[{text:'View evidence',callback_data:`groupdata:${chat}:1:0`}],[{text:'Copy CA',copy_text:{text:CA}}]]);
  assert.deepEqual(group.body.entities.map(e=>group.body.text.slice(e.offset,e.offset+e.length)),[CA]);
  assert.ok(group.body.text.length<=4096);
});

test('removing admin access, pausing scans and stopping during authorization prevent group sends',async t=>{
  const s=setup(t);await enable(s);
  s.setAdmin(false);await s.groups.deliver(42,key,CA,'evidence');
  assert.equal(s.agents.groupGet(chat).state,'paused');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
  s.setAdmin(true);await enable(s);s.agents.discoverySet(42,'paused',key);
  await s.groups.deliver(42,key,CA,'evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
  s.agents.discoverySet(42,'active',key);s.setBefore(()=>s.agents.groupState(chat,'stopped'));
  await s.groups.deliver(42,key,CA,'evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
});

test('any verified group admin can stop sharing; a different tester cannot take over an active connection',async t=>{
  const s=setup(t);await enable(s);s.agents.put(57,{revision:1,approved,draft:null});
  await s.groups.respond(message('/group connect',57));assert.equal(s.agents.groupGet(chat).owner_id,42);
  await s.groups.respond(message('/group stop',99));assert.equal(s.agents.groupGet(chat).state,'stopped');
  await s.groups.respond(message('/group connect',57));assert.equal(s.agents.groupGet(chat).owner_id,57);
});

test('ambiguous sends remain recorded and are not repeated after reconnecting or restarting',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sift-groups-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const s=setup(t,{directory});await enable(s);s.setError(new TelegramError('NETWORK_OR_RESPONSE'));
  await s.groups.deliver(42,key,CA,'evidence');assert.equal(s.agents.groupIssues(chat),1);
  s.setError(null);await enable(s);await s.groups.deliver(42,key,CA,'evidence');
  assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,1);
  const reopened=openAgentStore({directory});t.after(()=>reopened.close());
  assert.equal(reopened.groupReserve(chat,42,key,CA,NOW),null);
});

test('group caps, Telegram backoff and forbidden-chat failures are bounded',async t=>{
  const s=setup(t);await enable(s);
  for(let i=0;i<4;i++)await s.groups.deliver(42,key,'token'+i,'evidence');
  assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,3);
  s.groups.beginCycle();s.setError(new TelegramError(429,120));await s.groups.deliver(42,key,'new','evidence');
  s.setError(null);await s.groups.deliver(42,key,'next','evidence');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,4);
  s.setTime(NOW+120001);s.setError(new TelegramError(403));await s.groups.deliver(42,key,'blocked','evidence');
  assert.equal(s.agents.groupGet(chat).state,'paused');
  for(const id of [-2,-3,-4])await s.groups.respond(message('/group connect',42,id));
  assert.equal(s.agents.groupList(42).filter(r=>r.state!=='stopped').length,3);
});

test('unresolved required risk checks never reach a configured group',async t=>{
  const s=setup(t);
  const full={...approved,rules:[...approved.rules,...TEST_RISK_RULES]};
  s.agents.put(42,{revision:2,draft:null,approved:full});s.agents.discoverySet(42,'active',criteriaKey(full));
  await enable(s);
  const runner=createDiscoveryRunner({agents:s.agents,groups:s.groups,call:s.call,allowedUserIds:s.allowedUserIds,now:()=>NOW,
    risk:{check:async()=>({})},market:{check:async()=>snapshot()},
    feed:{read:async()=>({candidates:[{address:CA}],sourceUrl:'https://example.invalid',fetchedAt:NOW})}});
  await runner.cycle();assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
});

test('shutdown during admin verification does not persistently pause the destination',async t=>{
  const s=setup(t);await enable(s);const controller=new AbortController();
  s.setBefore(()=>controller.abort());
  await s.groups.deliver(42,key,CA,'evidence',{signal:controller.signal});
  assert.equal(s.agents.groupGet(chat).state,'active');assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
});

test('fresh inherited group matches have independent deduplication and delivery budgets',async t=>{
  const s=setup(t);await enable(s);
  const prior=s.agents.discoveryReserve(42,key,CA,NOW-60000,{text:'Earlier private report; never copied to the group.'});
  s.agents.discoveryDelivery(42,prior,'sent');
  const candidates=[CA,...[21,22,23,24].map(address)];
  // The group already received these in an earlier cycle, but the private
  // destination has not. Private capacity must not starve the final new group CA.
  for(const token of candidates.slice(1,4)) {
    const id=s.agents.groupReserve(chat,42,key,token,NOW-60000);
    s.agents.groupDelivery(id,'sent');
  }
  const runner=createDiscoveryRunner({agents:s.agents,groups:s.groups,allowedUserIds:s.allowedUserIds,call:s.call,now:()=>NOW,
    market:{check:async token=>marketSnapshot(token)},
    feed:{read:async()=>({candidates:candidates.map(token=>({address:token})),sourceUrl:'https://example.invalid',fetchedAt:NOW})}});
  await runner.cycle();
  const authorizations=s.calls.filter(c=>c.method==='getChatMember').length;
  await runner.cycle();
  assert.equal(s.calls.filter(c=>c.method==='getChatMember').length,authorizations);
  const sent=s.calls.filter(c=>c.method==='sendMessage');
  const group=sent.filter(c=>c.body.chat_id===chat);
  assert.equal(group.length,2);
  assert.ok(group[0].body.text.includes(CA));
  assert.ok(group[1].body.text.includes(candidates[4]));
  assert.doesNotMatch(group[0].body.text,/Earlier private report/);
  assert.equal(sent.filter(c=>c.body.chat_id===42).length,4);
});

test('private mutes still suppress inherited groups and private 403 does not revive a paused scan',async t=>{
  for(const mode of ['mute','forbidden']) {
    const s=setup(t);await enable(s);
    if(mode==='mute')s.agents.discoveryMute(42,CA);
    const sends=[];
    const call=async(method,body)=>{
      if(method==='sendMessage'){sends.push(body);if(body.chat_id===42)throw new TelegramError(403);}
      return s.call(method,body);
    };
    const runner=createDiscoveryRunner({agents:s.agents,groups:s.groups,allowedUserIds:s.allowedUserIds,call,now:()=>NOW,
      market:{check:async()=>marketSnapshot()},feed:{read:async()=>({candidates:[{address:CA}],fetchedAt:NOW})}});
    await runner.cycle();
    assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
    assert.equal(sends.length,mode==='mute'?0:1);
    if(mode==='forbidden')assert.equal(s.agents.discoveryGet(42).state,'paused');
  }
});

test('group authorization waits cannot deliver stale evidence or override a newly set mute',async t=>{
  for(const mutation of ['stale','mute','quiet']) {
    const s=setup(t);await enable(s);
    s.setBefore(()=>{
      if(mutation==='stale')s.setTime(NOW+120001);
      else if(mutation==='mute')s.agents.discoveryMute(42,CA);
      else s.agents.preferencesPut(42,{...s.agents.preferences(42),quietStart:0,quietEnd:23},NOW);
    });
    await s.groups.deliver(42,key,CA,'Freshly evaluated match',{snapshot:snapshot(),strategy:approved,pages:['evidence']});
    assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
    assert.equal(s.agents.groupIssues(chat),0);
    assert.equal(s.agents.groupGet(chat).state,'active');
  }
});

test('required lock duration is re-evaluated after group admin verification',async t=>{
  const s=setup(t);
  const strategy={...approved,rules:[...approved.rules,{field:'liquidityProtection',mode:'require',policy:'evidence-v2',scope:'selected'}]};
  s.agents.put(42,{revision:2,draft:null,approved:strategy});
  const ruleKey=criteriaKey(strategy);s.agents.discoverySet(42,'active',ruleKey);
  await enable(s);
  const value=snapshot();value.risk={address:CA,pool:value.selected.address,checkedAt:NOW,
    liquidityProtection:{state:'pass',protectedPercent:100,kind:'lock',observedAt:NOW,unlockAt:sixMonthsAfter(NOW),links:['https://solscan.io/account/'+CA]}};
  s.setBefore(()=>s.setTime(NOW+1));
  await s.groups.deliver(42,ruleKey,CA,'At-boundary lock match',{snapshot:value,strategy,pages:['evidence']});
  assert.equal(s.calls.filter(c=>c.method==='sendMessage').length,0);
  assert.equal(s.agents.signalList(42).length,0);
});
