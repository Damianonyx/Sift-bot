// Synthetic protocol-shaped evidence; no live network or safety claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { developerFromCreation } from '../src/wallet-evidence.js';
import { base58Bytes } from '../src/evidence-utils.js';
import { publicKeyBytes } from '../src/raydium-liquidity.js';
import { createRiskData, formatRiskReport, TEST_RISK_RULES } from '../src/risk.js';
import { evaluateRules } from '../src/rules.js';
import { NOW, CA, POOL, DEV, address, sig, b58, snapshot, creation, transaction, trade } from './fixtures/risk.js';

const hint = (overrides={}) => ({ address:CA, provenance:[{source:'pumpportal',kind:'create',receivedAt:NOW,signature:sig(1),...overrides}] });
const liquidity = { check:async()=>({protection:{state:'unknown',reason:'Synthetic unsupported pool',links:[]}}) };
const rpcFor = (overrides={}) => ({
  signatures:async()=>[], transaction:async()=>creation(sig(1),true),
  tokenAccounts:async()=>({slot:102,accounts:[{account:{data:{parsed:{info:{tokenAmount:{amount:'20'}}}}}}]}),
  blockTime:async()=>NOW, ...overrides,
});
const check = (rpc, candidate) => createRiskData({rpc,liquidity,now:()=>NOW}).check(snapshot(),{candidate});

test('Pump v2 attribution requires the exact signed creator, mint and pinned account/argument layout',()=>{
  const tx=creation(sig(1),true);
  assert.equal(developerFromCreation(tx,CA),DEV);
  // All supported boolean values are legal; their presence says nothing about risk.
  const flags=structuredClone(tx), ix=flags.transaction.message.instructions[0], bytes=base58Bytes(ix.data);
  for(const offset of [11,10,1])bytes[bytes.length-offset]=1;
  ix.data=b58(bytes);assert.equal(developerFromCreation(flags,CA),DEV);
  const edits=[
    t=>{t.meta.err={InstructionError:[0,'failed']};},
    t=>{t.transaction.message.accountKeys[0].signer=false;},
    t=>{t.transaction.message.accountKeys[1].signer=false;},
    t=>{t.transaction.message.instructions[0].accounts[0]=address(99);},
    t=>{t.transaction.message.instructions[0].accounts[5]=address(99);},
    t=>{t.transaction.message.instructions[0].accounts[7]=address(99);},
    t=>{t.transaction.message.instructions[0].accounts[9]=address(99);},
    t=>{t.transaction.message.instructions[0].accounts[15]=address(99);},
    t=>{t.transaction.message.instructions[0].accounts.push(DEV);},
    t=>{t.transaction.message.instructions[0].programId=address(99);},
    ...[b=>b.subarray(0,b.length-1),b=>Buffer.concat([b,Buffer.from([0])]),
      b=>{b[b.length-11]=2;return b;},b=>{b[b.length-10]=2;return b;},b=>{b[b.length-1]=2;return b;},
      b=>{b.writeUInt32LE(0xffffffff,8);return b;}].map(change=>t=>{
        const instruction=t.transaction.message.instructions[0];instruction.data=b58(change(base58Bytes(instruction.data)));
      }),
  ];
  for(const edit of edits){const bad=structuredClone(tx);edit(bad);assert.equal(developerFromCreation(bad,CA),null);}
});

test('conflicting signed creator instructions cannot establish a single developer',()=>{
  const tx=creation(sig(1),true), other=address(99), ix=structuredClone(tx.transaction.message.instructions[0]);
  const bytes=base58Bytes(ix.data);publicKeyBytes(other).copy(bytes,bytes.length-43);ix.data=b58(bytes);ix.accounts[5]=other;
  tx.transaction.message.accountKeys.push({pubkey:other,signer:true});tx.transaction.message.instructions.push(ix);
  assert.equal(developerFromCreation(tx,CA),null);
  const classic=creation();classic.transaction.message.instructions[0].accounts[13]=address(99);
  assert.equal(developerFromCreation(classic,CA),null);
  assert.equal(developerFromCreation(creation(),CA),DEV);
});

test('launch signature can locate finalized v2 creation outside recent mint history',async()=>{
  const visited=[];
  const result=await check(rpcFor({signatures:async a=>{visited.push(a);return [];}}),hint());
  assert.equal(result.developerHolding.state,'pass');assert.equal(result.developerHolding.wallet,DEV);
  assert.match(result.creationLookup,/verified against a finalized/);
  assert.deepEqual(visited,[DEV,POOL]);assert.equal(result.buyingCoordination.state,'unknown');
  assert.equal(evaluateRules(TEST_RISK_RULES,{...snapshot(),risk:result},{now:NOW}).matches,false);
});

