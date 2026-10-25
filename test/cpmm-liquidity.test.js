import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCpmmPool, observeCpmmLp, RAYDIUM_CPMM } from '../src/cpmm-liquidity.js';
import { publicKeyBytes, TOKEN_PROGRAM, LiquidityEvidenceError } from '../src/raydium-liquidity.js';
import { createLiquidityData, formatLiquidityReport } from '../src/liquidity.js';
import { sixMonthsAfter } from '../src/evidence-utils.js';
import { NOW, META, account, streamFixture, burn, sig } from './fixtures/risk.js';

// SYNTHETIC packed PoolState, SPL mint/vault and transaction payloads. Layout
// follows raydium-cp-swap f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5; fixed seed
// vectors below are generated for a synthetic signed pool, not mainnet evidence.
const BASE='4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const QUOTE='8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const POOL='CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const CONFIG='GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const ORACLE='LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
const CREATOR='QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF';
const LP='U1R4AQsvxnYSYzUxchjAh29VMpiBwqt2rW1CnQTPSB5';
const BV='DRbGXSsgiJbcjFHxhw5g4JbYkzD54R5StB96NyivjpZA';
const QV='5MxFonatVvMWWWsfc745FhfsuaBm1diyyM7gcHWri9cs';
const AUTH='3ZhJ5HtErvYXtdFniuVWTPbvhWJ3RKXnHDsKGtuVNdyH';
const snapshot=()=>({address:BASE,selected:{address:POOL},poolCount:2,selection:'reported_liquidity',fetchedAt:NOW});
function fixture(supply=900n) {
  const pool=Buffer.alloc(637);
  Buffer.from([247,237,227,245,215,195,222,70]).copy(pool);
  for(const [value,offset] of [[CONFIG,8],[CREATOR,40],[BV,72],[QV,104],[LP,136],[BASE,168],[QUOTE,200],[TOKEN_PROGRAM,232],[TOKEN_PROGRAM,264],[ORACLE,296]])publicKeyBytes(value).copy(pool,offset);
  pool[328]=255;pool[330]=9;pool[331]=6;pool[332]=9;
  pool.writeBigUInt64LE(1000n,333);pool.writeBigUInt64LE(BigInt(NOW/1000-60),373);
  const mint=Buffer.alloc(82);mint.writeUInt32LE(1);publicKeyBytes(AUTH).copy(mint,4);
  mint.writeBigUInt64LE(supply,36);mint[44]=9;mint[45]=1;
  const vault=m=>{const d=Buffer.alloc(165);publicKeyBytes(m).copy(d);publicKeyBytes(AUTH).copy(d,32);d.writeBigUInt64LE(100n,64);d[108]=1;return d;};
  const bytes=[pool,mint,vault(BASE),vault(QUOTE)],owners=[RAYDIUM_CPMM,TOKEN_PROGRAM,TOKEN_PROGRAM,TOKEN_PROGRAM];
  return {bytes,owners,accounts:()=>bytes.map((d,i)=>account(d,owners[i]))};
}
const observe=f=>{const a=f.accounts();return observeCpmmLp(decodeCpmmPool(a[0],BASE,POOL),a.slice(1));};
function rpc(f,{age=1000,rows=[],transaction=async()=>null,lock=null}={}) {
  const calls=[];
  return {calls,accounts:async(keys,options)=>{calls.push({keys,options});return {slot:keys.length>4?103:101,accounts:keys.length===1?[f.accounts()[0]]:keys.length===4?f.accounts():[...f.accounts(),lock.metadata(),lock.account()]};},
    blockTime:async()=>NOW-age,signatures:async()=>rows,transaction,
    streams:async()=>({slot:102,accounts:lock?[{pubkey:META,account:lock.metadata()}]:[]})};
}

test('CPMM packed layout supports either token side and reads fee fields without assuming the pool is a PDA',()=>{
  const f=fixture();for(const [offset,value] of [[341,1n],[349,2n],[357,3n],[365,4n],[397,5n],[405,6n]])f.bytes[0].writeBigUInt64LE(value,offset);
  f.bytes[0][389]=2;f.bytes[0][390]=1;
  for(const mint of [BASE,QUOTE]) {
    const p=decodeCpmmPool(f.accounts()[0],mint,POOL);
    assert.equal(p.lpMint,LP);assert.equal(p.authority,AUTH);assert.equal(p.baseVault,BV);assert.equal(p.quoteVault,QV);
    assert.equal(p.baseFees,9n);assert.equal(p.quoteFees,12n);assert.equal(p.lpReserve,1000n);assert.equal(p.openTime,BigInt(NOW/1000-60));
  }
  assert.equal(observe(f).outstandingLp,'900');
});

