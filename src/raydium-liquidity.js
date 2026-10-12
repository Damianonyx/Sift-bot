import { createHash } from 'node:crypto';
import { isSolanaAddress } from './market.js';

export const RAYDIUM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export class LiquidityEvidenceError extends Error {
  constructor(code) { super(`Liquidity evidence unknown (${code}).`); this.code = code; }
}
const unknown = (code) => { throw new LiquidityEvidenceError(code); };

export function publicKeyBytes(address) {
  if (!isSolanaAddress(address)) return unknown('INVALID_ADDRESS');
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(ALPHABET.indexOf(char));
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}
export function publicKeyString(bytes) {
  if (bytes.length !== 32) return unknown('INVALID_ADDRESS');
  let value = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let result = '';
  while (value) { result = ALPHABET[Number(value % 58n)] + result; value /= 58n; }
  let zeros = 0;
  while (zeros < 32 && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + result;
}
const key = (data, offset) => publicKeyString(data.subarray(offset, offset + 32));
function accountData(account, owner, size) {
  if (!account) return unknown('MISSING_ACCOUNT');
  if (account.owner !== owner || account.executable !== false) return unknown('ACCOUNT_OWNER');
  const encoded = account.data?.[0];
  if (account.data?.[1] !== 'base64' || typeof encoded !== 'string' || encoded.length > 4096) return unknown('ACCOUNT_LAYOUT');
  const data = Buffer.from(encoded, 'base64');
  if (data.length !== size || data.toString('base64') !== encoded) return unknown('ACCOUNT_LAYOUT');
  return data;
}

// Offsets and seed derive from the pinned official program source documented
// in docs/liquidity-evidence.md. Never decode an arbitrary venue as this layout.
export function decodeRaydiumPool(account, mint) {
  if (!account) return unknown('MISSING_ACCOUNT');
  if (account.owner !== RAYDIUM_V4) return unknown('UNSUPPORTED_POOL');
  const data = accountData(account, RAYDIUM_V4, 752);
  const status = data.readBigUInt64LE(0), nonce = data.readBigUInt64LE(8);
  if (![1n, 6n].includes(status)) return unknown('POOL_NOT_TRADING');
  if (nonce > 255n) return unknown('ACCOUNT_LAYOUT');
  const pool = { baseVault: key(data, 336), quoteVault: key(data, 368), baseMint: key(data, 400),
    quoteMint: key(data, 432), lpMint: key(data, 464), lpReserve: data.readBigUInt64LE(720) };
  if (pool.baseMint !== mint && pool.quoteMint !== mint) return unknown('TOKEN_POOL_MISMATCH');
  if (new Set([pool.baseVault, pool.quoteVault, pool.baseMint, pool.quoteMint, pool.lpMint]).size !== 5 ||
      Object.values(pool).includes('11111111111111111111111111111111') || pool.lpReserve === 0n) return unknown('ACCOUNT_LAYOUT');
  pool.authority = publicKeyString(createHash('sha256').update(Buffer.concat([
    Buffer.from('amm authority'), Buffer.from([Number(nonce)]), publicKeyBytes(RAYDIUM_V4), Buffer.from('ProgramDerivedAddress'),
  ])).digest());
  return pool;
}

export function observeLpAccounts(pool, [mintAccount, baseAccount, quoteAccount]) {
  const mint = accountData(mintAccount, TOKEN_PROGRAM, 82);
  if (mint[45] !== 1 || mint.readUInt32LE(0) !== 1 || key(mint, 4) !== pool.authority || mint.readUInt32LE(46) !== 0) {
    return unknown('LP_MINT_AUTHORITY');
  }
  const supply = mint.readBigUInt64LE(36);
  if (supply > pool.lpReserve) return unknown('INCONSISTENT_LP_SUPPLY');
  for (const [account, expectedMint] of [[baseAccount, pool.baseMint], [quoteAccount, pool.quoteMint]]) {
    const data = accountData(account, TOKEN_PROGRAM, 165);
    if (key(data, 0) !== expectedMint || key(data, 32) !== pool.authority || data[108] !== 1 ||
        data.readUInt32LE(72) !== 0 || data.readUInt32LE(129) !== 0) return unknown('VAULT_AUTHORITY');
    if (data.readBigUInt64LE(64) === 0n) return unknown('EMPTY_VAULT');
  }
  // A zero supply is an account observation, not historical proof of a burn.
  // The accounting gap also includes an unissued initialization minimum.
  return { outstandingLp: supply.toString(), recordedLp: pool.lpReserve.toString(),
    lpDecimals: mint[44], noOutstandingLp: supply === 0n,
    burnHistory: 'unknown', timedLocks: 'unknown', protectionRequirement: 'unknown' };
}
