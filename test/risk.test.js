import test from 'node:test';
import assert from 'node:assert/strict';
import { sixMonthsAfter, unknown, STREAMFLOW } from '../src/evidence-utils.js';
import { verifyStreamLock, verifiedBurn, verifyLiquidityProtection } from '../src/liquidity-protection.js';
import { developerFromCreation, pumpSwapTrades, developerActivity, buyingEvidence } from '../src/wallet-evidence.js';
import { createRiskData, TEST_RISK_RULES, RISK_FIELDS, formatRiskReport } from '../src/risk.js';
import { evaluateRules, validateRules } from '../src/rules.js';
import { createLiquidityData } from '../src/liquidity.js';
import { createSolanaRpc } from '../src/solana-rpc.js';
import { TOKEN_PROGRAM } from '../src/raydium-liquidity.js';
import { NOW, CA, POOL, LP, DEV, META, QUOTE, address, account, snapshot, streamFixture, poolFixture, creation, transaction, trade, burn, sig } from './fixtures/risk.js';

test('six months uses UTC calendar arithmetic including month-end, leap years and exact time',()=>{
  for(const [input,expected] of [['2026-10-14T12:00:00.123Z','2027-04-14T12:00:00.123Z'],['2027-08-31T12:00:00Z','2028-02-29T12:00:00Z'],['2026-08-31T12:00:00Z','2027-02-28T12:00:00Z'],['2028-02-29T12:00:00Z','2028-08-29T12:00:00Z']])assert.equal(new Date(sixMonthsAfter(Date.parse(input))).toISOString(),new Date(expected).toISOString());
  assert.throws(()=>sixMonthsAfter(NaN));
});
test('lock verifies full exact custody and remaining time, including one second short',()=>{
  for(const [delta,pass] of [[0,true],[-1000,false],[1000,true]]){
    const f=streamFixture(1000n,sixMonthsAfter(NOW)+delta);
    const r=verifyStreamLock(f.metadata(),META,f.account(),LP,NOW);
    assert.equal(r.amount,1000n);assert.equal(r.meetsDuration,pass);
  }
});
test('mutable, canceled, fee-bearing, migrated and unknown lock features cannot qualify',()=>{
  for(const offset of [17,25,41,305,313,321,389,397,405,433,457,458,459,460,461,462,535,539,540,545,550,671,672,680,688,696,714,779,811,1103]){
    const f=streamFixture();f.data[offset]=1;
    assert.throws(()=>verifyStreamLock(f.metadata(),META,f.account(),LP,NOW),'offset '+offset);
  }
  for(const mutate of [f=>f.tokens[108]=2,f=>f.tokens[72]=1,f=>f.tokens[129]=1,f=>f.tokens[109]=1,f=>f.tokens[0]^=1,f=>f.tokens[32]^=1,f=>f.tokens[64]^=1,f=>f.data[209]^=1,f=>f.data[177]^=1,f=>f.data[449]^=1]){
    const f=streamFixture();mutate(f);assert.throws(()=>verifyStreamLock(f.metadata(),META,f.account(),LP,NOW));
  }
  const f=streamFixture();assert.throws(()=>verifyStreamLock({...f.metadata(),owner:TOKEN_PROGRAM},META,f.account(),LP,NOW));
  assert.throws(()=>verifyStreamLock(f.metadata(),address(9),f.account(),LP,NOW));
});
test('burn verifier requires a successful instruction for the actual LP mint and token program',()=>{
  assert.equal(verifiedBurn(burn(),LP,TOKEN_PROGRAM),true);
  for(const mutate of [tx=>tx.meta.err={},tx=>tx.transaction.message.instructions[0].programId=STREAMFLOW,tx=>tx.transaction.message.instructions[0].parsed.info.mint=CA,tx=>tx.transaction.message.instructions[0].parsed.info.amount='0',tx=>tx.transaction.message.instructions[0].parsed.type='transfer']){
    const tx=burn();mutate(tx);assert.equal(verifiedBurn(tx,LP,TOKEN_PROGRAM),false);
  }
});
const verify=(overrides={})=>verifyLiquidityProtection({rpc:{signatures:async()=>[{signature:sig(2),slot:100,err:null}],transaction:async()=>burn()},pool:{lpMint:LP},snapshotSlot:101,observation:{outstandingLp:'0'},lpProgram:TOKEN_PROGRAM,now:()=>NOW,...overrides});
test('zero outstanding supply qualifies only with a verified burn at or before the snapshot',async()=>{
  assert.equal((await verify()).state,'pass');
  for(const rows of [[],[{signature:sig(2),slot:102,err:null}],[{signature:sig(2),slot:100,err:{}}]])assert.equal((await verify({rpc:{signatures:async()=>rows,transaction:async()=>burn()}})).state,'unknown');
  assert.equal((await verify({rpc:{signatures:async()=>[{signature:sig(2),slot:100,err:null}],transaction:async()=>null}})).state,'unknown');
});
test('100% means every outstanding LP unit; no rounding, duplicate claims or supply race passes',async()=>{
  const f=streamFixture(9007199254740993n);
  const options={observation:{outstandingLp:'9007199254740993'},rpc:{streams:async()=>({slot:102,accounts:[{pubkey:META,account:f.metadata()}]})},readLinked:async()=>({observation:{outstandingLp:'9007199254740993'},extra:[f.metadata(),f.account()]})};
  assert.equal((await verify(options)).state,'pass');
  assert.equal((await verify({...options,readLinked:async()=>({observation:{outstandingLp:'9007199254740994'},extra:[f.metadata(),f.account()]})})).state,'unknown');
  assert.equal((await verify({...options,readLinked:async()=>({observation:{outstandingLp:'0'},extra:[f.metadata(),f.account()]})})).state,'unknown');
  assert.equal((await verify({...options,rpc:{streams:async()=>({slot:102,accounts:[{pubkey:META,account:f.metadata()},{pubkey:address(9),account:f.metadata()}]})}})).state,'unknown');
  const short=streamFixture(9007199254740993n,sixMonthsAfter(NOW)-1000);
  assert.equal((await verify({...options,readLinked:async()=>({observation:options.observation,extra:[short.metadata(),short.account()]})})).state,'fail');
});
test('liquidity integration rejects stale burn proof and rereads lock custody with pool at one slot',async()=>{
  const accounts=poolFixture();
  for(const [age,state] of [[5000,'pass'],[120001,'unknown']]){
    const rpc={accounts:async(keys)=>({slot:101,accounts:keys.length===1?[accounts[0]]:accounts}),blockTime:async()=>NOW-age,signatures:async()=>[{signature:sig(2),slot:100,err:null}],transaction:async()=>burn()};
    const result=await createLiquidityData({rpc,now:()=>NOW}).check(snapshot(),{verifyProtection:true});assert.equal(result.protectionRequirement,state);
  }
  const f=streamFixture(),a=poolFixture(1000n),calls=[];
  const rpc={accounts:async(keys,options)=>{calls.push({keys,options});return {slot:103,accounts:keys.length===1?[a[0]]:keys.length===4?a:[...a,f.metadata(),f.account()]};},blockTime:async()=>NOW-1000,streams:async()=>({slot:102,accounts:[{pubkey:META,account:f.metadata()}]})};
  const result=await createLiquidityData({rpc,now:()=>NOW}).check(snapshot(),{verifyProtection:true});
  assert.equal(result.protectionRequirement,'pass');assert.deepEqual(calls[2].keys.slice(4),[META,f.escrow]);assert.equal(calls[2].options.minContextSlot,102);
});
test('developer attribution requires a signed token-creation instruction; a fee recipient is insufficient',()=>{
  assert.equal(developerFromCreation(creation(),CA),DEV);
  for(const mutate of [tx=>tx.meta.err={},tx=>tx.transaction.message.accountKeys[0].signer=false,tx=>tx.transaction.message.instructions[0].accounts[7]=address(9),tx=>tx.transaction.message.instructions[0].accounts[0]=LP,tx=>tx.transaction.message.instructions[0].data='111']){
    const tx=creation();mutate(tx);assert.equal(developerFromCreation(tx,CA),null);
  }
  assert.equal(developerFromCreation(trade(transaction()),CA),null);
});
test('direct PumpSwap sales require base and quote transfers in the same invocation',()=>{
  const tx=trade(transaction(),'sell');assert.equal(pumpSwapTrades(tx,CA)[0].side,'sale');
  for(const mutate of [tx=>tx.meta.err={},tx=>tx.meta.innerInstructions[0].instructions.pop(),tx=>tx.meta.preTokenBalances[0].owner=address(10),tx=>tx.meta.innerInstructions[0].index=1,tx=>tx.transaction.message.instructions[0].accounts[3]=LP]){
    const tx=trade(transaction(),'sell');mutate(tx);assert.equal(pumpSwapTrades(tx,CA).length,0);
  }
  const events=developerActivity([{signature:sig(1),tx}],CA,DEV);assert.equal(events.length,1);assert.equal(events[0].kind,'sale');
  const transfer=trade(transaction(),'sell');transfer.transaction.message.instructions[0].data='111';
  const moved=developerActivity([{signature:sig(1),tx:transfer}],CA,DEV);assert.equal(moved[0].kind,'transfer');assert.ok(moved.every(e=>e.kind!=='sale'));
});
test('atomic multi-signer buys are confirmed; same-slot buys are only suspicious and never clear missing bundle coverage',()=>{
  const tx=trade(trade(transaction()),'buy',address(9),40);
  assert.equal(buyingEvidence([{signature:sig(1),tx}],CA,POOL).state,'fail');
  const sameWallet=trade(trade(transaction()));assert.equal(buyingEvidence([{signature:sig(1),tx:sameWallet}],CA,POOL).state,'unknown');
  const rows=[{signature:sig(1),tx:trade(transaction())},{signature:sig(2),tx:trade(transaction(sig(2)),'buy',address(9),40)}];
  const result=buyingEvidence(rows,CA,POOL);assert.equal(result.state,'unknown');assert.equal(result.confirmed,false);assert.equal(result.suspicions.length,1);
  assert.equal(buyingEvidence([],CA,POOL).state,'unknown');
});
test('each unknown, stale, mismatched or absent required risk check prevents qualification',()=>{
  const s={...snapshot(),risk:{address:CA,pool:POOL,checkedAt:NOW,...Object.fromEntries(RISK_FIELDS.map(f=>[f,{state:'pass',observedAt:NOW,links:['synthetic'],protectedPercent:100,kind:'burn',wallet:DEV,amount:'1'}]))}};
  assert.equal(evaluateRules(TEST_RISK_RULES.slice(0,2),s,{now:NOW}).matches,true);
  assert.equal(evaluateRules(TEST_RISK_RULES,s,{now:NOW}).matches,false); // No bare bundle-free boolean is accepted.
  for(const field of RISK_FIELDS)for(const state of ['unknown','fail',undefined,'PASS']){
    const risk={...s.risk,[field]:{state}};assert.equal(evaluateRules(TEST_RISK_RULES,{...s,risk},{now:NOW}).matches,false);
  }
  for(const change of [{address:LP},{pool:LP},{checkedAt:NOW-120001},{checkedAt:NOW+1}])assert.equal(evaluateRules(TEST_RISK_RULES,{...s,risk:{...s.risk,...change}},{now:NOW}).matches,false);
  assert.equal(evaluateRules(TEST_RISK_RULES,snapshot(),{now:NOW}).matches,false);
  assert.throws(()=>validateRules([{...TEST_RISK_RULES[0],mode:'warn'}]));
  assert.throws(()=>validateRules([{...TEST_RISK_RULES[0],policy:'99-percent'}]));
});
test('risk service permits and flags verified partial sales but zero holdings fail',async()=>{
  for(const amount of ['20','0']){
    const create=creation(),sale=trade(transaction(sig(2),101),'sell');
    const rpc={signatures:async a=>a===CA?[{signature:sig(1),slot:100,err:null}]:a===DEV?[{signature:sig(2),slot:101,err:null}]:[],transaction:async s=>s===sig(1)?create:sale,
      tokenAccounts:async()=>({slot:102,accounts:[{account:{data:{parsed:{info:{tokenAmount:{amount}}}}}}]}),blockTime:async()=>NOW-1000};
    const service=createRiskData({rpc,liquidity:{check:async()=>({protection:{state:'pass',links:[],kind:'burn',protectedPercent:100},slot:101,blockTime:NOW-1000})},now:()=>NOW});
    const result=await service.check(snapshot());assert.equal(result.developerHolding.state,amount==='0'?'fail':'pass');assert.equal(result.events[0].kind,'sale');assert.ok(result.warnings.some(w=>w.includes('sales')));
    assert.equal(result.buyingCoordination.state,'unknown');assert.equal(evaluateRules(TEST_RISK_RULES,{...snapshot(),risk:result},{now:NOW}).matches,false);
    assert.ok(formatRiskReport(result).length<4000);assert.match(formatRiskReport(result),/never sold/);
    assert.equal((await service.check(snapshot())).developerHolding.state,'unknown');
  }
});
test('RPC evidence methods use finalized reads and reject malformed, truncated, duplicate or mismatched results',async()=>{
  const request=[];const rpc=createSolanaRpc({fetchImpl:async(_url,options)=>{const r=JSON.parse(options.body);request.push(r);return Response.json({jsonrpc:'2.0',id:r.id,result:r.method==='getSignaturesForAddress'?[]:r.method==='getTransaction'?null:{context:{slot:102},value:[]}});}});
  await rpc.signatures(CA);await rpc.transaction(sig(1));await rpc.streams(LP,{minContextSlot:100});await rpc.tokenAccounts(DEV,CA,{minContextSlot:100});
  assert.ok(request.every(r=>r.params.at(-1).commitment==='finalized'));assert.equal(request[0].params[1].limit,20);
  for(const result of [[{signature:'bad',slot:1,err:null}],Array(21).fill({signature:sig(1),slot:100,err:null,confirmationStatus:'finalized'})]){
    const bad=createSolanaRpc({fetchImpl:async()=>Response.json({jsonrpc:'2.0',id:1,result})});await assert.rejects(bad.signatures(CA));
  }
  const mismatch=createSolanaRpc({fetchImpl:async()=>Response.json({jsonrpc:'2.0',id:1,result:transaction(sig(2))})});await assert.rejects(mismatch.transaction(sig(1)));
});
