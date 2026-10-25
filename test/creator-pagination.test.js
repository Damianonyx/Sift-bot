import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiskData, formatRiskReport } from '../src/risk.js';
import { createSolanaRpc } from '../src/solana-rpc.js';
import { NOW, CA, DEV, POOL, sig, snapshot, transaction, creation } from './fixtures/risk.js';

const rows=start=>Array.from({length:20},(_,i)=>({signature:sig(start+i),slot:100,err:null,confirmationStatus:'finalized'}));
const liquidity={check:async()=>({protection:{state:'unknown',reason:'Unsupported fixture',links:[]}})};
test('bounded mint pagination locates an older creation while preserving transaction budgets and unknown bundle coverage',async()=>{
  const cursors=[],reads=[];
  const rpc={signatures:async(address,options)=>{
    if(address!==CA)return [];
    cursors.push(options.before??null);return rows(options.before===sig(20)?21:options.before===sig(40)?41:1);
  },transaction:async signature=>{reads.push(signature);return signature===sig(60)?creation(signature):transaction(signature);},
  tokenAccounts:async()=>({slot:102,accounts:[{account:{data:{parsed:{info:{tokenAmount:{amount:'20'}}}}}}]}),blockTime:async()=>NOW};
  const result=await createRiskData({rpc,liquidity,now:()=>NOW}).check(snapshot());
  assert.deepEqual(cursors,[null,sig(20),sig(40)]);assert.equal(reads[0],sig(60));assert.equal(reads.length,20);
  assert.equal(result.developerHolding.state,'pass');assert.equal(result.developerHolding.wallet,DEV);
  assert.equal(result.buyingCoordination.state,'unknown');
  const mint=result.coverage[0];assert.equal(mint.pages,3);assert.equal(mint.returned,60);assert.equal(mint.omitted,40);assert.equal(mint.pageLimitReached,true);
  assert.match(formatRiskReport(result),/page cap reached/);
});
test('repeated or failing pagination retains read evidence without claiming complete history',async()=>{
  for(const fail of [false,true]) {
    const rpc={signatures:async(address,options)=>{if(address!==CA)return [];if(options.before&&fail)throw Error('PRIVATE');return rows(1);},transaction:async signature=>transaction(signature)};
    const result=await createRiskData({rpc,liquidity,now:()=>NOW}).check(snapshot());
    assert.equal(result.coverage[0].pages,1);assert.equal(result.coverage[0].returned,20);assert.ok(result.coverage[0].paginationIssue);
    assert.equal(result.developerHolding.state,'unknown');assert.doesNotMatch(formatRiskReport(result),/PRIVATE/);
  }
});
test('RPC cursors are validated and repeated or forward signature pages are rejected',async()=>{
  let requested;
  const make=result=>createSolanaRpc({fetchImpl:async(_url,options)=>{requested=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:requested.id,result});}});
  const result=await make(rows(21)).signatures(CA,{before:sig(20)});assert.equal(result.length,20);assert.equal(requested.params[1].before,sig(20));
  await assert.rejects(make([]).signatures(CA,{before:'invalid'}),e=>e.code==='INVALID_REQUEST');
  await assert.rejects(make(rows(1)).signatures(CA,{before:sig(20)}),e=>e.code==='INVALID_RESPONSE');
  const backwards=rows(21);backwards[5].slot=101;await assert.rejects(make(backwards).signatures(CA),e=>e.code==='INVALID_RESPONSE');
});
test('HTTP-200 RPC throttling triggers shared backoff and never exposes raw errors',async()=>{
  for(const code of [429,-32429]) {
    let calls=0,time=NOW;
    const rpc=createSolanaRpc({now:()=>time,fetchImpl:async(_url,options)=>{calls++;const r=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:r.id,error:{code,message:'PRIVATE'}});}});
    await assert.rejects(rpc.accounts([POOL]),e=>e.code==='RATE_LIMITED'&&e.retryAfter===60&&!e.message.includes('PRIVATE'));
    await assert.rejects(rpc.signatures(CA),e=>e.code==='RATE_LIMITED');assert.equal(calls,1);
    time+=60001;await assert.rejects(rpc.accounts([POOL]),e=>e.code==='RATE_LIMITED');assert.equal(calls,2);
  }
});
