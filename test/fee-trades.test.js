import test from 'node:test';
import assert from 'node:assert/strict';
import { pumpSwapTrades, developerActivity, buyingEvidence } from '../src/wallet-evidence.js';
import { createBundleData } from '../src/bundle-evidence.js';
import { CA, DEV, POOL, address, sig, transaction, trade, withFee, snapshot, b58 } from './fixtures/risk.js';
import { base58Bytes, discriminator } from '../src/evidence-utils.js';

test('direct Pump fee reads preserve verified developer sales and coordinated buys', () => {
  for (const variant of ['get_fees', 'get_fees_with_quote_mint']) {
    const sale = withFee(trade(transaction(), 'sell'), variant);
    assert.equal(pumpSwapTrades(sale, CA)[0].side, 'sale');
    assert.deepEqual(developerActivity([{signature:sig(1),tx:sale}], CA, DEV).map(e=>e.kind), ['sale']);
    const buys = withFee(trade(trade(transaction()), 'buy', address(9), 40), variant);
    assert.equal(buyingEvidence([{signature:sig(1),tx:buys}], CA, POOL).state, 'fail');
  }
});

test('unrelated fee accounts, nested calls, bad payloads and unknown programs remain unsupported', () => {
  for (const mutate of [
    (ix)=>ix.stackHeight=3, (ix)=>ix.accounts[0]=address(12), (ix)=>ix.accounts[1]=address(13),
    (ix)=>ix.accounts.push(address(14)), (ix)=>ix.programId=address(15),
    (ix)=>ix.data=b58(Buffer.concat([discriminator('set_fees'),Buffer.alloc(26)])),
    (ix)=>ix.data=b58(base58Bytes(ix.data).subarray(0,32)),
    (ix)=>{const b=base58Bytes(ix.data);b[8]=2;ix.data=b58(b);},
    (ix)=>{const b=base58Bytes(ix.data);b[33]=2;ix.data=b58(b);},
  ]) {
    const sale = withFee(trade(transaction(), 'sell'));
    mutate(sale.meta.innerInstructions[0].instructions[0]);
    assert.equal(pumpSwapTrades(sale, CA).length, 0);
  }
  const wrongQuote=withFee(trade(transaction()),'get_fees_with_quote_mint');
  const ix=wrongQuote.meta.innerInstructions[0].instructions[0],bytes=base58Bytes(ix.data);bytes[25]^=1;ix.data=b58(bytes);
  assert.equal(pumpSwapTrades(wrongQuote,CA).length,0);
  const legacy=withFee(trade(transaction(),'sell'));
  const fee=legacy.meta.innerInstructions[0].instructions[0];fee.data=b58(base58Bytes(fee.data).subarray(0,33));
  assert.equal(pumpSwapTrades(legacy,CA)[0].side,'sale');
});

test('a supplied finalized Jito bundle containing a fee-bearing buy is excluded', async () => {
  const id='a'.repeat(64);
  const source=createBundleData({
    rpc:{transaction:async()=>withFee(trade(transaction()))},
    fetchImpl:async()=>Response.json({jsonrpc:'2.0',id:1,result:{value:[{
      bundle_id:id,confirmation_status:'finalized',err:{Ok:null},slot:100,transactions:[sig(1)],
    }]}}),
  });
  assert.equal((await source.check(snapshot(),id)).state,'fail');
});
