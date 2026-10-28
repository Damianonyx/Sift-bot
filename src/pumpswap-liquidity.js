import { createHash } from 'node:crypto';
import { publicKeyBytes, publicKeyString, LiquidityEvidenceError, TOKEN_PROGRAM } from './raydium-liquidity.js';

export const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const DISCRIMINATOR = Buffer.from([241,154,109,4,17,177,109,188]);
const ZERO = '11111111111111111111111111111111';
const fail = (code) => { throw new LiquidityEvidenceError(code); };
const key = (bytes, offset) => publicKeyString(bytes.subarray(offset, offset + 32));

function dataOf(account, owners) {
  if (!account) return fail('MISSING_ACCOUNT');
  if (!owners.includes(account.owner) || account.executable !== false) return fail('ACCOUNT_OWNER');
  const encoded = account.data?.[0];
  if (account.data?.[1] !== 'base64' || typeof encoded !== 'string' || encoded.length > 4096) return fail('ACCOUNT_LAYOUT');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return fail('ACCOUNT_LAYOUT');
  return bytes;
}
// Hashes the documented seeds plus the stored bump. This is an address
// identity check; no key derivation, signing or transaction construction occurs.
function derived(seeds, bump) {
  return publicKeyString(createHash('sha256').update(Buffer.concat([
    ...seeds, Buffer.from([bump]), publicKeyBytes(PUMPSWAP), Buffer.from('ProgramDerivedAddress'),
  ])).digest());
}
function matchesLpMint(poolAddress, mint) {
  const seeds = [Buffer.from('pool_lp_mint'), publicKeyBytes(poolAddress)];
  for (let bump = 255; bump >= 0; bump--) if (derived(seeds, bump) === mint) return true;
  return false;
}

export function decodePumpSwapPool(account, mint, address) {
  if (account?.owner !== PUMPSWAP) return fail(account ? 'UNSUPPORTED_POOL' : 'MISSING_ACCOUNT');
  const data = dataOf(account, [PUMPSWAP]);
  if (data.length < 211 || data.length > 1024 || !data.subarray(0, 8).equals(DISCRIMINATOR)) return fail('ACCOUNT_LAYOUT');
  // Official accounts append fields and can be preallocated with zero padding.
  // Missing complete trailing fields have their documented zero/false default.
  // Refuse partial nonzero fields, unknown nonzero tails, and unsupported modes.
  const fields = [[211,32],[243,1],[244,1],[245,16],[261,8],[269,1],[270,1],[271,8],[279,8]];
  for (const [offset, size] of fields) {
    if (data.length > offset && data.length < offset + size && data.subarray(offset).some(Boolean)) return fail('ACCOUNT_LAYOUT');
  }
  for (const offset of [243,244,269,270]) if (data.length > offset && data[offset] > 1) return fail('ACCOUNT_LAYOUT');
  if (data.subarray(287).some(Boolean)) return fail('ACCOUNT_LAYOUT');
  if ((data[243] ?? 0) !== 0) return fail('UNSUPPORTED_MAYHEM_MODE');
  // Signed i128: v2 trades retain fees in the quote vault and subtract them
  // from virtual reserves. Only the remainder after adding those fee buckets
  // identifies boost reserves. Do not mistake ordinary unpaid fees for boost.
  // Source: pump-public-docs @ 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22,
  // VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md; pump-swap-sdk 2.2.0 realQuoteReserves.
  const virtualQuoteReserves = data.length >= 261
    ? (data.readBigInt64LE(253) << 64n) + data.readBigUInt64LE(245) : 0n;
  const protocolFees = data.length >= 279 ? data.readBigUInt64LE(271) : 0n;
  const creatorFees = data.length >= 287 ? data.readBigUInt64LE(279) : 0n;
  const boostReserves = virtualQuoteReserves + protocolFees + creatorFees;
  if (boostReserves < 0n) return fail('INCONSISTENT_QUOTE_RESERVES');
  const pool = { baseMint: key(data, 43), quoteMint: key(data, 75), lpMint: key(data, 107),
    baseVault: key(data, 139), quoteVault: key(data, 171), lpReserve: data.readBigUInt64LE(203), authority: address,
    virtualQuoteReserves, protocolFees, creatorFees, boostReserves };
  if (pool.baseMint !== mint && pool.quoteMint !== mint) return fail('TOKEN_POOL_MISMATCH');
  if (new Set([pool.baseMint,pool.quoteMint,pool.lpMint,pool.baseVault,pool.quoteVault,address]).size !== 6 ||
      [pool.baseMint,pool.quoteMint,pool.lpMint,pool.baseVault,pool.quoteVault,address].includes(ZERO) || pool.lpReserve === 0n) return fail('ACCOUNT_LAYOUT');
  const expected = derived([Buffer.from('pool'), data.subarray(9,11), data.subarray(11,43),
    publicKeyBytes(pool.baseMint), publicKeyBytes(pool.quoteMint)], data[8]);
  if (expected !== address || !matchesLpMint(address, pool.lpMint)) return fail('POOL_ADDRESS');
  return pool;
}