test('CPMM rejects wrong owner, executable, discriminator, truncation, padding and unsupported program layouts',()=>{
  for(const mutate of [
    f=>f.owners[0]=TOKEN_PROGRAM,f=>f.bytes[0][0]^=1,f=>f.bytes[0]=f.bytes[0].subarray(0,636),
    f=>f.bytes[0]=Buffer.concat([f.bytes[0],Buffer.alloc(1)]),f=>f.bytes[0][330]=8,
    f=>f.bytes[0][389]=3,f=>f.bytes[0][390]=2,f=>f.bytes[0][391]=1,f=>f.bytes[0][413]=1,f=>f.bytes[0][636]=1,
    f=>publicKeyBytes(BASE).copy(f.bytes[0],232),f=>publicKeyBytes(BASE).copy(f.bytes[0],264),
    f=>f.bytes[0].writeBigUInt64LE(0n,333),
  ]) {const f=fixture();mutate(f);assert.throws(()=>decodeCpmmPool(f.accounts()[0],BASE,POOL),LiquidityEvidenceError);}
  const a=fixture().accounts()[0];assert.throws(()=>decodeCpmmPool({...a,executable:true},BASE,POOL),/ACCOUNT_OWNER/);
  assert.throws(()=>decodeCpmmPool({...a,data:[a.data[0]+'\n','base64']},BASE,POOL),/ACCOUNT_LAYOUT/);
  assert.throws(()=>decodeCpmmPool(a,CREATOR,POOL),/TOKEN_POOL_MISMATCH/);
  for(const status of [1,2,4,8,255]){const f=fixture();f.bytes[0][329]=status;assert.throws(()=>decodeCpmmPool(f.accounts()[0],BASE,POOL),/POOL_NOT_TRADING/);}
});

test('CPMM seed identities, distinct links and sorted token identities are mandatory',()=>{
  for(const offset of [72,104,136]){const f=fixture();publicKeyBytes(CREATOR).copy(f.bytes[0],offset);assert.throws(()=>decodeCpmmPool(f.accounts()[0],BASE,POOL),/POOL_ADDRESS/);}
  for(const mutate of [
    f=>publicKeyBytes(BASE).copy(f.bytes[0],296),f=>f.bytes[0].fill(0,8,40),
    f=>{publicKeyBytes(QUOTE).copy(f.bytes[0],168);publicKeyBytes(BASE).copy(f.bytes[0],200);},
  ]){const f=fixture();mutate(f);assert.throws(()=>decodeCpmmPool(f.accounts()[0],BASE,POOL),/ACCOUNT_LAYOUT/);}
  assert.throws(()=>decodeCpmmPool(fixture().accounts()[0],BASE,CREATOR),/POOL_ADDRESS/);
});

test('CPMM rejects altered LP permissions, authority, vault linkage, fees consuming balances and inflated supply',()=>{
  for(const mutate of [
    f=>f.bytes[0][328]=254,f=>f.owners[1]=RAYDIUM_CPMM,f=>f.owners[2]=RAYDIUM_CPMM,
    f=>f.bytes[1][45]=0,f=>f.bytes[1][44]=8,f=>f.bytes[1].writeUInt32LE(1,46),
    f=>publicKeyBytes(CREATOR).copy(f.bytes[1],4),f=>f.bytes[1].writeBigUInt64LE(1001n,36),
    f=>publicKeyBytes(QUOTE).copy(f.bytes[2]),f=>publicKeyBytes(CREATOR).copy(f.bytes[3],32),
    f=>f.bytes[2][108]=2,f=>f.bytes[2].writeUInt32LE(1,72),f=>f.bytes[3].writeUInt32LE(1,129),
    f=>f.bytes[2].writeBigUInt64LE(0n,64),f=>f.bytes[0].writeBigUInt64LE(100n,341),
    f=>{f.bytes[0].writeBigUInt64LE(50n,349);f.bytes[0].writeBigUInt64LE(30n,365);f.bytes[0].writeBigUInt64LE(20n,405);},
  ]){const f=fixture();mutate(f);assert.throws(()=>observe(f),LiquidityEvidenceError);}
});

