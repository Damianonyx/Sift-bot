import { setTimeout as delay } from 'node:timers/promises';
import { telegramMessage } from './message.js';
import { BATCH_SIZE } from './market-data.js';
import { evaluate, formatAlert } from './rules.js';
import { isPermanentReplyError } from './telegram.js';

// The automatic discovery-to-alert loop. Each cycle, while at least one
// allowed tester is scanning:
//  1. Discover: read GeckoTerminal's newest Solana pools (paging until it
//     reaches pools already seen).
//  2. Enrich: brand-new pools have no market cap or FDV on GeckoTerminal, so
//     those token-level values come from DexScreener in the same cycle. Pool
//     values (liquidity, volume, trades, age) stay those of the discovered
//     pool. Every value keeps its provider label.
//  3. Watch: young tokens stay on a watch list for `watchMs` and are
//     re-checked on DexScreener in rotating batches, because most criteria
//     only become true minutes after launch.
//  4. Alert: a token that satisfies every required rule of a tester's
//     approved criteria is queued once for that tester (the ledger enforces
//     one alert per tester and token), then delivered with paced sends.
// The loop never throws except on abort: a scanner problem must never take
// down the reply loop.
export const DEFAULT_SCAN_INTERVAL_MS = 60_000;
export const DEFAULT_WATCH_MS = 30 * 60_000;
// Undelivered alerts older than this are dropped rather than sent late.
export const ALERT_FRESHNESS_MS = 30 * 60_000;
// Watch-list refresh budget per cycle: up to 20 requests of 30 tokens, 4 at a
// time. DexScreener publishes 300 requests per minute for this endpoint.
export const REFRESH_MAX_REQUESTS = 20;
const REFRESH_CONCURRENCY = 4;
const SEEN_RETENTION_MS = 24 * 60 * 60 * 1000;
// Telegram allows roughly one message per second per chat, so a burst of
// matches is paced instead of tripping rate limits and burning retries.
export const ALERT_PACE_MS = 1_100;
const defaultPace = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

const TOKEN_LEVEL = ['marketCapUsd', 'fdvUsd'];

// Pool-level values from the discovered pool; token-level values from
// DexScreener when the discovery source has none.
export function mergeTokenLevel(poolMetrics, tokenMetrics) {
  if (!tokenMetrics) return poolMetrics;
  const merged = { ...poolMetrics };
  for (const field of TOKEN_LEVEL) {
    if (merged[field]?.source !== 'live' && tokenMetrics[field]?.source === 'live') merged[field] = tokenMetrics[field];
  }
  return merged;
}

// Fetches token data in batches, a few requests at a time. Stops early on a
// rate limit or outage and returns what it has; never throws. `fetched`
// lists only tokens whose batch actually came back, so a token whose request
// never ran keeps its place in the refresh rotation.
async function fetchInBatches(refresh, tokens, signal, maxRequests) {
  const batches = [];
  for (let i = 0; i < tokens.length && batches.length < maxRequests; i += BATCH_SIZE) {
    batches.push(tokens.slice(i, i + BATCH_SIZE));
  }
  const byToken = new Map();
  const fetched = [];
  let requests = 0;
  let degraded = false;
  for (let i = 0; i < batches.length && !degraded && !signal.aborted; i += REFRESH_CONCURRENCY) {
    const round = batches.slice(i, i + REFRESH_CONCURRENCY);
    const results = await Promise.all(round.map((batch) => refresh(batch, signal)));
    requests += round.length;
    results.forEach((result, j) => {
      if (!result.ok) { degraded = true; return; }
      fetched.push(...round[j]);
      for (const [token, data] of result.byToken) byToken.set(token, { ...data, checkedAt: result.checkedAt });
    });
  }
  return { byToken, fetched, requests, degraded };
}

function queueAlerts(store, testers, { tokenAddress, pool, metrics, discoveredAt, checkedAt }) {
  let queued = 0;
  for (const tester of testers) {
    const evaluation = evaluate(tester.approved.rules, metrics);
    if (evaluation.verdict !== 'pass') continue;
    const message = formatAlert(evaluation, { version: tester.version, tokenAddress, pool, discoveredAt, checkedAt, metrics });
    if (store.createAlert(tester.userId, tokenAddress, pool.pairAddress || pool.poolAddress || '', message)) queued += 1;
  }
  return queued;
}

