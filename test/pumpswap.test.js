import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePumpSwapPool, observePumpSwapLp, PUMPSWAP, TOKEN_2022 } from '../src/pumpswap-liquidity.js';
import { publicKeyBytes, publicKeyString, TOKEN_PROGRAM, LiquidityEvidenceError } from '../src/raydium-liquidity.js';
import { createLiquidityData, formatLiquidityReport } from '../src/liquidity.js';
import { createSolanaRpc } from '../src/solana-rpc.js';
import { createResponder } from '../src/commands.js';
import { openAgentStore } from '../src/agent-store.js';

// Address/seed example from the pinned official PumpSwap README. All binary
// payloads, supplies and times below are SYNTHETIC, not observed chain data.
const POOL = 'GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J';
const CA = '7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump';
const QUOTE = 'So11111111111111111111111111111111111111112';
const CREATOR = '9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW';
const LP = '6dpnPD6UWDw5hbJEuPQwnCCMba1JYwHANKuL6GQ6otAH';
const BASE_VAULT = '5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa';
const QUOTE_VAULT = '43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8';
const NOW = 1800000000000;
const account = (data, owner) => ({ owner, executable: false, data: [data.toString('base64'), 'base64'] });
const snapshot = () => ({ address: CA, selected: { address: POOL }, poolCount: 2, selection: 'reported_liquidity', fetchedAt: NOW });
function extended(base, kind, entries) {
  const prefix = Buffer.alloc(166); base.copy(prefix); prefix[165] = kind;
  return Buffer.concat([prefix, ...entries.map(([type, value]) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(value.length,2);
    return Buffer.concat([header,value]);
  })]);
}
function fixture({ supply = 0n, length = 300, extension = false, token2022Vault = false } = {}) {
  const pool = Buffer.alloc(length); Buffer.from([241,154,109,4,17,177,109,188]).copy(pool); pool[8] = 254;
  for (const [key,offset] of [[CREATOR,11],[CA,43],[QUOTE,75],[LP,107],[BASE_VAULT,139],[QUOTE_VAULT,171]]) publicKeyBytes(key).copy(pool,offset);
  pool.writeBigUInt64LE(10_000_000_000n,203);
  let mint = Buffer.alloc(82); mint.writeUInt32LE(1); publicKeyBytes(POOL).copy(mint,4);
  mint.writeBigUInt64LE(supply,36); mint[44] = 9; mint[45] = 1;
  if (extension) mint = extended(mint,1,[[18,Buffer.alloc(64)]]);
  const vault = (key, extra) => {
    const v = Buffer.alloc(165); publicKeyBytes(key).copy(v); publicKeyBytes(POOL).copy(v,32);
    v.writeBigUInt64LE(100_000_000n,64); v[108] = 1;
    return extra ? extended(v,2,[[7,Buffer.alloc(0)]]) : v;
  };
  const bytes = [pool,mint,vault(CA,token2022Vault),vault(QUOTE,false)];
  const owners = [PUMPSWAP,TOKEN_2022,token2022Vault ? TOKEN_2022 : TOKEN_PROGRAM,TOKEN_PROGRAM];
  return { bytes, owners, accounts: () => bytes.map((data,i)=>account(data,owners[i])) };
}
const observe = (f) => { const a = f.accounts(); return observePumpSwapLp(decodePumpSwapPool(a[0],CA,POOL),a.slice(1)); };
const rpc = (f) => ({ accounts: async (keys) => ({ slot: 1234, accounts: keys.length===1 ? [f.accounts()[0]] : f.accounts() }), blockTime: async () => NOW-5000 });

test('documented PumpSwap seed identities decode legacy and appended/padded pool layouts', () => {
  for (const length of [211,243,244,245,261,269,270,271,279,287,300]) {
    const p = decodePumpSwapPool(fixture({length}).accounts()[0],CA,POOL);
    assert.equal(p.authority,POOL); assert.equal(p.lpMint,LP); assert.equal(p.baseVault,BASE_VAULT); assert.equal(p.quoteVault,QUOTE_VAULT);
  }
});