test('stale, foreign, migration and malformed feed hints never trigger a creation lookup',async()=>{
  const candidates=[hint({receivedAt:NOW-1200001}),hint({receivedAt:NOW+1}),hint({receivedAt:'now'}),
    hint({kind:'migrate'}),hint({source:'geckoterminal'}),hint({signature:CA}),{...hint(),address:address(99)}];
  for(const candidate of candidates){
    const result=await check(rpcFor({transaction:async()=>assert.fail('Untrusted hint fetched')}),candidate);
    assert.equal(result.developerHolding.state,'unknown');assert.equal(result.creationLookup,undefined);
  }
});

test('hint labels cannot replace missing, failed, wrong-mint or mismatched transaction proof',async()=>{
  const failed=creation(sig(1),true);failed.meta.err={failed:true};
  const wrongMint=creation(sig(1),true);wrongMint.transaction.message.instructions[0].accounts[0]=address(99);
  for(const body of [null,failed,wrongMint,creation(sig(2),true)]){
    const result=await check(rpcFor({transaction:async()=>body,tokenAccounts:async()=>assert.fail('No verified creator')}),hint({creator:DEV}));
    assert.equal(result.developerHolding.state,'unknown');assert.match(result.creationLookup,/unverified/);
    assert.deepEqual(result.coverage.map(c=>c.role),['Mint','Pool']);
  }
});

test('unverified creation hint falls back to recent history, and current balances are still mandatory',async()=>{
  const rpc=rpcFor({signatures:async a=>a===CA?[{signature:sig(2),slot:100,err:null}]:[],
    transaction:async s=>s===sig(1)?null:creation(sig(2)),blockTime:async()=>NOW-120001});
  const result=await check(rpc,hint());assert.equal(result.developerHolding.state,'unknown');
  assert.match(result.developerHolding.reason,/current finalized token balance/);assert.equal(result.coverage[0].read,1);
});

test('pool reads retain reserved capacity after full mint and creator histories',async()=>{
  const rows=(start)=>Array.from({length:20},(_,i)=>({signature:sig(start+i),slot:100,err:null}));
  const bodies=new Map();
  for(const row of [...rows(1),...rows(21),...rows(41)])bodies.set(row.signature,transaction(row.signature));
  bodies.set(sig(1),creation());bodies.set(sig(41),trade(trade(transaction(sig(41)),'buy',DEV),'buy',address(10),40));
  const reads=[];
  const result=await check(rpcFor({signatures:async a=>rows(a===CA?1:a===DEV?21:41),
    transaction:async s=>{reads.push(s);return bodies.get(s);}}));
  assert.equal(result.developerHolding.state,'pass');assert.equal(result.buyingCoordination.state,'fail');
  assert.equal(reads.length,40);assert.ok(reads.includes(sig(41)));
  assert.deepEqual(result.coverage.map(c=>[c.role,c.read,c.omitted]),[['Mint',20,0],['Creator',10,10],['Pool',10,10]]);
  assert.match(formatRiskReport(result),/Pool: sampled; 10\/20 verified/);
});

test('verified evidence survives missing bodies and interrupted history; shared signatures are cached',async()=>{
  const rows=[{signature:sig(1),slot:100,err:null},{signature:sig(2),slot:100,err:null},
    {signature:sig(3),slot:100,err:{failed:true}},{signature:sig(4),slot:100,err:null},
    {signature:sig(5),slot:100,err:null}];
  const atomic=trade(trade(creation(),'buy',DEV),'buy',address(10),40), calls=[];
  const result=await check(rpcFor({signatures:async()=>rows,transaction:async s=>{
    calls.push(s);if(s===sig(1))return atomic;if(s===sig(2))return null;throw Error('PRIVATE_RPC_DETAIL');
  }}));
  assert.equal(result.developerHolding.state,'pass');assert.equal(result.buyingCoordination.state,'fail');
  assert.deepEqual(calls,[sig(1),sig(2),sig(4)]);
  assert.ok(result.coverage.every(c=>c.state==='interrupted'&&c.read===1&&c.missing===2&&c.failed===1&&c.omitted===1));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_RPC_DETAIL/);
});

test('unavailable history stays visible and cannot produce a coverage pass',async()=>{
  const result=await check(rpcFor({signatures:async()=>{throw Error('PRIVATE_RPC_DETAIL');}}));
  assert.equal(result.developerHolding.state,'unknown');assert.equal(result.buyingCoordination.state,'unknown');
  assert.ok(result.coverage.every(c=>c.state==='unavailable'));
  assert.match(formatRiskReport(result),/Mint: unavailable/);assert.match(formatRiskReport(result),/Pool: unavailable/);
});

test('detailed risk report with three evidence events and full coverage fits Telegram',async()=>{
  const sale=trade(trade(trade(transaction(sig(2)),'sell'),'sell',DEV,40),'sell',DEV,50);
  const result=await check(rpcFor({signatures:async a=>a===DEV?[{signature:sig(2),slot:100,err:null}]:[],
    transaction:async s=>s===sig(1)?creation(sig(1),true):sale}),hint());
  const text=formatRiskReport(result);assert.equal(result.events.length,3);assert.ok(text.length<=4000,text.length);
  assert.match(text,/Partial sales/);assert.match(text,/never sold/);
});
