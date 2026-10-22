import { isSolanaAddress } from './market.js';
import { createPublicJson, nonnegative, PublicDataError } from './public-json.js';

export const METEORA_PROTOCOLS = Object.freeze({
  'meteora-dlmm': { name: 'Meteora DLMM', origin: 'https://dlmm.datapi.meteora.ag' },
  'meteora-damm-v2': { name: 'Meteora DAMM v2', origin: 'https://damm-v2.datapi.meteora.ag' },
});
export const METEORA_LIST_PATH = '/pools?page=1&page_size=20&sort_by=pool_created_at:desc';

export function readMeteoraConfig(env) {
  const value = env.SIFT_METEORA_ENABLED ?? 'true';
  if (!['true', 'false'].includes(value)) throw new Error('SIFT_METEORA_ENABLED must be true or false.');
  return { enabled: value === 'true' };
}

export function normaliseMeteoraPool(raw, source, fetchedAt) {
  if (!METEORA_PROTOCOLS[source] || !isSolanaAddress(raw?.address) ||
      !isSolanaAddress(raw.token_x?.address) || !isSolanaAddress(raw.token_y?.address) ||
      raw.token_x.address === raw.token_y.address) throw new PublicDataError('INVALID_POOL_IDENTITY');
  // API estimates only. No current_price-as-USD, market-cap substitution,
  // verified-lock inference or screening decision is made from this metadata.
  return { address: raw.address, tokens: [raw.token_x.address, raw.token_y.address], source, fetchedAt,
    sourceUrl: `${METEORA_PROTOCOLS[source].origin}/pools/${raw.address}`,
    tvl: nonnegative(raw.tvl), volume1h: nonnegative(raw.volume?.['1h']),
    providerUpdatedAt: null };
}

export function normaliseMeteoraFeed(raw, source, fetchedAt) {
  if (!Array.isArray(raw?.data) || raw.data.length > 20 || raw.current_page !== 1) throw new PublicDataError('INVALID_RESPONSE');
  const pools = [], candidates = [], seenPools = new Set(), seenTokens = new Set();
  let invalidPools = 0;
  for (const row of raw.data) {
    let pool;
    try { pool = normaliseMeteoraPool(row, source, fetchedAt); }
    catch { invalidPools++; continue; }
    if (seenPools.has(pool.address)) continue;
    seenPools.add(pool.address); pools.push(pool);
    // X/Y is not a base/quote guarantee. Discover both sides and let the
    // existing DEX Screener base-token identity check select market coverage.
    for (const address of pool.tokens) {
      if (seenTokens.has(address)) continue;
      seenTokens.add(address);
      candidates.push({ address, poolAddress: pool.address, provenance: [{ source, receivedAt: fetchedAt,
        sourceUrl: METEORA_PROTOCOLS[source].origin + METEORA_LIST_PATH, poolAddress: pool.address, cached: false }] });
    }
  }
  if (raw.data.length && !pools.length) throw new PublicDataError('INVALID_RESPONSE');
  return { candidates, pools, invalidPools, fetchedAt, returnedPools: raw.data.length };
}

export function createMeteora({ enabled = true, fetchImpl = fetch, now = Date.now } = {}) {
  const served = new Map(); let turn = 0;
  const feeds = Object.entries(METEORA_PROTOCOLS).map(([source, { origin }]) => {
    const get = createPublicJson({ origin, fetchImpl, now });
    let cache = null, nextRead = 0;
    let health = { source, state: enabled ? 'not_checked' : 'disabled', checkedAt: null, candidateCount: 0 };
    return { source, status: () => ({ ...health }),
      async pool(address, options) {
        if (!enabled) throw new PublicDataError('DISABLED');
        const row = await get(`/pools/${address}`, options);
        const pool = normaliseMeteoraPool(row, source, now());
        if (pool.address !== address) throw new PublicDataError('POOL_MISMATCH');
        return pool;
      },
      async read({ signal } = {}) {
        if (signal?.aborted) throw new PublicDataError('STOPPED');
        if (!enabled) return { candidates: [], invalidPools: 0 };
        if (cache && now() - cache.fetchedAt < 60_000) return { ...structuredClone(cache), candidates: cache.candidates.map((c) =>
          ({ ...c, provenance: c.provenance.map((p) => ({ ...p, cached: true })) })) };
        if (now() < nextRead) throw new PublicDataError('COOLDOWN');
        nextRead = now() + 60_000;
        try {
          cache = normaliseMeteoraFeed(await get(METEORA_LIST_PATH, { signal }), source, now());
          health = { source, state: 'responded', checkedAt: cache.fetchedAt, candidateCount: cache.candidates.length,
            invalidPools: cache.invalidPools };
          return structuredClone(cache);
        } catch (error) {
          cache = null;
          health = { source, state: 'unavailable', checkedAt: now(), candidateCount: 0 };
          throw error;
        }
      },
    };
  });
  return {
    status: () => feeds.map((f) => f.status()),
    selected(candidates) { for (const c of candidates) if (served.has(c.address)) served.set(c.address, ++turn); },
    async read(options = {}) {
      const results = await Promise.allSettled(feeds.map((f) => f.read(options)));
      if (options.signal?.aborted) throw new PublicDataError('STOPPED');
      const batches = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const current = new Set(batches.flatMap((b) => b.candidates.map((c) => c.address)));
      for (const address of served.keys()) if (!current.has(address)) served.delete(address);
      for (const address of current) if (!served.has(address)) served.set(address, 0);
      for (const b of batches) b.candidates.sort((a, b) => served.get(a.address) - served.get(b.address));
      const candidates = [];
      for (let i = 0; i < Math.max(0, ...batches.map((b) => b.candidates.length)); i++) {
        for (const b of batches) if (b.candidates[i]) candidates.push(b.candidates[i]);
      }
      return { candidates, sources: feeds.map((f) => f.status()), fetchedAt: now(),
        partial: results.some((r) => r.status === 'rejected') || batches.some((b) => b.invalidPools > 0),
        invalidPools: batches.reduce((sum, b) => sum + b.invalidPools, 0) };
    },
    async pools(address, options = {}) {
      if (!isSolanaAddress(address)) throw new PublicDataError('INVALID_ADDRESS');
      const results = await Promise.allSettled(feeds.map((f) => f.pool(address, options)));
      if (options.signal?.aborted) throw new PublicDataError('STOPPED');
      return results.map((r, i) => r.status === 'fulfilled' ? { state: 'responded', ...r.value } :
        { source: feeds[i].source, state: r.reason instanceof PublicDataError ? r.reason.code : 'UNAVAILABLE' });
    },
  };
}
