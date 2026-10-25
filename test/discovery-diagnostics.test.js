import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentStore } from '../src/agent-store.js';
import { explainDiscovery } from '../src/discovery-diagnostics.js';
import { criteriaKey } from '../src/discovery-store.js';
import { createResponder } from '../src/commands.js';

const marketRule={field:'marketCap',mode:'require',min:20000,max:60000};
const approved={name:'TheGeek',rules:[marketRule,{field:'liquidityProtection',mode:'require',scope:'all',policy:'evidence-v2'},
  {field:'buyingCoordination',mode:'require',policy:'evidence-v2'}],pendingRequirements:[]};
const at=Date.UTC(2026,9,23);
function store(t){const s=openAgentStore({memory:true});t.after(()=>s.close());return s;}

test('diagnosis preserves an unresolved draft and explains no approved rules without claiming scans ran',t=>{
  const s=store(t),draft={name:'TheGeek',step:6,rules:[marketRule],pendingRequirements:['Require all liquidity protected and no bundles.']};
  s.put(42,{revision:1,draft,approved:null});const before=s.get(42),scan=s.discoveryGet(42);
  const r=explainDiscovery(s,42);
  assert.match(r.text,/unresolved instructions/);assert.match(r.text,/No approved strategy/);
  assert.deepEqual(s.get(42),before);assert.deepEqual(s.discoveryGet(42),scan);
});

test('saved diagnostics separate unknowns, failing metrics, source failures and known passing observations',t=>{
  const s=store(t),key=criteriaKey(approved);s.put(42,{revision:1,draft:null,approved});s.discoverySet(42,'active',key);
  s.discoveryRecord(42,key,'a',at,{matches:false,checks:[{...marketRule,state:'fail'},{field:'buyingCoordination',state:'unknown'}]});
  s.discoveryRecord(42,key,'b',at+1,{matches:false,issue:'MARKET_UNAVAILABLE'});
  s.discoveryRecord(42,key,'c',at+2,{matches:true,checks:[]});
  s.discoveryRecord(43,key,'private-other-user',at+3,{matches:true,checks:[]});
  s.discoveryRecord(42,'old-strategy','old-token',at+4,{matches:true,checks:[]});
  const r=explainDiscovery(s,42);
  assert.match(r.text,/all-pools protection/);assert.match(r.text,/complete coverage is unavailable/);
  assert.match(r.text,/3 shown/);assert.match(r.text,/Passed required rules: 1/);assert.match(r.text,/source issue: 1/);
  assert.match(r.text,/1 failed; 0 unknown/);assert.match(r.text,/0 failed; 1 unknown/);
  assert.doesNotMatch(r.text,/private-other-user|old-token/);assert.ok(r.text.length<4096);
});

test('diagnosis limits the sample to 20 latest distinct token checks for the current strategy',t=>{
  const s=store(t),key=criteriaKey(approved);s.put(42,{revision:1,draft:null,approved});
  for(let i=0;i<30;i++)s.discoveryRecord(42,key,'token-'+i,at+i,{matches:false,checks:[{...marketRule,state:'fail'}]});
  s.discoveryRecord(42,key,'token-29',at+40,{matches:false,checks:[{...marketRule,state:'unknown'}]});
  const rows=s.discoveryDiagnostics(42,key);assert.equal(rows.length,20);assert.equal(rows[0].token,'token-29');
  const r=explainDiscovery(s,42);assert.match(r.text,/19 failed; 1 unknown/);assert.match(r.text,/span multiple cycles/);
});

test('/why authorizes before accessing private saved evaluations and never calls sources',async t=>{
  const s=store(t);s.put(42,{revision:1,draft:null,approved});let requests=0;
  const respond=createResponder({agents:s,market:{check:async()=>{requests++;throw Error('unexpected');}}});
  const update=id=>({update_id:100+id,message:{from:{id,is_bot:false},chat:{id,type:'private'},text:'/why'}});
  const forbidden=await respond(update(57),new Set([42]));assert.doesNotMatch(forbidden.text,/TheGeek|all-pools/);
  assert.match((await respond(update(42),new Set([42]))).text,/Why no alerts/);assert.equal(requests,0);
});
