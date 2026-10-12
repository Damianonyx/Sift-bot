import { isSolanaAddress } from './market.js';

export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export class SolanaRpcError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Solana data unavailable (${code}).`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Only bounded, read-only methods at the public mainnet endpoint. No generic
// RPC proxy, account credentials, transaction submission or paid fallback.
export function createSolanaRpc({ fetchImpl = fetch, now = Date.now } = {}) {
  let requestId = 0, nextAllowedAt = 0;
  async function request(method, params, signal) {
    if (signal?.aborted) throw new SolanaRpcError('STOPPED');
    if (now() < nextAllowedAt) throw new SolanaRpcError('RATE_LIMITED', Math.ceil((nextAllowedAt - now()) / 1000));
    const id = ++requestId;
    try {
      const timeout = AbortSignal.timeout(8000);
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
      throw new SolanaRpcError('NETWORK_OR_RESPONSE');
    }
  }
  return {
    async accounts(addresses, { signal, minContextSlot } = {}) {
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 4 || !addresses.every(isSolanaAddress) ||
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
