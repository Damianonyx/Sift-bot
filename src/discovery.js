import { SOLANA_ADDRESS } from './market-data.js';

// Newest Solana pools from GeckoTerminal's public API (no key). The API
// reports numbers as strings and omits market cap and FDV on most brand-new
// pools; both map to `unknown`, never to a guess, so criteria that require
// those fields correctly hold back alerts until the data exists.
const ENDPOINT = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1';
const MAX_POOLS = 20;

const parseNumber = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : (typeof value === 'number' ? value : NaN);
  return Number.isFinite(n) ? n : NaN;
};
const metric = (value, asOf) => (Number.isFinite(value)
  ? { value, source: 'live', asOf }
  : { value: null, source: 'unknown', asOf });

// Exported for tests: one GeckoTerminal pool entry -> { pool..., metrics } or
// null when the entry cannot be read safely.
export function poolFromEntry(entry, asOf, nowMs) {
  const a = entry?.attributes;
  const tokenAddress = entry?.relationships?.base_token?.data?.id?.replace(/^solana_/, '') ?? '';
  const poolAddress = typeof a?.address === 'string' ? a.address : '';
  if (!SOLANA_ADDRESS.test(tokenAddress) || !SOLANA_ADDRESS.test(poolAddress)) return null;
  const createdMs = Date.parse(a.pool_created_at ?? '');
  const txns = a.transactions?.h1;
  const bothCounted = Number.isFinite(txns?.buys) && Number.isFinite(txns?.sells);
  return {
    poolAddress,
    tokenAddress,
    name: typeof a.name === 'string' ? a.name.slice(0, 60) : 'unnamed pool',
    dexId: String(entry.relationships?.dex?.data?.id ?? 'unknown dex').slice(0, 40),
    url: `https://www.geckoterminal.com/solana/pools/${poolAddress}`,
    metrics: {
      marketCapUsd: metric(parseNumber(a.market_cap_usd), asOf),
      fdvUsd: metric(parseNumber(a.fdv_usd), asOf),
      liquidityUsd: metric(parseNumber(a.reserve_in_usd), asOf),
      volume1hUsd: metric(parseNumber(a.volume_usd?.h1), asOf),
      txns1h: metric(bothCounted ? txns.buys + txns.sells : NaN, asOf),
      poolAgeMinutes: metric(Number.isFinite(createdMs) && createdMs > 0 && createdMs <= nowMs
        ? Math.floor((nowMs - createdMs) / 60_000) : NaN, asOf),
    },
  };
}

// Returns { ok: true, pools, checkedAt } or { ok: false, reason: 'UNAVAILABLE' }.
// Never throws and never logs.
export function createDiscovery({ fetchImpl = fetch, now = Date.now } = {}) {
  return async function fetchNewPools(signal) {
    let payload;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchImpl(ENDPOINT, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return { ok: false, reason: 'UNAVAILABLE' };
      payload = await response.json();
    } catch {
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    if (!Array.isArray(payload?.data)) return { ok: false, reason: 'UNAVAILABLE' };
    const nowMs = now();
    const checkedAt = new Date(nowMs).toISOString();
    const pools = payload.data.slice(0, MAX_POOLS)
      .map((entry) => poolFromEntry(entry, checkedAt, nowMs))
      .filter(Boolean);
    return { ok: true, pools, checkedAt };
  };
}