// One pass, exported for tests.
export async function runScanCycle({
  discovery, refresh, store, send, log, signal, allowedUserIds,
  now = Date.now, pace = defaultPace, watchMs = DEFAULT_WATCH_MS, maxRefreshRequests = REFRESH_MAX_REQUESTS,
}) {
  // Removing a tester from the allow-list stops their alerts at once.
  const testers = store.scanningAgents().filter((t) => allowedUserIds.has(t.userId));
  if (testers.length > 0) {
    const found = await discovery(signal, { isKnown: (poolAddress) => store.wasSeen(poolAddress) });
    if (signal.aborted) return;
    let fresh = [];
    let queued = 0;
    let enrichmentRequests = 0;
    if (found.ok) {
      fresh = found.pools.filter((pool) => !store.wasSeen(pool.poolAddress));
      store.transaction(() => { for (const pool of fresh) store.markSeen(pool.poolAddress, found.checkedAt); });

      // Same-cycle token-level enrichment for the new pools.
      const enrichment = await fetchInBatches(refresh, [...new Set(fresh.map((p) => p.tokenAddress))], signal, maxRefreshRequests);
      enrichmentRequests = enrichment.requests;
      const nowIso = new Date(now()).toISOString();
      store.transaction(() => {
        for (const pool of fresh) {
          const metrics = mergeTokenLevel(pool.metrics, enrichment.byToken.get(pool.tokenAddress)?.metrics);
          queued += queueAlerts(store, testers, {
            tokenAddress: pool.tokenAddress,
            pool: { name: pool.name, dexId: pool.dexId, poolAddress: pool.poolAddress, url: pool.url },
            metrics, discoveredAt: found.checkedAt, checkedAt: found.checkedAt,
          });
          if (watchMs > 0) {
            store.addCandidate({
              tokenAddress: pool.tokenAddress, poolAddress: pool.poolAddress, name: pool.name, dexId: pool.dexId,
              discoveredAt: found.checkedAt, expiresAt: new Date(Date.parse(found.checkedAt) + watchMs).toISOString(), lastChecked: nowIso,
            });
          }
        }
      });
    }

    // Watch-list refresh: the least recently checked young tokens. It runs
    // even when discovery failed, so a discovery outage does not also freeze
    // the re-checks of tokens already being watched.
    let refreshed = 0;
    if (watchMs > 0 && !signal.aborted) {
      const nowIso = new Date(now()).toISOString();
      store.expireCandidates(nowIso);
      const budget = Math.max(0, maxRefreshRequests - enrichmentRequests);
      const due = store.dueCandidates(nowIso, budget * BATCH_SIZE).filter((c) => !fresh.some((p) => p.tokenAddress === c.tokenAddress));
      if (due.length > 0) {
        const watched = await fetchInBatches(refresh, due.map((c) => c.tokenAddress), signal, budget);
        store.transaction(() => {
          for (const candidate of due) {
            const data = watched.byToken.get(candidate.tokenAddress);
            if (!data) continue;
            refreshed += 1;
            queued += queueAlerts(store, testers, {
              tokenAddress: candidate.tokenAddress, pool: data.pool, metrics: data.metrics,
              discoveredAt: candidate.discoveredAt, checkedAt: data.checkedAt,
            });
          }
          store.markChecked(watched.fetched, new Date(now()).toISOString());
        });
      }
    }
    store.setLastScan({
      at: found.checkedAt ?? new Date(now()).toISOString(), ok: found.ok, reason: found.ok ? undefined : found.reason,
      newPools: fresh.length, pages: found.pages ?? 0, refreshed, watching: store.countCandidates(), newMatches: queued,
    });
    store.pruneSeen(new Date(now() - SEEN_RETENTION_MS).toISOString());
    if (queued > 0) log.info?.(`Scan: queued ${queued} alert${queued === 1 ? '' : 's'}.`);
  }
  await deliverPending({ store, send, log, signal, pace, allowedUserIds, now });
}

async function deliverPending({ store, send, log, signal, pace, allowedUserIds, now }) {
  let first = true;
  const since = new Date(now() - ALERT_FRESHNESS_MS).toISOString();
  for (const alert of store.pendingAlerts(since)) {
    if (signal.aborted) return;
    if (!allowedUserIds.has(alert.user_id)) continue;
    if (!first) await pace(ALERT_PACE_MS, signal);
    first = false;
    if (signal.aborted) return;
    // Count the attempt first, so a crash mid-send can never retry forever.
    store.recordAttempt(alert.id);
    try {
      await send(telegramMessage(alert.user_id, alert.message, [alert.token_address]), signal);
      store.markSent(alert.id);
    } catch (error) {
      if (signal.aborted) return;
      if (isPermanentReplyError(error)) {
        // The tester blocked the bot or the chat is gone: stop their scanning.
        store.abandonAlert(alert.id);
        store.setScanning(alert.user_id, false);
        log.warn(`An alert was permanently rejected (${error.code}); scanning was turned off for that tester.`);
      } else {
        log.warn('An alert could not be delivered; it will be retried.');
      }
    }
  }
}

// When the discovery source rate-limits, pause it with exponential backoff
// (1, 2, 4, then at most 5 minutes) instead of asking again every cycle. The
// watch list keeps being re-checked on DexScreener meanwhile.
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 5 * 60_000;
export function withDiscoveryBackoff(discovery, now = Date.now) {
  let pausedUntil = 0;
  let streak = 0;
  return async (signal, options) => {
    if (now() < pausedUntil) return { ok: false, reason: 'RATE_LIMITED', paused: true };
    const result = await discovery(signal, options);
    if (!result.ok && result.reason === 'RATE_LIMITED') {
      streak += 1;
      pausedUntil = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (streak - 1));
    } else if (result.ok) {
      streak = 0;
    }
    return result;
  };
}

export async function runScanner({
  discovery, refresh, store, send, signal, allowedUserIds, log = console,
  intervalMs = DEFAULT_SCAN_INTERVAL_MS, watchMs = DEFAULT_WATCH_MS, now = Date.now,
}) {
  let sourceDownLogged = false;
  const gatedDiscovery = withDiscoveryBackoff(discovery, now);
  while (!signal.aborted) {
    try {
      await runScanCycle({ discovery: gatedDiscovery, refresh, store, send, log, signal, allowedUserIds, now, watchMs, pace: defaultPace });
      const last = store.getLastScan();
      if (last?.ok === false && !sourceDownLogged) {
        log.warn('Discovery source unavailable; scanning keeps retrying. /scan shows this to testers.');
        sourceDownLogged = true;
      } else if (last?.ok) {
        sourceDownLogged = false;
      }
    } catch {
      if (!signal.aborted) log.warn('A scan cycle failed and was skipped; scanning continues.');
    }
    await delay(intervalMs, undefined, { signal }).catch(() => {});
  }
}
