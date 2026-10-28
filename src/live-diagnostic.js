import { setTimeout as delay } from 'node:timers/promises';
import { BOT_USERNAME, readConfig } from './bot.js';
import { isSolanaAddress } from './market.js';
import { TelegramError } from './telegram.js';
import { withCopyableCAs } from './telegram-format.js';

export function readDiagnosticTarget(env, requestedId) {
  if (requestedId === undefined) return null;
  if (typeof requestedId !== 'string' || !/^[1-9]\d*$/.test(requestedId) || !Number.isSafeInteger(Number(requestedId))) {
    throw new Error('Use --telegram followed by your positive numeric Telegram user ID. Group destinations are not supported.');
  }
  const { token, allowedUserIds } = readConfig(env);
  const userId = Number(requestedId);
  if (!allowedUserIds.has(userId)) throw new Error('The diagnostic recipient must already be in SIFT_ALLOWED_USER_IDS.');
  return { token, userId };
}

const safeCode = (error) => ['STOPPED', 'COOLDOWN', 'RATE_LIMITED', 'SOURCE_UNAVAILABLE',
  'INVALID_RESPONSE', 'NETWORK_OR_RESPONSE'].includes(error?.code) ? error.code : 'REQUEST_FAILED';

export async function runLiveDiagnostic({ pump, gecko, market, telegram = null, signal,
  now = Date.now, wait = delay, progress = () => {} }) {
  const report = { startedAt: new Date(now()).toISOString(), pump: null, gecko: null, market: [],
    pumpToMarketVerified: false, telegram: { state: 'not_requested' }, approvedRuleMatchVerified: false };
  let pumpCandidates = [], geckoCandidates = [];
  try {
    const reads = await Promise.allSettled([
      (async () => {
        progress('PumpPortal: observing free launch/migration events for up to 30 seconds.');
        const startedAt = now();
        while (!signal.aborted && now() - startedAt < 30_000) {
          pump.tick(true);
          const batch = await pump.read({ signal });
          if (batch.health.state === 'receiving' && batch.candidates.length) {
            pumpCandidates = batch.candidates;
            if (pumpCandidates.length >= 2) break;
          }
          if (['disabled', 'unavailable', 'stopped'].includes(batch.health.state)) break;
          await wait(250, undefined, { signal });
        }
        report.pump = pump.status();
      })(),
      (async () => {
        const batch = await gecko.read({ signal });
        geckoCandidates = batch.candidates;
        report.gecko = { state: 'responded', fetchedAt: new Date(batch.fetchedAt).toISOString(),
          candidateCount: batch.candidates.length, invalidPools: batch.invalidPools };
      })(),
    ]);
    if (reads[0].status === 'rejected') report.pump = { state: 'unavailable', code: safeCode(reads[0].reason) };
    if (reads[1].status === 'rejected') report.gecko = { state: 'unavailable', code: safeCode(reads[1].reason) };
  } finally { pump.close(); }

  progress(`PumpPortal: ${report.pump?.state ?? 'unavailable'}; GeckoTerminal: ${report.gecko?.state ?? 'unavailable'}.`);
  // Bound public API work. Two launch candidates plus one pool-feed candidate
  // distinguish missing launch indexing from a generally broken market API.
  const candidates = new Map();
  for (const [source, rows] of [['pumpportal', pumpCandidates.slice(0, 2)], ['geckoterminal', geckoCandidates.slice(0, 1)]]) {
    for (const row of rows) {
      if (!isSolanaAddress(row.address)) continue;
      const previous = candidates.get(row.address);
      if (previous) previous.sources.push(source);
      else candidates.set(row.address, { address: row.address, sources: [source] });
    }
  }
  for (const candidate of candidates.values()) {
    if (signal.aborted) break;
    progress(`DEX Screener: checking candidate ${report.market.length + 1}/${candidates.size}.`);
    try {
      if (report.market.length) await wait(3000, undefined, { signal });
      const snapshot = await market.check(candidate.address, { signal });
      if (snapshot.address !== candidate.address || !Number.isSafeInteger(snapshot.fetchedAt) ||
          snapshot.fetchedAt > now() || now() - snapshot.fetchedAt > 60_000) throw new Error('Invalid snapshot');
      const pool = snapshot.selected;
      const row = { ...candidate, state: pool ? 'indexed' : 'not_indexed',
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(), providerUpdateTime: 'unknown',
        pool: pool?.address ?? null, marketCapUsd: pool?.marketCap ?? null, liquidityUsd: pool?.liquidityUsd ?? null };
      report.market.push(row);
      if (pool && candidate.sources.includes('pumpportal')) report.pumpToMarketVerified = true;
    } catch (error) {
      report.market.push({ ...candidate, state: 'unavailable', code: safeCode(error) });
    }
  }
  if (telegram && !signal.aborted) {
    progress('Telegram: verifying bot identity before one explicitly requested private diagnostic message.');
    let attempted = false;
    try {
      const identity = await telegram.call('getMe', {}, signal);
      if (identity?.is_bot !== true || identity.username?.toLowerCase() !== BOT_USERNAME.toLowerCase()) {
        report.telegram = { state: 'wrong_bot' };
      } else {
        const text = ['Sift · Connection check',
          'DIAGNOSTIC ONLY — no screening rules were evaluated. These CAs are not match alerts or recommendations.',
          `PumpPortal: ${report.pump?.state ?? 'unavailable'}. GeckoTerminal: ${report.gecko?.state ?? 'unavailable'}.`,
          ...report.market.map((row) => `CA: ${row.address}\nMarket response: ${row.state}${row.fetchedAt ? `\nFetched: ${row.fetchedAt}; provider update time unknown.` : ''}`),
          'Your saved rules, scan state and group destinations are unchanged.'].join('\n\n');
        attempted = true;
        const result = await telegram.call('sendMessage', withCopyableCAs({ chat_id: telegram.userId, text,
          link_preview_options: { is_disabled: true } }, report.market.map((row) => row.address)), signal);
        report.telegram = { state: Number.isSafeInteger(result?.message_id) && result.message_id > 0 &&
          result.chat?.id === telegram.userId && result.chat?.type === 'private' ? 'accepted_by_telegram' : 'uncertain' };
      }
    } catch (error) {
      report.telegram = { state: attempted ? error instanceof TelegramError && Number.isInteger(error.code) ? 'failed' : 'uncertain' : 'unavailable' };
    }
  } else if (telegram) report.telegram = { state: 'not_attempted_deadline' };
  report.deadlineReached = signal.aborted;
  report.completedAt = new Date(now()).toISOString();
  return report;
}
