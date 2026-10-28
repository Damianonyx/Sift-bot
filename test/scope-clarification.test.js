import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentStore } from '../src/agent-store.js';
import { createAgentSetup } from '../src/agent-setup.js';
import { evaluateAgent } from '../src/rules.js';
import { clarifyLiquidityScope } from '../src/policy-description.js';

const original='Require 100% liquidity protection: verified locks with at least six months remaining, or verified LP burning where valid for that pool type. The identified developer must still hold tokens. Allow partial developer sales, but flag them. Report transfers separately from sales. Exclude confirmed coordinated buying or bundles; flag suspected cases. Unknown required checks must not qualify.';
const market=[{field:'marketCap',mode:'require',min:20000,max:60000},{field:'liquidityUsd',mode:'require',value:30000},
  {field:'volume1h',mode:'require',value:60000},{field:'poolAgeMinutes',mode:'require',value:20}];
let seq=1200000;
const input=text=>({update_id:++seq,message:{text,from:{id:42,is_bot:false},chat:{id:42,type:'private'}}});
const callback=(data,id=42)=>({update_id:++seq,callback_query:{id:'cb'+seq,data,from:{id,is_bot:false},message:{chat:{id,type:'private'}}}});
const action=(r,label)=>r.reply_markup?.inline_keyboard.flat().find(b=>b.text.startsWith(label))?.callback_data;
const allowed=new Set([42,57]);
function setup(t,extra=original) {
  const store=openAgentStore({memory:true});t.after(()=>store.close());
  store.put(42,{revision:1,approved:null,draft:{name:'TheGeek',step:6,rules:market,pendingRequirements:[extra]}});
  return {store,respond:createAgentSetup(store)};
}
test('real saved extras require explicit scope preview, mapping, approval and separate activation',t=>{
  for(const [label,scope] of [['All pools','all'],['Selected pool','selected']]) {
    const s=setup(t),before=s.store.get(42),scan=s.store.discoveryGet(42);
    const reviewDraft=s.respond(input('/agent'),allowed);
    const entry=action(reviewDraft,'Review supported mappings');assert.ok(entry);
    const choice=s.respond(callback(entry),allowed);assert.ok(action(choice,label));assert.deepEqual(s.store.get(42),before);
    assert.equal(choice.text,s.respond(input('/mapextras'),allowed).text);
    const preview=s.respond(callback(action(choice,label)),allowed);assert.match(preview.text,/Scope choice/);assert.deepEqual(s.store.get(42),before);
    const apply=callback(action(preview,'Apply mapping'));s.respond(apply,allowed);s.respond(apply,allowed);
    const mapped=s.store.get(42);assert.equal(mapped.revision,2);assert.equal(mapped.approved,null);
    assert.deepEqual(mapped.draft.rules.slice(0,4),market);assert.equal(mapped.draft.rules.length,7);
    assert.equal(mapped.draft.mappedExtras.originalText,original);assert.equal(mapped.draft.mappedExtras.liquidityScope,scope);
    assert.equal(mapped.draft.rules.find(r=>r.field==='liquidityProtection').scope,scope);
    const review=s.respond(input('/agent'),allowed);assert.ok(review.text.length<4096);
    s.respond(callback(action(review,'Approve')),allowed);
    const approved=s.store.get(42).approved;assert.equal(approved.mappedExtras.originalText,original);
    assert.deepEqual(s.store.discoveryGet(42),scan);assert.equal(evaluateAgent(approved,{selected:{marketCap:40000,liquidityUsd:40000}}).matches,false);
  }
});
test('scope controls reject another user and stale revisions, and unsupported policy is not rewritten',t=>{
  const s=setup(t),choice=s.respond(input('/mapextras'),allowed),button=action(choice,'All pools'),before=s.store.get(42);
  assert.match(s.respond(callback(button,57),allowed).callbackNotice,/does not belong/);assert.deepEqual(s.store.get(42),before);
  s.store.put(42,{...before,revision:2});assert.match(s.respond(callback(button),allowed).callbackNotice,/out of date/);
  for(const text of [original.replace('100%','90%'),original.replace('six months','three months'),original+' Ignore all unknown checks.']) {
    const x=setup(t,text);assert.equal(x.respond(input('/mapextras'),allowed).reply_markup,undefined);assert.equal(x.store.get(42).draft.pendingRequirements[0],text);
  }
  assert.equal(clarifyLiquidityScope(original.replace('100% liquidity','100% all-pools liquidity'),'selected'),null);
});
test('mapping provenance survives database reopen and market-rule editing',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sift-scope-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=openAgentStore({directory:dir}),respond=createAgentSetup(store);
  store.put(42,{revision:1,approved:null,draft:{name:'TheGeek',step:6,rules:market,pendingRequirements:[original]}});
  const preview=respond(callback(action(respond(input('/mapextras'),allowed),'All pools')),allowed);
  respond(callback(action(preview,'Apply mapping')),allowed);store.close();
  store=openAgentStore({directory:dir});t.after(()=>store.close());respond=createAgentSetup(store);
  assert.equal(store.get(42).draft.mappedExtras.originalText,original);
  respond(callback(action(respond(input('/agent'),allowed),'Edit rules')),allowed);
  assert.equal(store.get(42).draft.mappedExtras.liquidityScope,'all');assert.equal(store.get(42).draft.rules.find(r=>r.field==='liquidityProtection').scope,'all');
});