function tokenData(account, kind, mintAddress) {
  const baseLength = kind === 'mint' ? 82 : 165;
  const data = dataOf(account, kind === 'mint' ? [TOKEN_2022] : [TOKEN_PROGRAM, TOKEN_2022]);
  if (data.length === baseLength) return data;
  if (account.owner !== TOKEN_2022 || data.length < 166 || data.length === 355 ||
      data[165] !== (kind === 'mint' ? 1 : 2) || data.subarray(baseLength, 165).some(Boolean)) return fail('ACCOUNT_LAYOUT');
  const seen = new Set();
  for (let offset = 166; offset < data.length;) {
    if (data.subarray(offset).every((byte) => byte === 0)) break;
    if (offset + 4 > data.length) return fail('ACCOUNT_LAYOUT');
    const type = data.readUInt16LE(offset), size = data.readUInt16LE(offset + 2);
    offset += 4;
    if (!type || seen.has(type) || offset + size > data.length) return fail('ACCOUNT_LAYOUT');
    seen.add(type);
    const value = data.subarray(offset, offset + size); offset += size;
    if (kind === 'account') {
      if (type !== 7 || size !== 0) return fail('UNSUPPORTED_TOKEN_EXTENSION'); // ImmutableOwner
    } else if (type === 3) {
      if (size !== 32) return fail('ACCOUNT_LAYOUT');
      if (value.some(Boolean)) return fail('LP_MINT_AUTHORITY'); // MintCloseAuthority must be disabled
    } else if (type === 18) {
      if (size !== 64) return fail('ACCOUNT_LAYOUT'); // MetadataPointer has no supply semantics
    } else if (type === 19) {
      if (size < 80 || key(value, 32) !== mintAddress) return fail('ACCOUNT_LAYOUT');
      // Validate the bounded Borsh strings/vector without using metadata text/URLs.
      let cursor = 64;
      const string = () => {
        if (cursor + 4 > value.length) return fail('ACCOUNT_LAYOUT');
        const length = value.readUInt32LE(cursor); cursor += 4;
        if (length > value.length - cursor) return fail('ACCOUNT_LAYOUT');
        cursor += length;
      };
      string(); string(); string();
      if (cursor + 4 > value.length) return fail('ACCOUNT_LAYOUT');
      const pairs = value.readUInt32LE(cursor); cursor += 4;
      if (pairs > Math.floor((value.length - cursor) / 8)) return fail('ACCOUNT_LAYOUT');
      for (let i = 0; i < pairs; i++) { string(); string(); }
      if (cursor !== value.length) return fail('ACCOUNT_LAYOUT');
    } else return fail('UNSUPPORTED_TOKEN_EXTENSION');
  }
  return data.subarray(0, baseLength);
}

export function observePumpSwapLp(pool, [mintAccount, baseAccount, quoteAccount]) {
  const mint = tokenData(mintAccount, 'mint', pool.lpMint);
  if (mint[45] !== 1 || mint.readUInt32LE(0) !== 1 || key(mint,4) !== pool.authority || mint.readUInt32LE(46) !== 0) return fail('LP_MINT_AUTHORITY');
  const supply = mint.readBigUInt64LE(36);
  if (supply > pool.lpReserve) return fail('INCONSISTENT_LP_SUPPLY');
  let quoteBalance;
  for (const [account, expected] of [[baseAccount,pool.baseMint],[quoteAccount,pool.quoteMint]]) {
    const data = tokenData(account, 'account');
    if (key(data,0) !== expected || key(data,32) !== pool.authority || data[108] !== 1 ||
        data.readUInt32LE(72) !== 0 || data.readUInt32LE(129) !== 0) return fail('VAULT_AUTHORITY');
    if (data.readBigUInt64LE(64) === 0n) return fail('EMPTY_VAULT');
    if (expected === pool.quoteMint) quoteBalance = data.readBigUInt64LE(64);
  }
  // Pending protocol/creator fees are sweepable claims, not LP liquidity.
  // Effective reserves are pricing quantities and must not be called cash.
  const realQuoteReserves = quoteBalance - pool.protocolFees - pool.creatorFees;
  const effectiveQuoteReserves = quoteBalance + pool.virtualQuoteReserves;
  if (realQuoteReserves <= 0n || effectiveQuoteReserves <= 0n || effectiveQuoteReserves > (1n << 64n) - 1n)
    return fail('INCONSISTENT_QUOTE_RESERVES');
  return { outstandingLp: supply.toString(), recordedLp: pool.lpReserve.toString(), lpDecimals: mint[44],
    noOutstandingLp: supply === 0n, burnHistory: 'unknown', timedLocks: 'unknown', protectionRequirement: 'unknown',
    ...(pool.boostReserves > 0n ? { protectionUnsupported: 'PUMPSWAP_BOOST' } : {}),
    quoteReserves: { mint: pool.quoteMint, rawBalance: quoteBalance.toString(), virtual: pool.virtualQuoteReserves.toString(),
      protocolFees: pool.protocolFees.toString(), creatorFees: pool.creatorFees.toString(),
      real: realQuoteReserves.toString(), effective: effectiveQuoteReserves.toString(), boost: pool.boostReserves.toString() } };
}
