import { SOLANA_ADDRESS } from './market-data.js';

// Newest Solana pools from GeckoTerminal's public API (no key). Around 40
// pools launch per minute at busy times and a page holds 20, so each scan
// reads up to `maxPages` pages, stopping early once a page reaches pools that
// were already seen. The API reports numbers as strings and has no market cap
// or FDV for brand-new pools; missing values map to `unknown`, never a guess.
const ENDPOINT = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=';
export const PROVIDER = 'GeckoTerminal';
export const DEFAULT_MAX_PAGES = 3;
const PAGE_SIZE = 20;

const parseNumber = (value) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : (typeof value === 'number' ? value : NaN);
  return Number.isFinite(n) ? n : NaN;
};
const metric = (value, asOf) => (Number.isFinite(value)
  ? { value, source: 'live', provider: PROVIDER, asOf }
  : { value: null, source: 'unknown', provider: null, asOf });

// One GeckoTerminal pool entry -> { pool fields..., metrics }, or null when
// the entry cannot be read safely.
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

// Returns { entries } or { reason: 'RATE_LIMITED' | 'UNAVAILABLE' }.
async function fetchPage(fetchImpl, page, signal) {
  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetchImpl(ENDPOINT + page, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 429) return { reason: 'RATE_LIMITED' };
    if (!response.ok) return { reason: 'UNAVAILABLE' };
    const payload = await response.json();
    return Array.isArray(payload?.data) ? { entries: payload.data } : { reason: 'UNAVAILABLE' };
  } catch {
    return { reason: 'UNAVAILABLE' };
  }
}

// Returns { ok: true, pools, pages, checkedAt } or { ok: false, reason:
// 'RATE_LIMITED' | 'UNAVAILABLE' } when even the first page fails. A later
// page failing keeps the pools already read. `isKnown(poolAddress)` stops
// paging early.
export function createDiscovery({ fetchImpl = fetch, now = Date.now, maxPages = DEFAULT_MAX_PAGES } = {}) {
  return async function fetchNewPools(signal, { isKnown = () => false } = {}) {
    const pools = [];
    const addresses = new Set();
    let pages = 0;
    let checkedAt = null;
    for (let page = 1; page <= maxPages; page += 1) {
      const { entries, reason } = await fetchPage(fetchImpl, page, signal);
      if (!entries) {
        if (page === 1) return { ok: false, reason };
        break;
      }
      pages += 1;
      const nowMs = now();
      checkedAt ??= new Date(nowMs).toISOString();
      let reachedKnown = false;
      for (const entry of entries) {
        const pool = poolFromEntry(entry, new Date(nowMs).toISOString(), nowMs);
        if (!pool || addresses.has(pool.poolAddress)) continue;
        if (isKnown(pool.poolAddress)) reachedKnown = true;
        addresses.add(pool.poolAddress);
        pools.push(pool);
      }
      if (reachedKnown || entries.length < PAGE_SIZE) break;
    }
    return { ok: true, pools, pages, checkedAt };
  };
}