test('zero and nonzero Token-2022 LP balances do not silently qualify protection', () => {
  for (const supply of [0n,1n,9_876_543_210n]) {
    const o = observe(fixture({supply,extension:true,token2022Vault:true}));
    assert.equal(o.outstandingLp,supply.toString()); assert.equal(o.noOutstandingLp,supply===0n);
    assert.equal(o.burnHistory,'unknown'); assert.equal(o.timedLocks,'unknown'); assert.equal(o.protectionRequirement,'unknown');
  }
});

test('spoofed PumpSwap owner, discriminator, PDA seed and token linkage are rejected', () => {
  for (const mutate of [
    f=>{f.owners[0]=TOKEN_PROGRAM;}, f=>{f.bytes[0][0]^=1;}, f=>{f.bytes[0][8]=253;},
    f=>{f.bytes[0][9]=1;}, f=>publicKeyBytes(CA).copy(f.bytes[0],11),
    f=>publicKeyBytes(BASE_VAULT).copy(f.bytes[0],107), f=>f.bytes[0].writeBigUInt64LE(0n,203),
  ]) { const f=fixture(); mutate(f); assert.throws(()=>decodePumpSwapPool(f.accounts()[0],CA,POOL),LiquidityEvidenceError); }
  assert.throws(()=>decodePumpSwapPool(fixture().accounts()[0],publicKeyString(Buffer.alloc(32,2)),POOL),/TOKEN_POOL_MISMATCH/);
  assert.throws(()=>decodePumpSwapPool(fixture().accounts()[0],CA,CA),LiquidityEvidenceError);
});

test('unsupported modes, partial nonzero fields and future unknown fields never use guessed layouts', () => {
  for (const [offset,value,code] of [[243,1,'UNSUPPORTED_POOL_MODE'],[245,1,'UNSUPPORTED_POOL_MODE'],[244,2,'ACCOUNT_LAYOUT'],[299,1,'ACCOUNT_LAYOUT']]) {
    const f=fixture(); f.bytes[0][offset]=value;
    assert.throws(()=>decodePumpSwapPool(f.accounts()[0],CA,POOL),new RegExp(code));
  }
  const f=fixture(); f.bytes[0]=f.bytes[0].subarray(0,250); f.bytes[0][249]=1;
  assert.throws(()=>decodePumpSwapPool(f.accounts()[0],CA,POOL),/ACCOUNT_LAYOUT/);
});

test('financial and unknown Token-2022 extensions are not ignored', () => {
  for (const type of [1,12,14,24,25,26,28,65000]) {
    const f=fixture(); f.bytes[1]=extended(f.bytes[1],1,[[type,Buffer.alloc(32)]]);
    assert.throws(()=>observe(f),/UNSUPPORTED_TOKEN_EXTENSION/);
  }
  const f=fixture(); f.owners[2]=TOKEN_2022; f.bytes[2]=extended(f.bytes[2],2,[[2,Buffer.alloc(8)]]);
  assert.throws(()=>observe(f),/UNSUPPORTED_TOKEN_EXTENSION/);
});

test('TLV truncation, duplicates, wrong account types and noncanonical base64 fail closed', () => {
  for (const mutate of [
    f=>{f.bytes[1]=extended(f.bytes[1],2,[[18,Buffer.alloc(64)]]);},
    f=>{f.bytes[1]=extended(f.bytes[1],1,[[18,Buffer.alloc(63)]]);},
    f=>{f.bytes[1]=extended(f.bytes[1],1,[[18,Buffer.alloc(64)],[18,Buffer.alloc(64)]]);},
    f=>{f.bytes[1]=extended(f.bytes[1],1,[[18,Buffer.alloc(64)]]).subarray(0,200);},
    f=>{f.bytes[1]=extended(f.bytes[1],1,[[18,Buffer.alloc(64)]]); f.bytes[1][100]=1;},
    f=>{f.bytes[1]=Buffer.alloc(355);},
  ]) { const f=fixture(); mutate(f); assert.throws(()=>observe(f),LiquidityEvidenceError); }
  const f=fixture(); const a=f.accounts(); a[1].data[0]+='\n';
  assert.throws(()=>observePumpSwapLp(decodePumpSwapPool(a[0],CA,POOL),a.slice(1)),/ACCOUNT_LAYOUT/);
});

