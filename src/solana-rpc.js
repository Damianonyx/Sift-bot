import { isSolanaAddress } from './market.js';
import { STREAMFLOW, TOKEN_PROGRAMS, rawAmount, base58Bytes } from './evidence-utils.js';

export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export class SolanaRpcError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Solana data unavailable (${code}).`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const RPC_FAILURES = new Map([
  ['RATE_LIMITED', 'Solana RPC rate limit reached; wait before retrying.'],
  ['COOLDOWN', 'Evidence checks are temporarily limited; wait before retrying.'],
  ['TIMED_OUT', 'Solana RPC request timed out.'],
  ['STOPPED', 'Evidence check was stopped or reached its time limit.'],
  ['SOURCE_UNAVAILABLE', 'Solana RPC was unavailable or denied access.'],
  ['INVALID_RESPONSE', 'Solana RPC returned an unusable or mismatched response.'],
  ['NETWORK_OR_RESPONSE', 'Solana RPC could not be reached or read.'],
]);
// Fixed messages only: provider bodies, URLs and arbitrary error strings never
// enter Telegram reports. Unsupported error codes remain explicitly unknown.
export const rpcFailureReason = error => error instanceof SolanaRpcError
  ? RPC_FAILURES.get(error.code) ?? 'RPC evidence failed; the cause was not classified.'
  : 'Evidence read failed; the cause was not classified.';

async function readJson(response) {
  if (!response.body) throw new SolanaRpcError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw new SolanaRpcError('INVALID_RESPONSE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SolanaRpcError('INVALID_RESPONSE'); }
}

// Only bounded, read-only methods at the public mainnet endpoint. No generic
// RPC proxy, account credentials, transaction submission or paid fallback.
export function createSolanaRpc({ fetchImpl = fetch, now = Date.now } = {}) {
  let requestId = 0, nextAllowedAt = 0;
  async function request(method, params, signal) {
    if (signal?.aborted) throw new SolanaRpcError('STOPPED');
    if (now() < nextAllowedAt) throw new SolanaRpcError('RATE_LIMITED', Math.ceil((nextAllowedAt - now()) / 1000));
    const id = ++requestId;
    const timeout = AbortSignal.timeout(8000);
    try {
      const response = await fetchImpl(RPC_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const seconds = /^\d+$/.test(header ?? '') ? Number(header) : (Date.parse(header) - now()) / 1000;
          const retry = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
          nextAllowedAt = now() + retry * 1000;
          throw new SolanaRpcError('RATE_LIMITED', retry);
        }
        throw new SolanaRpcError('SOURCE_UNAVAILABLE');
      }
      const payload = await readJson(response);
      if (signal?.aborted) throw new SolanaRpcError('STOPPED');
      if (payload?.jsonrpc !== '2.0' || payload.id !== id || payload.error || !Object.hasOwn(payload, 'result')) {
        throw new SolanaRpcError('INVALID_RESPONSE');
      }
      return payload.result;
    } catch (error) {
      if (signal?.aborted) throw new SolanaRpcError('STOPPED');
      if (error instanceof SolanaRpcError) throw error;
      if (timeout.aborted || error?.name === 'TimeoutError') throw new SolanaRpcError('TIMED_OUT');
      throw new SolanaRpcError('NETWORK_OR_RESPONSE');
    }
  }
  return {
    async accounts(addresses, { signal, minContextSlot } = {}) {
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 44 || !addresses.every(isSolanaAddress) ||
          (minContextSlot !== undefined && (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0))) {
        throw new SolanaRpcError('INVALID_REQUEST');
      }
      const result = await request('getMultipleAccounts', [addresses, {
        encoding: 'base64', commitment: 'finalized', ...(minContextSlot === undefined ? {} : { minContextSlot }),
      }], signal);
      const slot = result?.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || slot < (minContextSlot ?? 0) ||
          !Array.isArray(result.value) || result.value.length !== addresses.length) throw new SolanaRpcError('INVALID_RESPONSE');
      for (const value of result.value) {
        if (value !== null && (!isSolanaAddress(value?.owner) || typeof value.executable !== 'boolean' ||
            !Array.isArray(value.data) || value.data.length !== 2 || value.data[1] !== 'base64' ||
            typeof value.data[0] !== 'string' || value.data[0].length > 4096)) throw new SolanaRpcError('INVALID_RESPONSE');
      }
      return { slot, accounts: result.value };
    },
    async signatures(address, { signal } = {}) {
      if (!isSolanaAddress(address)) throw new SolanaRpcError('INVALID_REQUEST');
      const rows = await request('getSignaturesForAddress', [address, { commitment: 'finalized', limit: 20 }], signal);
      if (!Array.isArray(rows) || rows.length > 20 || rows.some((r) =>
        base58Bytes(r?.signature, 64)?.length !== 64 || !Number.isSafeInteger(r.slot) || r.slot < 0 ||
        !Object.hasOwn(r, 'err') || r.confirmationStatus !== 'finalized') ||
        new Set(rows.map((r) => r.signature)).size !== rows.length) throw new SolanaRpcError('INVALID_RESPONSE');
      return rows;
    },
    async transaction(signature, { signal } = {}) {
      if (base58Bytes(signature, 64)?.length !== 64) throw new SolanaRpcError('INVALID_REQUEST');
      const tx = await request('getTransaction', [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], signal);
      if (tx === null) return null;
      if (!Number.isSafeInteger(tx?.slot) || tx.slot < 0 || !tx.meta || !Object.hasOwn(tx.meta, 'err') ||
        tx.transaction?.signatures?.[0] !== signature || !Array.isArray(tx.transaction?.message?.accountKeys) ||
        !Array.isArray(tx.transaction.message.instructions)) throw new SolanaRpcError('INVALID_RESPONSE');
      return tx;
    },
    async tokenAccounts(owner, mint, { signal, minContextSlot = 0 } = {}) {
      if (![owner, mint].every(isSolanaAddress) || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) throw new SolanaRpcError('INVALID_REQUEST');
      const result = await request('getTokenAccountsByOwner', [owner, { mint }, { commitment: 'finalized', encoding: 'jsonParsed', minContextSlot }], signal);
      if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < minContextSlot || !Array.isArray(result.value) || result.value.length > 100) throw new SolanaRpcError('INVALID_RESPONSE');
      const seen = new Set();
      for (const row of result.value) {
        const info = row.account?.data?.parsed?.info;
        if (!isSolanaAddress(row.pubkey) || seen.has(row.pubkey) || row.account.executable !== false ||
          !TOKEN_PROGRAMS.includes(row.account.owner) ||
          !['spl-token', 'spl-token-2022'].includes(row.account.data.program) || info?.mint !== mint || info?.owner !== owner ||
          !['initialized', 'frozen'].includes(info.state) || !rawAmount(info.tokenAmount?.amount)) throw new SolanaRpcError('INVALID_RESPONSE');
        seen.add(row.pubkey);
      }
      return { slot: result.context.slot, accounts: result.value };
    },
    async streams(mint, { signal, minContextSlot = 0 } = {}) {
      if (!isSolanaAddress(mint) || !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) throw new SolanaRpcError('INVALID_REQUEST');
      const result = await request('getProgramAccounts', [STREAMFLOW, { commitment: 'finalized', encoding: 'base64', withContext: true,
        minContextSlot, filters: [{ dataSize: 1104 }, { memcmp: { offset: 177, bytes: mint } }] }], signal);
      if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < minContextSlot || !Array.isArray(result.value) || result.value.length > 20 ||
          result.value.some((row) => !isSolanaAddress(row?.pubkey)) || new Set(result.value.map((r) => r.pubkey)).size !== result.value.length) throw new SolanaRpcError('INVALID_RESPONSE');
      return { slot: result.context.slot, accounts: result.value };
    },
    async blockTime(slot, { signal } = {}) {
      if (!Number.isSafeInteger(slot) || slot < 0) throw new SolanaRpcError('INVALID_REQUEST');
      const result = await request('getBlockTime', [slot], signal);
      if (result !== null && (!Number.isSafeInteger(result) || result <= 0 || !Number.isSafeInteger(result * 1000))) {
        throw new SolanaRpcError('INVALID_RESPONSE');
      }
      return result === null ? null : result * 1000;
    },
  };
}

