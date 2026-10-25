import { createHash } from 'node:crypto';
import { publicKeyBytes, publicKeyString, observeLpAccounts, TOKEN_PROGRAM, LiquidityEvidenceError } from './raydium-liquidity.js';

export const RAYDIUM_CPMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const DISCRIMINATOR=createHash('sha256').update('account:PoolState').digest().subarray(0,8);
const ZERO='11111111111111111111111111111111';
const fail=code=>{throw new LiquidityEvidenceError(code);};
const key=(data,offset)=>publicKeyString(data.subarray(offset,offset+32));
const derived=(seeds,bump)=>publicKeyString(createHash('sha256').update(Buffer.concat([
  ...seeds,Buffer.from([bump]),publicKeyBytes(RAYDIUM_CPMM),Buffer.from('ProgramDerivedAddress'),
])).digest());
function matches(seeds,address){for(let bump=255;bump>=0;bump--)if(derived(seeds,bump)===address)return true;return false;}

// Exact packed PoolState layout and seeds from the official Raydium program:
// raydium-io/raydium-cp-swap @ f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5.
// Pool accounts may be canonical PDAs OR signed random accounts; LP mint and
// vault addresses must still match the documented pool-specific PDA seeds.
export function decodeCpmmPool(account,mint,address) {
  if(!account)return fail('MISSING_ACCOUNT');
  if(account.owner!==RAYDIUM_CPMM)return fail('UNSUPPORTED_POOL');
  if(account.executable!==false)return fail('ACCOUNT_OWNER');
  const encoded=account.data?.[0];
  if(account.data?.[1]!=='base64'||typeof encoded!=='string'||encoded.length>4096)return fail('ACCOUNT_LAYOUT');
  const data=Buffer.from(encoded,'base64');
  if(data.length!==637||data.toString('base64')!==encoded||!data.subarray(0,8).equals(DISCRIMINATOR))return fail('ACCOUNT_LAYOUT');
  if(data[329]!==0)return fail('POOL_NOT_TRADING');
  if(data[330]!==9||data[389]>2||data[390]>1||data.subarray(391,397).some(Boolean)||data.subarray(413).some(Boolean))return fail('ACCOUNT_LAYOUT');
  if(key(data,232)!==TOKEN_PROGRAM||key(data,264)!==TOKEN_PROGRAM)return fail('UNSUPPORTED_TOKEN_PROGRAM');
  const pool={baseVault:key(data,72),quoteVault:key(data,104),lpMint:key(data,136),baseMint:key(data,168),quoteMint:key(data,200),
    lpReserve:data.readBigUInt64LE(333),openTime:data.readBigUInt64LE(373),lpDecimals:9,
    baseFees:data.readBigUInt64LE(341)+data.readBigUInt64LE(357)+data.readBigUInt64LE(397),
    quoteFees:data.readBigUInt64LE(349)+data.readBigUInt64LE(365)+data.readBigUInt64LE(405)};
  if(pool.baseMint!==mint&&pool.quoteMint!==mint)return fail('TOKEN_POOL_MISMATCH');
  const links=[address,pool.baseVault,pool.quoteVault,pool.lpMint,pool.baseMint,pool.quoteMint,key(data,8),key(data,296)];
  if(new Set(links).size!==links.length||links.includes(ZERO)||pool.lpReserve===0n||
    Buffer.compare(publicKeyBytes(pool.baseMint),publicKeyBytes(pool.quoteMint))>=0)return fail('ACCOUNT_LAYOUT');
  pool.authority=derived([Buffer.from('vault_and_lp_mint_auth_seed')],data[328]);
  const bytes=publicKeyBytes(address);
  if(!matches([Buffer.from('pool_lp_mint'),bytes],pool.lpMint)||
    !matches([Buffer.from('pool_vault'),bytes,publicKeyBytes(pool.baseMint)],pool.baseVault)||
    !matches([Buffer.from('pool_vault'),bytes,publicKeyBytes(pool.quoteMint)],pool.quoteVault))return fail('POOL_ADDRESS');
  return pool;
}

export function observeCpmmLp(pool,accounts) {
  // Reuse the strict classic SPL mint/vault permission checks. A supply gap
  // includes the unissued 100-unit initialization minimum; it is NOT a burn.
  const observation=observeLpAccounts(pool,accounts);
  if(observation.lpDecimals!==pool.lpDecimals)return fail('ACCOUNT_LAYOUT');
  for(const [account,fees] of [[accounts[1],pool.baseFees],[accounts[2],pool.quoteFees]]) {
    const amount=Buffer.from(account.data[0],'base64').readBigUInt64LE(64);
    if(amount<=fees)return fail('EMPTY_VAULT');
  }
  return observation;
}
