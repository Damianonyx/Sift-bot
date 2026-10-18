import { createPublicJson, nonnegative, PublicDataError } from './public-json.js';
import { isSolanaAddress } from './market.js';
import { createMeteora, METEORA_PROTOCOLS } from './meteora.js';

export const GECKO_ORIGIN = 'https://api.geckoterminal.com';
export const geckoPoolPath = (pool) => `/api/v2/networks/solana/pools/${pool}?include=base_token,quote_token`;

export function normaliseGeckoPool(raw, snapshot, fetchedAt) {
  const p = raw?.data, a = p?.attributes, expected = snapshot.selected;
  if (!expected || !isSolanaAddress(expected.quoteAddress)) throw new PublicDataError('INCOMPLETE_DEX_IDENTITY');
  const token = (side) => {
    const ref = p?.relationships?.[side]?.data;
    return ref?.type === 'token' && ref.id?.startsWith('solana_') ? ref.id.slice(7) : null;
  };
  const base = token('base_token'), quote = token('quote_token');
  if (p?.type !== 'pool' || p.id !== `solana_${expected.address}` || a?.address !== expected.address ||
      !isSolanaAddress(base) || !isSolanaAddress(quote) || base === quote ||
      !((base === snapshot.address && quote === expected.quoteAddress) || (quote === snapshot.address && base === expected.quoteAddress))) {
    throw new PublicDataError('POOL_OR_TOKEN_MISMATCH');
  }
  return { source: 'geckoterminal', fetchedAt, sourceUrl: GECKO_ORIGIN + geckoPoolPath(expected.address),
    reversed: base !== snapshot.address, providerUpdatedAt: null,
    priceUsd: nonnegative(a[base === snapshot.address ? 'base_token_price_usd' : 'quote_token_price_usd']),
    // Pool market cap belongs to the API's base token. FDV is never a fallback.
    marketCap: base === snapshot.address ? nonnegative(a.market_cap_usd) : null,
    liquidityUsd: nonnegative(a.reserve_in_usd), volume1h: nonnegative(a.volume_usd?.h1) };
}

export function compareMetric(dex, other) {
  if (dex === null || other === null) return { dex, other, state: 'unknown', differencePct: null };
  const delta = dex === 0 ? (other === 0 ? 0 : null) : (other - dex) / dex * 100;
  return { dex, other, state: dex === other ? 'equal' : 'different', differencePct: Number.isFinite(delta) ? delta : null };
}

