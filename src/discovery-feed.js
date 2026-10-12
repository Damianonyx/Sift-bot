import { isSolanaAddress } from './market.js';

export const FEED_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,dex&page=1';
export const FEED_INTERVAL_MS = 60_000;
export class DiscoveryFeedError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Discovery feed unavailable (${code}).`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function normaliseCandidates(raw, fetchedAt) {
  if (!raw || !Array.isArray(raw.data) || raw.data.length > 100) throw new DiscoveryFeedError('INVALID_RESPONSE');
  const candidates = [];
  const seen = new Set();
  let invalidPools = 0;
  for (const pool of raw.data) {
    const address = pool?.attributes?.address;
    const base = pool?.relationships?.base_token?.data;
    const mint = typeof base?.id === 'string' && base.id.startsWith('solana_') ? base.id.slice(7) : '';
    if (pool?.type !== 'pool' || pool.id !== `solana_${address}` || !isSolanaAddress(address) ||
        base?.type !== 'token' || !isSolanaAddress(mint)) { invalidPools++; continue; }
    if (seen.has(mint)) continue;
    seen.add(mint);
    candidates.push({ address: mint, poolAddress: address });
  }
  if (raw.data.length && !candidates.length) throw new DiscoveryFeedError('INVALID_RESPONSE');
  return { candidates, fetchedAt, sourceUrl: FEED_URL, returnedPools: raw.data.length, invalidPools };
}

async function boundedJson(response) {
  if (!response.body) throw new DiscoveryFeedError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new DiscoveryFeedError('INVALID_RESPONSE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createDiscoveryFeed({ fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  let nextAllowedAt = 0;
  let inFlight = false;
  let health = { state: 'not_checked', checkedAt: null, candidateCount: null };
  return {
    status: () => ({ ...health }),
    async read({ signal } = {}) {
      if (signal?.aborted) throw new DiscoveryFeedError('STOPPED');
      if (cached && now() - cached.fetchedAt < FEED_INTERVAL_MS) return { ...cached, cached: true };
      if (inFlight || now() < nextAllowedAt) throw new DiscoveryFeedError('COOLDOWN', Math.max(1, Math.ceil((nextAllowedAt - now()) / 1000)));
      nextAllowedAt = now() + FEED_INTERVAL_MS;
      inFlight = true;
      try {
        const timeout = AbortSignal.timeout(8000);
        const response = await fetchImpl(FEED_URL, {
          method: 'GET', headers: { accept: 'application/json' }, redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const header = response.headers.get('retry-after');
            const seconds = /^\d+$/.test(header ?? '') ? Number(header) : (Date.parse(header) - now()) / 1000;
            const retry = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
            nextAllowedAt = now() + retry * 1000;
            throw new DiscoveryFeedError('RATE_LIMITED', retry);
          }
          throw new DiscoveryFeedError('SOURCE_UNAVAILABLE');
        }
        const snapshot = normaliseCandidates(await boundedJson(response), now());
        cached = snapshot;
        health = { state: 'responded', checkedAt: snapshot.fetchedAt, candidateCount: snapshot.candidates.length };
        return { ...snapshot, cached: false };
      } catch (error) {
        cached = null; // A failed refresh cannot keep feeding an old success.
        if (!signal?.aborted) health = { state: 'unavailable', checkedAt: now(), candidateCount: null };
        throw signal?.aborted ? new DiscoveryFeedError('STOPPED') :
          error instanceof DiscoveryFeedError ? error : new DiscoveryFeedError('NETWORK_OR_RESPONSE');
      } finally { inFlight = false; }
    },
  };
}
