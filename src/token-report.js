const unknown = (value) => value === null ? 'unknown' : value.toLocaleString('en-US');
const usd = (value, isPrice = false) => {
  if (value === null) return 'unknown';
  if (value >= 1e15) return '$' + value.toExponential(4);
  if (isPrice && value > 0 && value < 1) return '$' + value.toPrecision(6);
  if (value > 0 && value < 0.01) return '$' + value.toPrecision(4);
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const utc = (value) => new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
const age = (createdAt, fetchedAt) => {
  if (createdAt === null) return 'unknown';
  const minutes = Math.floor((fetchedAt - createdAt) / 60_000);
  if (minutes < 1) return '<1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
};
const WINDOW_NAMES = { m5: '5m', h1: '1h', h24: '24h' };

export function formatTokenReport(snapshot, { hasApprovedRules = false, discovery = false } = {}) {
  const header = `Sift · Solana ${discovery ? 'discovery' : 'token check'}\nCA: ${snapshot.address}`;
  const freshness = `Fetched: ${utc(snapshot.fetchedAt)}\nData: DEX Screener API response; no Sift cache.\nProvider update time: unknown. Data may be delayed.`;
  const pair = snapshot.selected;
  if (!pair) {
    return [header,
      'No supported pool found in this response. Coverage is limited to DEX Screener pools where this CA is the base token. New or unindexed tokens, and quote-only pools, may be missing.',
      'Token existence and market metrics: unknown. This result does not prove the address is invalid.',
      freshness, `Source: ${snapshot.sourceUrl}`,
    ].join('\n\n');
  }
  const selection = snapshot.selection === 'reported_liquidity'
    ? `Selected by highest reported USD liquidity among ${snapshot.poolCount} supported pools.`
    : `Using the first of ${snapshot.poolCount} supported pools; all reported liquidity values are unknown.`;
  const exclusions = snapshot.unknownLiquidityCount && snapshot.selection === 'reported_liquidity'
    ? ` ${snapshot.unknownLiquidityCount} pools have unknown liquidity and cannot be ranked.` : '';
  const windows = pair.windows.map(({ window, volume, buys, sells }) =>
    `${WINDOW_NAMES[window]}: volume ${usd(volume)} · buys ${unknown(buys)} / sells ${unknown(sells)}`).join('\n');
  return [
    `${pair.name} (${pair.symbol})\n${header}`,
    `Price: ${usd(pair.priceUsd, true)}\nMarket cap (provider estimate): ${usd(pair.marketCap)}\nFDV (fully diluted valuation; provider estimate): ${usd(pair.fdv)}`,
    `Selected pool: ${pair.address}\nVenue: ${pair.dex} · quote: ${pair.quoteSymbol}\nPool liquidity: ${usd(pair.liquidityUsd)}\n${selection}${exclusions}`,
    `Selected pool activity; provider rolling windows\n${windows}`,
    'Coverage: DEX Screener-indexed pools with this CA as base token; one pool shown. New or unindexed venues may be missing.',
    `Pool age (provider creation time): ${age(pair.createdAt, snapshot.fetchedAt)}\nToken creation / trading start: unknown.`,
    snapshot.risk ? 'Risk evidence appears below; /risk <CA> shows detailed coverage and transaction links. Holder concentration and token permissions remain unknown.' : 'Not assessed in this market snapshot: liquidity protection, developer sales/transfers, bundles, holder concentration and token permissions. Use /risk <CA> for supported evidence.',
    freshness,
    `Chart / pool evidence: https://dexscreener.com/solana/${pair.address}\nAPI source: ${snapshot.sourceUrl}`,
    discovery ? 'Match against approved screening rules; this does not establish safety or predict profit.' :
      hasApprovedRules ? 'Manual market snapshot; your approved-rule assessment follows. This is not a discovery alert or a safety assessment.' : 'Manual market snapshot. No strategy has been applied; this is not a match alert or a safety assessment.',
  ].join('\n\n');
}