test('optional metadata is bounded, linked to its mint and never treated as supply or lock evidence', () => {
  const metadata=Buffer.alloc(80); publicKeyBytes(LP).copy(metadata,32);
  const f=fixture(); f.bytes[1]=extended(f.bytes[1],1,[[3,Buffer.alloc(32)],[18,Buffer.alloc(64)],[19,metadata]]);
  assert.equal(observe(f).protectionRequirement,'unknown');
  metadata.writeUInt32LE(999999,64); f.bytes[1]=extended(f.bytes[1].subarray(0,82),1,[[19,metadata]]);
  assert.throws(()=>observe(f),/ACCOUNT_LAYOUT/);
});

test('LP close/freeze/mint permissions, vault ownership and inconsistent supply prevent observations', () => {
  for (const mutate of [
    f=>{f.bytes[1]=extended(f.bytes[1],1,[[3,Buffer.alloc(32,1)]]);},
    f=>f.bytes[1].writeUInt32LE(1,46), f=>publicKeyBytes(CA).copy(f.bytes[1],4),
    f=>{f.owners[1]=TOKEN_PROGRAM;}, f=>f.bytes[1].writeBigUInt64LE(10_000_000_001n,36),
    f=>f.bytes[2].writeUInt32LE(1,72), f=>publicKeyBytes(CA).copy(f.bytes[2],32),
    f=>{f.bytes[2][108]=2;}, f=>f.bytes[3].writeBigUInt64LE(0n,64),
  ]) { const f=fixture(); mutate(f); assert.throws(()=>observe(f),LiquidityEvidenceError); }
});

test('reader dispatches by verified program owner and rechecks PumpSwap-linked accounts together', async () => {
  const f=fixture({extension:true,token2022Vault:true}); const calls=[];
  const source=rpc(f); const accounts=source.accounts;
  source.accounts=async (keys,options)=>{calls.push({keys,options}); return accounts(keys,options);};
  const result=await createLiquidityData({rpc:source,now:()=>NOW}).check(snapshot());
  assert.deepEqual(calls[1].keys,[POOL,LP,BASE_VAULT,QUOTE_VAULT]); assert.equal(calls[1].options.minContextSlot,1234);
  assert.equal(result.reason,null); assert.equal(result.observation.noOutstandingLp,true);
  const report=formatLiquidityReport(result);
  assert.match(report,/Pool program: PumpSwap/); assert.match(report,/Snapshot freshness: recent/);
  assert.match(report,/Overall liquidity protection: UNKNOWN/); assert.ok(report.length<4096);
});

test('synthetic PumpSwap RPC-to-Telegram flow preserves the saved full strategy and stopped scan', async (t) => {
  const store=openAgentStore({memory:true}); t.after(()=>store.close());
  const state={revision:2,approved:null,draft:{name:'SYNTHETIC',rules:[],step:6,pendingRequirements:['100% protected; six months remaining; developer holds; exclude confirmed bundles.']}};
  store.put(42,state); const f=fixture({extension:true}); let calls=0;
  const source=createSolanaRpc({fetchImpl:async (_url,options)=>{
    const request=JSON.parse(options.body); calls++;
    return Response.json({jsonrpc:'2.0',id:request.id,result:request.method==='getBlockTime' ? NOW/1000-5 : {
      context:{slot:1234},value:request.params[0].length===1 ? [f.accounts()[0]] : f.accounts(),
    }});
  }});
  const respond=createResponder({agents:store,market:{check:async()=>snapshot()},liquidity:createLiquidityData({rpc:source,now:()=>NOW})});
  const reply=await respond({update_id:123,message:{text:'/liquidity '+CA,from:{id:42,is_bot:false},chat:{id:42,type:'private'}}},new Set([42]));
  assert.equal(calls,4); assert.match(reply.text,/Pool program: PumpSwap/); assert.match(reply.text,/zero outstanding supply/);
  assert.equal(reply.link_preview_options.is_disabled,true); assert.deepEqual(store.get(42),state); assert.equal(store.discoveryGet(42).state,'stopped');
});

