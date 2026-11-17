// Solana token data from DexScreener's public API (no key). Every metric
// carries provenance: the provider and time for a value the API returned, or
// `unknown` when it did not, never a guess and never zero. 0 returned by the
// API is a real value. Nothing here throws or logs.
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// One token: up to 30 of its pools. Responses are capped at 30 pairs in
// total, so this endpoint is only ever used for a single token.
const TOKEN_ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/';
// Up to 30 tokens: DexScreener's main (top-liquidity) pool for each. Used for
// batches, where the capped endpoint above would let one token with many
// pools crowd every other token out of the response.
const BATCH_ENDPOINT = 'https://api.dexscreener.com/tokens/v1/solana/';
export const BATCH_SIZE = 30;
export const PROVIDER = 'DexScreener';
const MAX_POOLS = 50;

const metric = (value, asOf) => (Number.isFinite(value)
  ? { value, source: 'live', provider: PROVIDER, asOf }
  : { value: null, source: 'unknown', provider: null, asOf });

// Maps one DexScreener pair to provenance-tagged metrics.
export function metricsFromPair(pair, asOf, nowMs) {
  const txns = pair.txns?.h1;
  const bothCounted = Number.isFinite(txns?.buys) && Number.isFinite(txns?.sells);
  const age = Number.isFinite(pair.pairCreatedAt) && pair.pairCreatedAt > 0 && pair.pairCreatedAt <= nowMs
    ? Math.floor((nowMs - pair.pairCreatedAt) / 60_000) : NaN;
  return {
    marketCapUsd: metric(pair.marketCap, asOf),
    fdvUsd: metric(pair.fdv, asOf),
    liquidityUsd: metric(pair.liquidity?.usd, asOf),
    volume1hUsd: metric(pair.volume?.h1, asOf),
    txns1h: metric(bothCounted ? txns.buys + txns.sells : NaN, asOf),
    poolAgeMinutes: metric(age, asOf),
  };
}

// The pool that pool-level rules describe: the highest-liquidity pool. When
// no pool reports liquidity (DexScreener omits it for pump.fun tokens still
// on their bonding curve), the pool with the most 1h volume, and the reason
// says so.
export function selectPair(pairs) {
  const withLiquidity = pairs.filter((p) => Number.isFinite(p.liquidity?.usd));
  if (withLiquidity.length > 0) {
    return { pair: withLiquidity.reduce((a, b) => (b.liquidity.usd > a.liquidity.usd ? b : a)), selection: 'highest liquidity' };
  }
  const volume = (p) => (Number.isFinite(p.volume?.h1) ? p.volume.h1 : -1);
  return { pair: pairs.reduce((a, b) => (volume(b) > volume(a) ? b : a)), selection: 'most 1h volume; no pool reports liquidity' };
}

export function poolSummary(pair, { poolCount, selection }) {
  const base = String(pair.baseToken?.symbol ?? '?').slice(0, 30);
  const quote = String(pair.quoteToken?.symbol ?? '?').slice(0, 30);
  return {
    name: `${base} / ${quote}`,
    base,
    quote,
    dexId: String(pair.dexId ?? 'unknown dex').slice(0, 40),
    pairAddress: String(pair.pairAddress ?? ''),
    url: typeof pair.url === 'string' && pair.url.startsWith('https://dexscreener.com/') ? pair.url : '',
    poolCount,
    selection,
  };
}

async function getJson(fetchImpl, url, signal) {
  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
    if (!response.ok) return { ok: false, reason: 'UNAVAILABLE' };
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' };
  }
}

// One token, for /check. Returns { ok: true, metrics, pool, checkedAt } or
// { ok: false, reason } with reason 'INVALID_ADDRESS' | 'NO_SOLANA_POOLS' |
// 'UNAVAILABLE' | 'RATE_LIMITED'. The address is validated before anything
// leaves the process.
export function createMarketData({ fetchImpl = fetch, now = Date.now } = {}) {
  return async function fetchTokenMetrics(address, signal) {
    if (typeof address !== 'string' || !SOLANA_ADDRESS.test(address)) {
      return { ok: false, reason: 'INVALID_ADDRESS' };
    }
    const result = await getJson(fetchImpl, TOKEN_ENDPOINT + address, signal);
    if (!result.ok) return result;
    const pairs = (Array.isArray(result.payload?.pairs) ? result.payload.pairs : [])
      .filter((pair) => pair?.chainId === 'solana' && pair.baseToken?.address === address).slice(0, MAX_POOLS);
    if (pairs.length === 0) return { ok: false, reason: 'NO_SOLANA_POOLS' };
    const { pair, selection } = selectPair(pairs);
    const nowMs = now();
    const checkedAt = new Date(nowMs).toISOString();
    return {
      ok: true,
      checkedAt,
      metrics: metricsFromPair(pair, checkedAt, nowMs),
      pool: poolSummary(pair, { poolCount: pairs.length, selection }),
    };
  };
}

// Up to BATCH_SIZE tokens in one request, for the scanner. Returns
// { ok: true, byToken: Map<address, { metrics, pool }>, checkedAt } or
// { ok: false, reason: 'UNAVAILABLE' | 'RATE_LIMITED' }. Tokens DexScreener
// has not indexed yet are simply absent from byToken.
export function createTokenBatch({ fetchImpl = fetch, now = Date.now } = {}) {
  return async function fetchTokens(addresses, signal) {
    const tokens = [...new Set(addresses)].filter((a) => typeof a === 'string' && SOLANA_ADDRESS.test(a)).slice(0, BATCH_SIZE);
    const nowMs = now();
    const checkedAt = new Date(nowMs).toISOString();
    if (tokens.length === 0) return { ok: true, byToken: new Map(), checkedAt };
    const result = await getJson(fetchImpl, BATCH_ENDPOINT + tokens.join(','), signal);
    if (!result.ok) return result;
    if (!Array.isArray(result.payload)) return { ok: false, reason: 'UNAVAILABLE' };
    const wanted = new Set(tokens);
    const grouped = new Map();
    for (const pair of result.payload) {
      const token = pair?.baseToken?.address;
      if (pair?.chainId !== 'solana' || !wanted.has(token)) continue;
      if (!grouped.has(token)) grouped.set(token, []);
      grouped.get(token).push(pair);
    }
    const byToken = new Map();
    for (const [token, pairs] of grouped) {
      const { pair, selection } = pairs.length === 1
        ? { pair: pairs[0], selection: 'DexScreener main pool' }
        : selectPair(pairs);
      byToken.set(token, {
        metrics: metricsFromPair(pair, checkedAt, nowMs),
        pool: poolSummary(pair, { poolCount: null, selection }),
      });
    }
    return { ok: true, byToken, checkedAt };
  };
}
