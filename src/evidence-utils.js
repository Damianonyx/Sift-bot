import { createHash } from 'node:crypto';
import { publicKeyBytes, publicKeyString, TOKEN_PROGRAM } from './raydium-liquidity.js';
import { TOKEN_2022 } from './pumpswap-liquidity.js';

export const STREAMFLOW = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022];
export const unknown = (reason) => ({ state: 'unknown', reason, links: [] });
export const rawAmount = (v) => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
export const txLink = (signature) => `https://solscan.io/tx/${signature}`;
export const accountLink = (address) => `https://solscan.io/account/${address}`;

export function sixMonthsAfter(time) {
  const date = new Date(time);
  if (!Number.isSafeInteger(time) || !Number.isFinite(date.getTime())) throw new Error('Invalid check time');
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 6);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}

export function base58Bytes(text, max = 2048) {
  if (typeof text !== 'string' || !text.length || text.length > max * 2 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) return null;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const c of text) value = value * 58n + BigInt(alphabet.indexOf(c));
  let hex = value.toString(16); if (hex.length % 2) hex = '0' + hex;
  const zeroes = text.match(/^1*/)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(zeroes), value ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
  return bytes.length <= max ? bytes : null;
}
export const discriminator = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
export function instructionIs(ix, program, name) {
  const bytes = base58Bytes(ix?.data);
  return ix?.programId === program && bytes?.subarray(0, 8).equals(discriminator(name));
}
export function instructions(tx) {
  return [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? [])];
}
export function successful(tx) {
  return tx?.meta?.err === null && Number.isSafeInteger(tx.slot) && tx.slot >= 0 &&
    Array.isArray(tx.transaction?.message?.instructions) && Array.isArray(tx.transaction.message.accountKeys);
}
export function signer(tx, address) {
  return tx.transaction.message.accountKeys.some((key) => key.pubkey === address && key.signer === true);
}
export function accountBytes(account, owner, size) {
  if (account?.owner !== owner || account.executable !== false || account.data?.[1] !== 'base64' || typeof account.data[0] !== 'string') throw new Error('Account identity');
  const data = Buffer.from(account.data[0], 'base64');
  if (data.toString('base64') !== account.data[0] || data.length !== size) throw new Error('Account layout');
  return data;
}
export const keyAt = (bytes, offset) => publicKeyString(bytes.subarray(offset, offset + 32));
export function matchesPda(address, program, seeds) {
  // A matching address plus program-owned metadata and escrow authority are
  // required. Hash matching alone is never accepted as proof of a lock.
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash('sha256').update(Buffer.concat([...seeds, Buffer.from([bump]), publicKeyBytes(program), Buffer.from('ProgramDerivedAddress')])).digest();
    if (publicKeyString(hash) === address) return true;
  }
  return false;
}