export function createSourceAudit({ fetchImpl = fetch, now = Date.now, meteora = createMeteora({ fetchImpl, now }) } = {}) {
  const get = createPublicJson({ origin: GECKO_ORIGIN, fetchImpl, now, intervalMs: 3000 });
  let nextAt = 0, busy = false;
  return {
    async check(snapshot, { signal } = {}) {
      if (signal?.aborted) throw new PublicDataError('STOPPED');
      if (!isSolanaAddress(snapshot?.address)) throw new PublicDataError('INVALID_ADDRESS');
      if (!snapshot.selected) return { address: snapshot.address, state: 'not_indexed', fetchedAt: now(), comparisons: [] };
      if (!isSolanaAddress(snapshot.selected.address)) throw new PublicDataError('INVALID_ADDRESS');
      if (busy || now() < nextAt) throw new PublicDataError('COOLDOWN', Math.max(1, Math.ceil((nextAt - now()) / 1000)));
      busy = true; nextAt = now() + 20_000; // Global manual diagnostic budget; no automatic audit polling.
      try {
        const [g, m] = await Promise.allSettled([
          get(geckoPoolPath(snapshot.selected.address), { signal }).then((raw) => normaliseGeckoPool(raw, snapshot, now())),
          /^meteora(?:[-_ ].*)?$/i.test(snapshot.selected.dex) ? meteora.pools(snapshot.selected.address, { signal }) : Promise.resolve([]),
        ]);
        if (signal?.aborted) throw new PublicDataError('STOPPED');
        const pool = snapshot.selected;
        const gecko = g.status === 'fulfilled' ? { state: 'responded', ...g.value } :
          { state: g.reason instanceof PublicDataError ? g.reason.code : 'UNAVAILABLE' };
        const comparisons = gecko.state === 'responded' ? [
          ['priceUsd', 'Price USD', pool.priceUsd], ['marketCap', 'Market cap USD', pool.marketCap],
          ['liquidityUsd', 'Pool liquidity USD', pool.liquidityUsd], ['volume1h', 'Pool 1h volume USD', pool.windows.find((w) => w.window === 'h1')?.volume ?? null],
        ].map(([field, label, value]) => ({ field, label, ...compareMetric(value, gecko[field]) })) : [];
        const direct = m.status === 'fulfilled' ? m.value.map((p) => {
          if (p.state !== 'responded') return p;
          if (!isSolanaAddress(pool.quoteAddress) || !p.tokens.includes(snapshot.address) || !p.tokens.includes(pool.quoteAddress)) {
            return { source: p.source, state: 'POOL_OR_TOKEN_MISMATCH' };
          }
          return p;
        }) : [{ source: 'meteora', state: 'UNAVAILABLE' }];
        return { address: snapshot.address, poolAddress: pool.address, dex: pool.dex, state: 'observed',
          fetchedAt: now(), dexFetchedAt: snapshot.fetchedAt, dexSourceUrl: snapshot.sourceUrl,
          gecko, meteora: direct, comparisons };
      } finally { busy = false; }
    },
  };
}

const value = (n) => n === null ? 'unknown' : n === 0 ? '0' : Number(n.toPrecision(7)).toString();
export function formatSourceAudit(report) {
  const lines = [`Sift · Source comparison\nCA: ${report.address}`];
  if (report.state === 'not_indexed') return lines.concat('DEX Screener has no supported base-token pool. A same-pool comparison is unavailable. Missing data is not a pass.').join('\n\n');
  lines.push(`Same pool: ${report.poolAddress}\nDEX Screener fetched: ${new Date(report.dexFetchedAt).toISOString()}`);
  if (report.gecko.state === 'responded') {
    lines.push(`GeckoTerminal (CoinGecko on-chain data) fetched: ${new Date(report.gecko.fetchedAt).toISOString()}\nPool and both mint identities agree.`);
    lines.push('DEX Screener / GeckoTerminal:\n' + report.comparisons.map((c) =>
      `${c.label}: ${value(c.dex)} / ${value(c.other)}; ${c.state === 'unknown' ? 'not comparable' :
        c.differencePct === null ? 'different; DEX value is zero' : `difference ${value(c.differencePct)}% of DEX value`}`).join('\n'));
  } else lines.push(`GeckoTerminal comparison unavailable: ${report.gecko.state}.`);
  for (const p of report.meteora) {
    const name = METEORA_PROTOCOLS[p.source]?.name ?? 'Meteora';
    lines.push(p.state === 'responded' ? `${name}: pool and both mint identities agree.\nFetched: ${new Date(p.fetchedAt).toISOString()}\nAPI TVL: ${value(p.tvl)}; API 1h volume: ${value(p.volume1h)}. Units/methodology are not established by the published schema; these numbers are not compared with USD metrics.\n${p.sourceUrl}` : `${name}: ${p.state}.`);
  }
  lines.push('These are provider observations, not an accuracy or safety certification. Provider update times are unknown; requests are not synchronized. Prices, indexing delays and calculation methods can explain differences. Agreement is not independent on-chain proof. No lock, developer or bundle verdict is inferred. Your rules and scans are unchanged.');
  lines.push(report.dexSourceUrl, report.gecko.sourceUrl ?? GECKO_ORIGIN + geckoPoolPath(report.poolAddress));
  return lines.join('\n\n');
}
