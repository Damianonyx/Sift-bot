import test from 'node:test';
import assert from 'node:assert/strict';
import { createBundleData } from '../src/bundle-evidence.js';
import { createResponder } from '../src/commands.js';
import { NOW, CA, snapshot, transaction, trade, sig } from './fixtures/risk.js';
const ID='a'.repeat(64);
const status=()=>({jsonrpc:'2.0',id:1,result:{context:{slot:101},value:[{bundle_id:ID,confirmation_status:'finalized',err:{Ok:null},slot:100,transactions:[sig(1),sig(2)]}]}});
const rpc={transaction:async s=>s===sig(1)?trade(transaction(s)):transaction(s)};
const service=payload=>createBundleData({rpc,now:()=>NOW,fetchImpl:async()=>Response.json(payload)});
const noRequest=async()=>assert.fail('Unexpected request');
test('known finalized Jito bundle requires independently verified matching-pool buy and all transactions',async()=>{
  let requests=0;
  const source=createBundleData({rpc,now:()=>NOW,fetchImpl:async(url,options)=>{requests++;assert.equal(url,'https://mainnet.block-engine.jito.wtf/api/v1/getBundleStatuses');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{jsonrpc:'2.0',id:1,method:'getBundleStatuses',params:[[ID]]});return Response.json(status());}});
  const evidence=await source.check(snapshot(),ID);assert.equal(evidence.state,'fail');assert.equal(evidence.confirmed,true);assert.match(evidence.links[0],/explorer.jito/);
  assert.equal((await source.check(snapshot(),ID)).state,'unknown');assert.equal(requests,1);
  const single=status();single.result.value[0].transactions=[sig(1)];assert.equal((await service(single).check(snapshot(),ID)).state,'fail');
});
test('missing, expired, wrong, failed, non-finalized and partial bundle evidence never clears the requirement',async()=>{
  for(const mutate of [r=>r.id=2,r=>r.result.value=[null],r=>r.result.value[0].bundle_id='b'.repeat(64),r=>r.result.value[0].confirmation_status='confirmed',r=>r.result.value[0].err={Err:'synthetic'},r=>r.result.value[0].transactions=[sig(1),sig(1)],r=>r.result.value[0].transactions=['bad']]){
    const value=status();mutate(value);assert.equal((await service(value).check(snapshot(),ID)).state,'unknown');
  }
  for(const rpcSource of [{transaction:async()=>null},{transaction:async()=>transaction(sig(1),99)},{transaction:async s=>transaction(s)}]){
    const source=createBundleData({rpc:rpcSource,fetchImpl:async()=>Response.json(status())});assert.equal((await source.check(snapshot(),ID)).state,'unknown');
  }
});
test('bundle errors, oversized bodies, invalid IDs and rate limiting are bounded and sanitized',async()=>{
  for(const response of [new Response('{'),new Response('x'.repeat(32769)),new Response('',{status:403})]){
    const source=createBundleData({fetchImpl:async()=>response,rpc});const r=await source.check(snapshot(),ID);assert.equal(r.state,'unknown');
  }
  let calls=0,time=NOW;
  const source=createBundleData({now:()=>time,rpc,fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});
  await source.check(snapshot(),ID);time+=61000;await source.check(snapshot(),ID);assert.equal(calls,1);
  assert.equal((await createBundleData({fetchImpl:noRequest}).check(snapshot(),'invalid')).state,'unknown');
});
test('bundle command authorizes before any market or Jito request and never changes criteria',async()=>{
  const respond=createResponder({market:{check:noRequest},bundles:{check:noRequest}});
  const update=(text,id=42)=>({update_id:1,message:{text,from:{id,is_bot:false},chat:{id,type:'private'}}});
  assert.match((await respond(update('/bundle '+CA+' '+ID,99),new Set([42]))).text,/does not have tester access/);
  assert.match((await respond(update('/bundle '+CA),new Set([42]))).text,/known Jito/);
  const check=createResponder({market:{check:async()=>snapshot()},bundles:service(status())});
  const reply=await check(update('/bundle '+CA+' '+ID),new Set([42]));assert.match(reply.text,/FAIL/);assert.match(reply.text,/unchanged/);assert.ok(reply.text.length<4096);
});
