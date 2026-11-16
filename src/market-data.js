import { FIELDS } from './rules.js';

// On-demand Solana token data from DexScreener's public API (no key). Every
// metric carries provenance: a value the API did not provide is `unknown`,
// never a guess and never zero. 0 returned by the API is a real value.
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/';
const MAX_POOLS = 50;

const metric = (value, asOf) => (Number.isFinite(value)
  ? { value, source: 'live', asOf }
  : { value: null, source: 'unknown', asOf });

// Exported for tests: maps one DexScreener pair to provenance-tagged metrics.
export function metricsFromPair(pair, asOf, nowMs) {
  const txns = pair.txns?.h1;
  const bothCounted = Number.isFinite(txns?.buys) && Number.isFinite(txns?.sells);
  const age = Number.isFinite(pair.pairCreatedAt) && pair.pairCreatedAt > 0 && pair.pairCreatedAt <= nowMs
    ? Math.floor((nowMs - pair.pairCreatedAt) / 60_000) : NaN;
  const metrics = {
    marketCapUsd: metric(pair.marketCap, asOf),
    fdvUsd: metric(pair.fdv, asOf),
    liquidityUsd: metric(pair.liquidity?.usd, asOf),
    volume1hUsd: metric(pair.volume?.h1, asOf),
    txns1h: metric(bothCounted ? txns.buys + txns.sells : NaN, asOf),
    poolAgeMinutes: metric(age, asOf),
  };
  for (const field of Object.keys(metrics)) if (!(field in FIELDS)) delete metrics[field];
  return metrics;
}

// Returns { ok: true, metrics, pool, checkedAt } or { ok: false, reason } with
// reason 'INVALID_ADDRESS' | 'NO_SOLANA_POOLS' | 'UNAVAILABLE'. Never throws
// and never logs; the address is validated before anything leaves the process.
export function createMarketData({ fetchImpl = fetch, now = Date.now } = {}) {
  return async function fetchTokenMetrics(address, signal) {
    if (typeof address !== 'string' || !SOLANA_ADDRESS.test(address)) {
      return { ok: false, reason: 'INVALID_ADDRESS' };
    }
    let payload;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchImpl(ENDPOINT + address, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return { ok: false, reason: 'UNAVAILABLE' };
      payload = await response.json();
    } catch {
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    const pairs = (Array.isArray(payload?.pairs) ? payload.pairs : [])
      .filter((pair) => pair?.chainId === 'solana').slice(0, MAX_POOLS);
    if (pairs.length === 0) return { ok: false, reason: 'NO_SOLANA_POOLS' };
    const selected = pairs.reduce((best, pair) =>
      ((pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? pair : best));

    const nowMs = now();
    const checkedAt = new Date(nowMs).toISOString();
    return {
      ok: true,
      checkedAt,
      metrics: metricsFromPair(selected, checkedAt, nowMs),
      pool: {
        dexId: String(selected.dexId ?? 'unknown dex'),
        pairAddress: String(selected.pairAddress ?? ''),
        base: String(selected.baseToken?.symbol ?? '?'),
        quote: String(selected.quoteToken?.symbol ?? '?'),
        url: typeof selected.url === 'string' && selected.url.startsWith('https://dexscreener.com/') ? selected.url : '',
        poolCount: pairs.length,
      },
    };
  };
}
