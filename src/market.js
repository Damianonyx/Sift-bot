const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const API_ROOT = 'https://api.dexscreener.com/token-pairs/v1/solana/';
const MAX_BYTES = 2 * 1024 * 1024;

export class MarketDataError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Market data unavailable (${code}).`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Format validation only. A 32-byte public key is not proof of a token mint.
export function isSolanaAddress(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(ALPHABET.indexOf(char));
  const leadingZeros = /^1*/.exec(value)[0].length;
  const bytes = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return leadingZeros + bytes === 32;
}

export const sourceUrl = (address) => API_ROOT + address;
const metric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'unknown'
  : 'unknown';

function price(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  return metric(Number(value));
}

export function normalisePairs(raw, address, fetchedAt, poolAddress = null) {
  if (!Array.isArray(raw)) throw new MarketDataError('INVALID_RESPONSE');
  const seen = new Set();
  const pairs = [];
  for (const pair of raw) {
    // Pair metrics describe the base token. Quote-only matches cannot be
    // treated as this token's price, market cap, FDV or buy/sell direction.
    if (pair?.chainId !== 'solana' || pair.baseToken?.address !== address ||
        !isSolanaAddress(pair.pairAddress) || seen.has(pair.pairAddress)) continue;
    seen.add(pair.pairAddress);
    const createdAt = Number.isSafeInteger(pair.pairCreatedAt) && pair.pairCreatedAt > 0 &&
      pair.pairCreatedAt <= fetchedAt ? pair.pairCreatedAt : null;
    pairs.push({
      address: pair.pairAddress,
      name: label(pair.baseToken.name), symbol: label(pair.baseToken.symbol),
      quoteSymbol: label(pair.quoteToken?.symbol), dex: label(pair.dexId),
      quoteAddress: isSolanaAddress(pair.quoteToken?.address) ? pair.quoteToken.address : null,
      priceUsd: price(pair.priceUsd), marketCap: metric(pair.marketCap), fdv: metric(pair.fdv),
      liquidityUsd: metric(pair.liquidity?.usd), createdAt,
      activeBoosts: count(pair.boosts?.active),
      windows: ['m5', 'h1', 'h24'].map((window) => ({
        window, volume: metric(pair.volume?.[window]),
        buys: count(pair.txns?.[window]?.buys), sells: count(pair.txns?.[window]?.sells),
      })),
    });
  }
  const ranked = pairs.filter((pair) => pair.liquidityUsd !== null)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd || a.address.localeCompare(b.address));
  return {
    address, fetchedAt, sourceUrl: sourceUrl(address), poolCount: pairs.length,
    unknownLiquidityCount: pairs.filter((pair) => pair.liquidityUsd === null).length,
    selected: poolAddress ? pairs.find((pair) => pair.address === poolAddress) ?? null : ranked[0] ?? pairs[0] ?? null,
    pools: pairs,
    selection: poolAddress ? 'pinned_pool' : ranked.length ? 'reported_liquidity' : 'first_supported',
  };
}

async function readJson(response) {
  if (!response.body) throw new MarketDataError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new MarketDataError('INVALID_RESPONSE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createMarketData({ fetchImpl = fetch, now = Date.now } = {}) {
  let nextAllowedAt = 0;
  let inFlight = false;
  let health = { state: 'not_checked', checkedAt: null };
  return {
    status: () => ({ ...health }),
    async check(address, { signal, poolAddress = null } = {}) {
      if (signal?.aborted) throw new MarketDataError('STOPPED');
      if (!isSolanaAddress(address)) throw new MarketDataError('INVALID_ADDRESS');
      if (poolAddress !== null && !isSolanaAddress(poolAddress)) throw new MarketDataError('INVALID_ADDRESS');
      const startedAt = now();
      if (inFlight || startedAt < nextAllowedAt) {
        throw new MarketDataError('COOLDOWN', Math.max(1, Math.ceil((nextAllowedAt - startedAt) / 1000)));
      }
      nextAllowedAt = startedAt + 3000; // Resource limit, not a screening rule.
      inFlight = true;
      try {
        const timeout = AbortSignal.timeout(8000);
        const response = await fetchImpl(sourceUrl(address), {
          method: 'GET', headers: { accept: 'application/json' }, redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429) {
            const header = response.headers.get('retry-after');
            const seconds = /^\d+$/.test(header ?? '') ? Number(header) :
              (Date.parse(header) - now()) / 1000;
            const retry = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
            nextAllowedAt = now() + retry * 1000;
            throw new MarketDataError('RATE_LIMITED', retry);
          }
          throw new MarketDataError('SOURCE_UNAVAILABLE');
        }
        const raw = await readJson(response);
        const fetchedAt = now();
        const snapshot = normalisePairs(raw, address, fetchedAt, poolAddress);
        health = { state: 'responded', checkedAt: fetchedAt };
        return snapshot;
      } catch (error) {
        const safe = signal?.aborted ? new MarketDataError('STOPPED') :
          error instanceof MarketDataError ? error : new MarketDataError('NETWORK_OR_RESPONSE');
        if (safe.code !== 'STOPPED') health = { state: 'unavailable', checkedAt: now() };
        throw safe;
      } finally { inFlight = false; }
    },
  };
}