test('CPMM supply gaps, zero supply alone and absent lock custody never qualify protection',async()=>{
  for(const supply of [0n,1n,900n,1000n]) {
    const f=fixture(supply),o=observe(f);
    assert.equal(o.burnHistory,'unknown');assert.equal(o.protectionRequirement,'unknown');
    const result=await createLiquidityData({rpc:rpc(f),now:()=>NOW}).check(snapshot(),{verifyProtection:true});
    assert.equal(result.reason,null);assert.equal(result.protectionRequirement,'unknown');
    const report=formatLiquidityReport(result);assert.match(report,/Raydium CPMM/);assert.match(report,/100% protected across all pools: unknown/);assert.ok(report.length<4096);
  }
});

test('CPMM burn protection requires an actual successful LP burn and a current snapshot',async()=>{
  for(const [age,mutate,expected] of [[1000,()=>{},'pass'],[120001,()=>{},'unknown'],[1000,tx=>tx.meta.err={InstructionError:[0,'failed']},'unknown'],[1000,tx=>tx.transaction.message.instructions[0].parsed.info.mint=BASE,'unknown']]) {
    const f=fixture(0n),tx=burn();tx.transaction.message.instructions[0].parsed.info.mint=LP;mutate(tx);
    const source=rpc(f,{age,rows:[{signature:sig(2),slot:100,err:null}],transaction:async()=>tx});
    const result=await createLiquidityData({rpc:source,now:()=>NOW}).check(snapshot(),{verifyProtection:true});
    assert.equal(result.protectionRequirement,expected);assert.equal(source.calls[1].options.minContextSlot,101);
    assert.deepEqual(source.calls[1].keys,[POOL,LP,BV,QV]);
  }
});

test('CPMM lock protection rereads exact live LP custody and enforces six remaining calendar months',async()=>{
  for(const [supply,locked,unlock,expected] of [[900n,900n,sixMonthsAfter(NOW),'pass'],[900n,899n,sixMonthsAfter(NOW),'unknown'],[900n,900n,sixMonthsAfter(NOW)-1000,'fail']]) {
    const f=fixture(supply),lock=streamFixture(locked,unlock);publicKeyBytes(LP).copy(lock.data,177);publicKeyBytes(LP).copy(lock.tokens);
    const source=rpc(f,{lock}),result=await createLiquidityData({rpc:source,now:()=>NOW}).check(snapshot(),{verifyProtection:true});
    assert.equal(result.protectionRequirement,expected);assert.equal(source.calls[2].options.minContextSlot,102);
    assert.deepEqual(source.calls[2].keys,[POOL,LP,BV,QV,META,lock.escrow]);
  }
});

test('CPMM future trading start and changed pool links fail before any burn or lock can qualify',async()=>{
  const f=fixture(0n);f.bytes[0].writeBigUInt64LE(BigInt(NOW/1000+1),373);
  const future=await createLiquidityData({rpc:rpc(f),now:()=>NOW}).check(snapshot(),{verifyProtection:true});
  assert.equal(future.reason,'POOL_NOT_TRADING');assert.equal(future.protectionRequirement,'unknown');
  const valid=fixture(0n),source=rpc(valid);const original=source.accounts;
  source.accounts=async(keys,options)=>{const response=await original(keys,options);if(keys.length>1){const p=Buffer.from(response.accounts[0].data[0],'base64');p[328]=254;response.accounts[0]=account(p,RAYDIUM_CPMM);}return response;};
  const changed=await createLiquidityData({rpc:source,now:()=>NOW}).check(snapshot(),{verifyProtection:true});
  assert.equal(changed.reason,'POOL_CHANGED');assert.equal(changed.protectionRequirement,'unknown');
});

test('CPMM trading availability is rechecked in the final lock custody snapshot',async()=>{
  const f=fixture(),lock=streamFixture(900n,sixMonthsAfter(NOW));publicKeyBytes(LP).copy(lock.data,177);publicKeyBytes(LP).copy(lock.tokens);
  const source=rpc(f,{lock}),original=source.accounts;
  source.accounts=async(keys,options)=>{
    if(keys.length>4)f.bytes[0].writeBigUInt64LE(BigInt(NOW/1000+1),373);
    return original(keys,options);
  };
  const result=await createLiquidityData({rpc:source,now:()=>NOW}).check(snapshot(),{verifyProtection:true});
  assert.equal(result.protectionRequirement,'unknown');assert.match(result.protection.reason,/active trading state/);
});
