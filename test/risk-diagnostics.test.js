import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiskData, formatRiskReport } from '../src/risk.js';
import { createLiquidityData } from '../src/liquidity.js';
import { createSolanaRpc, SolanaRpcError } from '../src/solana-rpc.js';
import { NOW, CA, POOL, address, sig, snapshot, transaction, poolFixture } from './fixtures/risk.js';

const unknownLiquidity = {check:async()=>({protection:{state:'unknown',reason:'Synthetic unsupported protection',links:[]}})};
const run = (rpc,liquidity=unknownLiquidity) => createRiskData({rpc,liquidity,now:()=>NOW}).check(snapshot());

test('risk report preserves liquidity account, layout and source failures instead of calling all unsupported',async()=>{
  const layout=poolFixture()[0];layout.data=[Buffer.alloc(1).toString('base64'),'base64'];
  const cases=[
    [async()=>({slot:100,accounts:[{owner:address(99)}]}),/pool program is not supported/],
    [async()=>({slot:100,accounts:[layout]}),/account layout did not match/],
    [async()=>({slot:100,accounts:[null]}),/on-chain account was missing/],
    [async()=>{throw new SolanaRpcError('SOURCE_UNAVAILABLE');},/RPC was unavailable or denied/],
    [async()=>{throw new SolanaRpcError('TIMED_OUT');},/RPC request timed out/],
    [async()=>{throw new SolanaRpcError('INVALID_RESPONSE');},/usable response/],
    [async()=>{throw new SolanaRpcError('RATE_LIMITED',60);},/RPC rate limit/],
  ];
  for(const [accounts,expected] of cases){
    const rpc={accounts,signatures:async()=>[]};
    const result=await run(rpc,createLiquidityData({rpc,now:()=>NOW}));
    assert.equal(result.liquidityProtection.state,'unknown');
    assert.match(result.liquidityProtection.reason,expected);
    assert.doesNotMatch(formatRiskReport(result),/Pool protection unsupported\./);
  }
});

test('two verified transactions then a rate limit explains the interrupted sample and preserves the read budget',async()=>{
  const rows=Array.from({length:20},(_,i)=>({signature:sig(i+1),slot:100,err:null}));let requests=0;
  const rpc={signatures:async()=>rows,transaction:async signature=>{
    requests++;if(signature===sig(3))throw new SolanaRpcError('RATE_LIMITED',60);
    return transaction(signature);
  }};
  const result=await run(rpc);
  assert.equal(requests,3); // Pool reuses the same failed lookup, with its reason.
  for(const sample of result.coverage){
    assert.equal(sample.state,'interrupted');assert.equal(sample.read,2);
    assert.equal(sample.returned,20);assert.equal(sample.missing,1);assert.equal(sample.omitted,17);
    assert.match(sample.reason,/RPC rate limit/);
  }
  assert.match(formatRiskReport(result),/Reason: Solana RPC rate limit/);
  assert.equal(result.developerHolding.state,'unknown');assert.equal(result.buyingCoordination.state,'unknown');
});

test('unavailable signature history, timeouts and malformed transactions retain distinct safe causes',async()=>{
  for(const [code,expected] of [['TIMED_OUT',/timed out/],['INVALID_RESPONSE',/unusable or mismatched/],
    ['SOURCE_UNAVAILABLE',/unavailable or denied/],['NETWORK_OR_RESPONSE',/could not be reached/]]){
    const unavailable=await run({signatures:async()=>{throw new SolanaRpcError(code);}});
    assert.ok(unavailable.coverage.every(c=>c.state==='unavailable'));
    assert.match(formatRiskReport(unavailable),expected);
    const interrupted=await run({signatures:async()=>[{signature:sig(1),slot:100,err:null}],
      transaction:async()=>{throw new SolanaRpcError(code);}});
    assert.ok(interrupted.coverage.every(c=>c.state==='interrupted'));
    assert.match(formatRiskReport(interrupted),expected);
  }
});

test('unavailable transaction bodies get an explanation without invented provider failures',async()=>{
  const missing=await run({signatures:async()=>[{signature:sig(1),slot:100,err:null}],transaction:async()=>null});
  assert.ok(missing.coverage.every(c=>c.state==='sampled'&&c.missing===1));
  assert.match(formatRiskReport(missing),/RPC returned no transaction body/);
  assert.doesNotMatch(formatRiskReport(missing),/rate limit|timed out/);
});

test('unknown errors and codes cannot inject private details into risk reports',async()=>{
  for(const error of [Error('PRIVATE_SECRET https://private.invalid'),new SolanaRpcError('PRIVATE_SECRET'),
    Object.assign(Error('PRIVATE_SECRET'),{code:'RATE_LIMITED'})]){
    const result=await run({signatures:async()=>{throw error;}},{check:async()=>{throw error;}});
    const text=formatRiskReport(result);assert.doesNotMatch(text,/PRIVATE_SECRET|private.invalid|rate limit/);
    assert.match(text,/cause was not classified/);
  }
});

test('RPC distinguishes timeout, cancellation, invalid JSON and network failure without leaking details',async()=>{
  const cases=[
    [async()=>{throw new DOMException('PRIVATE_SECRET','TimeoutError');},'TIMED_OUT'],
    [async()=>new Response('PRIVATE_SECRET',{status:200}),'INVALID_RESPONSE'],
    [async()=>{throw Error('PRIVATE_SECRET');},'NETWORK_OR_RESPONSE'],
    [async()=>new Response('PRIVATE_SECRET',{status:403}),'SOURCE_UNAVAILABLE'],
  ];
  for(const [fetchImpl,code] of cases){
    await assert.rejects(createSolanaRpc({fetchImpl}).accounts([POOL]),e=>e.code===code&&!e.stack.includes('PRIVATE_SECRET'));
  }
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(createSolanaRpc({fetchImpl:async()=>{calls++;}}).accounts([CA],{signal:controller.signal}),e=>e.code==='STOPPED');
  assert.equal(calls,0);
});
