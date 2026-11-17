import { setTimeout as delay } from 'node:timers/promises';
import { evaluate, formatAlert } from './rules.js';
import { isPermanentReplyError } from './telegram.js';

// The automatic discovery-to-alert loop. Every cycle: fetch the newest Solana
// pools (only while at least one tester is scanning), evaluate each unseen
// pool against every scanning tester's approved criteria, record one alert
// per tester and token in the store's ledger, then deliver pending alerts.
// Delivery is at-least-once with bounded retries; a tester who blocks the bot
// has scanning turned off. The loop never throws except on abort: a scanner
// problem must never take down the reply loop.
export const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const SEEN_RETENTION_MS = 24 * 60 * 60 * 1000;
// Telegram allows roughly one message per second per chat; loose criteria can
// match a whole page of new pools at once, so alert delivery is paced to keep
// a burst from tripping rate limits and burning retry attempts.
export const ALERT_PACE_MS = 1_100;
const defaultPace = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});

// One pass, exported for tests. Returns counts for logging and /scan status.
export async function runScanCycle({ discovery, store, send, log, signal, now = Date.now, pace = defaultPace }) {
  const testers = store.scanningAgents();
  if (testers.length > 0) {
    const result = await discovery(signal);
    if (!result.ok) {
      store.setLastScan({ at: new Date(now()).toISOString(), ok: false });
    } else {
      let matches = 0;
      for (const pool of result.pools) {
        if (store.wasSeen(pool.poolAddress)) continue;
        store.markSeen(pool.poolAddress, result.checkedAt);
        for (const tester of testers) {
          const evaluation = evaluate(tester.approved.rules, pool.metrics);
          if (evaluation.verdict !== 'pass') continue;
          const message = formatAlert(evaluation, { version: tester.version, pool, checkedAt: result.checkedAt });
          if (store.createAlert(tester.userId, pool.tokenAddress, pool.poolAddress, message)) matches += 1;
        }
      }
      store.setLastScan({ at: result.checkedAt, ok: true, pools: result.pools.length, newMatches: matches });
      store.pruneSeen(new Date(now() - SEEN_RETENTION_MS).toISOString());
    }
  }
  await deliverPending({ store, send, log, signal, pace });
}

async function deliverPending({ store, send, log, signal, pace }) {
  let first = true;
  for (const alert of store.pendingAlerts()) {
    if (signal.aborted) return;
    if (!first) await pace(ALERT_PACE_MS, signal);
    first = false;
    if (signal.aborted) return;
    // Count the attempt first, so a crash mid-send can never retry forever.
    store.recordAttempt(alert.id);
    try {
      await send({ chat_id: alert.user_id, text: alert.message }, signal);
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

export async function runScanner({
  discovery, store, send, signal, log = console,
  intervalMs = DEFAULT_SCAN_INTERVAL_MS, now = Date.now,
}) {
  let sourceDownLogged = false;
  while (!signal.aborted) {
    try {
      await runScanCycle({ discovery, store, send, log, signal, now, pace: defaultPace });
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
