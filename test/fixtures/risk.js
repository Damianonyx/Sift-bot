// SYNTHETIC fixtures only. No live token findings or network calls.
import { createHash } from 'node:crypto';
import { publicKeyString, publicKeyBytes, TOKEN_PROGRAM, RAYDIUM_V4 } from '../../src/raydium-liquidity.js';
import { STREAMFLOW, discriminator, base58Bytes } from '../../src/evidence-utils.js';
import { PUMPSWAP } from '../../src/pumpswap-liquidity.js';
import { PUMP, PUMP_FEE } from '../../src/wallet-evidence.js';
export const NOW = Date.UTC(2026,9,14,12);
export const address = n => publicKeyString(Buffer.alloc(32,n));
export const CA=address(1), POOL=address(2), LP=address(3), DEV=address(4), QUOTE=address(5), BV=address(6), QV=address(7), META=address(8);
export const AUTH='5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
export const account=(bytes,owner)=>({owner,executable:false,data:[bytes.toString('base64'),'base64']});
export function b58(bytes) {
  let n=BigInt('0x'+bytes.toString('hex')), out='';
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while(n){out=chars[Number(n%58n)]+out;n/=58n;}
  let z=0;while(z<bytes.length && bytes[z]===0)z++;
  return '1'.repeat(z)+out;
}
export const sig=n=>b58(Buffer.alloc(64,n));
export const snapshot=()=>({address:CA,selected:{address:POOL,marketCap:40000,liquidityUsd:40000,createdAt:NOW-60000,windows:[{window:'h1',volume:80000}]},poolCount:1,selection:'reported_liquidity',fetchedAt:NOW});
export function poolFixture(supply=0n) {
  const pool=Buffer.alloc(752);pool.writeBigUInt64LE(6n);pool.writeBigUInt64LE(254n,8);
  for(const [a,o] of [[BV,336],[QV,368],[CA,400],[QUOTE,432],[LP,464]])publicKeyBytes(a).copy(pool,o);
  pool.writeBigUInt64LE(1000000n,720);
  const mint=Buffer.alloc(82);mint.writeUInt32LE(1);publicKeyBytes(AUTH).copy(mint,4);mint.writeBigUInt64LE(supply,36);mint[44]=9;mint[45]=1;
  const vault=m=>{const b=Buffer.alloc(165);publicKeyBytes(m).copy(b);publicKeyBytes(AUTH).copy(b,32);b.writeBigUInt64LE(100n,64);b[108]=1;return b;};
  return [account(pool,RAYDIUM_V4),account(mint,TOKEN_PROGRAM),account(vault(CA),TOKEN_PROGRAM),account(vault(QUOTE),TOKEN_PROGRAM)];
}
export function streamFixture(amount=1000n, unlock=Date.UTC(2027,3,14,12)) {
  const escrow=publicKeyString(createHash('sha256').update(Buffer.concat([Buffer.from('strm'),publicKeyBytes(META),Buffer.from([255]),publicKeyBytes(STREAMFLOW),Buffer.from('ProgramDerivedAddress')])).digest());
  const data=Buffer.alloc(1104);data.writeBigUInt64LE(1n);data[8]=1;
  data.writeBigUInt64LE(BigInt(NOW/1000-60),9);
  for(const offset of [33,441])data.writeBigUInt64LE(BigInt(unlock/1000),offset);
  data.writeBigUInt64LE(BigInt(NOW/1000),409);data.writeBigUInt64LE(1n,425);
  for(const offset of [417,449])data.writeBigUInt64LE(amount,offset);
  publicKeyBytes(LP).copy(data,177);publicKeyBytes(escrow).copy(data,209);
  const tokens=Buffer.alloc(165);publicKeyBytes(LP).copy(tokens);publicKeyBytes(escrow).copy(tokens,32);tokens.writeBigUInt64LE(amount,64);tokens[108]=1;
  return {data,tokens,escrow,metadata:()=>account(data,STREAMFLOW),account:()=>account(tokens,TOKEN_PROGRAM)};
}
export const transaction=(signature=sig(1),slot=100)=>({slot,blockTime:NOW/1000,transaction:{signatures:[signature],message:{accountKeys:[],instructions:[]}},meta:{err:null,innerInstructions:[],preTokenBalances:[],postTokenBalances:[]}});
export function creation(signature=sig(1)) {
  const tx=transaction(signature);const fields=['Synthetic','TEST','https://example.invalid'];
  const bytes=Buffer.concat([discriminator('create'),...fields.map(s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);}),publicKeyBytes(DEV)]);
  const accounts=Array.from({length:14},(_,i)=>address(i+20));accounts[0]=CA;accounts[7]=DEV;
  tx.transaction.message.instructions=[{programId:PUMP,accounts,data:b58(bytes)}];
  tx.transaction.message.accountKeys=[{pubkey:DEV,signer:true},{pubkey:CA,signer:true}];return tx;
}
export function trade(tx,side='buy',wallet=DEV,n=30) {
  const accounts=[POOL,wallet,address(18),CA,QUOTE,address(n),address(n+1),BV,QV,...Array.from({length:8},(_,i)=>address(i+60))];
  const index=tx.transaction.message.instructions.length;
  tx.transaction.message.instructions.push({programId:PUMPSWAP,accounts,data:b58(Buffer.concat([discriminator(side),Buffer.alloc(16)]))});
  for(const [a,owner,mint] of [[accounts[5],wallet,CA],[accounts[6],wallet,QUOTE],[BV,POOL,CA],[QV,POOL,QUOTE]]) {
    let accountIndex=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey===a);
    if(accountIndex<0){accountIndex=tx.transaction.message.accountKeys.length;tx.transaction.message.accountKeys.push({pubkey:a,signer:false});}
    tx.meta.preTokenBalances.push({accountIndex,owner,mint,uiTokenAmount:{amount:'1000'}});
  }
  if(!tx.transaction.message.accountKeys.some(k=>k.pubkey===wallet))tx.transaction.message.accountKeys.push({pubkey:wallet,signer:true});
  const transfer=(source,destination)=>({programId:TOKEN_PROGRAM,stackHeight:2,parsed:{type:'transfer',info:{source,destination,amount:'10'}}});
  tx.meta.innerInstructions.push({index,instructions:side==='sell'?[transfer(accounts[5],BV),transfer(QV,accounts[6])]:[transfer(BV,accounts[5]),transfer(accounts[6],QV)]});
  return tx;
}
export function burn(signature=sig(2)) {const tx=transaction(signature);tx.transaction.message.instructions=[{programId:TOKEN_PROGRAM,parsed:{type:'burn',info:{mint:LP,amount:'1000'}}}];return tx;}

// Protocol-shaped synthetic CPI, not a captured mainnet transaction.
export function withFee(tx, variant = 'get_fees') {
  tx.transaction.message.instructions.forEach((ix, index) => {
    const side = base58Bytes(ix.data).subarray(0,8).equals(discriminator('sell')) ? 'sale' : 'buy';
    const configIndex = side === 'sale' ? 19 : 21;
    while (ix.accounts.length <= configIndex + 1) ix.accounts.push(address(90 + ix.accounts.length));
    ix.accounts[configIndex + 1] = PUMP_FEE;
    const args = variant === 'get_fees_with_quote_mint'
      ? Buffer.concat([Buffer.from([1]), Buffer.alloc(16), publicKeyBytes(QUOTE)])
      : Buffer.concat([Buffer.from([1]), Buffer.alloc(24), Buffer.from([0])]);
    tx.meta.innerInstructions.find(g => g.index === index).instructions.unshift({
      programId:PUMP_FEE, stackHeight:2, accounts:[ix.accounts[configIndex], PUMPSWAP],
      data:b58(Buffer.concat([discriminator(variant), args])),
    });
  });
  return tx;
}
