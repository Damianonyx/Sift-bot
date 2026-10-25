import { MarketDataError, isSolanaAddress, sourceUrl } from './market.js';
import { AgentStoreError } from './agent-store.js';
import { TelegramError } from './telegram.js';
import { withCopyableCAs } from './telegram-format.js';
import { evaluateRules, describeRule } from './rules.js';
import { setTimeout as delay } from 'node:timers/promises';
import { REVIEW_TTL } from './watch-store.js';

export const WATCH_SCOPE = 'Market monitoring only: one fixed DEX Screener pool. USD liquidity changes can reflect prices or pool balances; they do not prove a withdrawal or developer sale. Locks, developer holdings/sales/transfers and bundles remain unknown. This does not approve your discovery draft.';
export const utc = (time) => new Date(time).toISOString();
const money = (value) => !Number.isFinite(value) ? 'unknown' : '$' + (value >= 1e15 || (value > 0 && value < 0.01) ? value.toPrecision(5) : value.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function usableWatchSnapshot(snapshot, token, now, pool = null) {
  return snapshot?.address === token && Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt <= now &&
    now - snapshot.fetchedAt <= 120_000 && isSolanaAddress(snapshot.selected?.address) &&
    (!pool || snapshot.selected.address === pool);
}

export async function watchMarketCheck(market, token, options, wait = delay) {
  try { return await market.check(token, options); }
  catch (error) {
    if (!(error instanceof MarketDataError) || error.code !== 'COOLDOWN' || error.retryAfter > 3) throw error;
    await wait(error.retryAfter * 1000, undefined, { signal: options.signal });
    return market.check(token, options);
  }
}

export function watchDetails(row, now = Date.now()) {
  const expired = (['active','paused'].includes(row.state) && row.ends_at <= now) || (row.state === 'review' && now - row.created_at >= REVIEW_TTL);
  const lines = [`Monitor #${row.id} · ${expired ? 'expired' : row.state}`, `Solana CA: ${row.token}`,
    `Alert at a ${row.config.dropPercent}% or greater USD liquidity fall from the starting baseline.`];
  if (row.baseline) {
    lines.push(`Fixed pool: ${row.baseline.selected.address}`,
      `Starting liquidity: ${money(row.baseline.selected.liquidityUsd)} (fetched ${utc(row.baseline.fetchedAt)})`,
      `Scheduled end: ${utc(row.ends_at)}. Pausing stops checks without extending this time.`);
    if (row.last_check) lines.push(`Last check attempt: ${utc(row.last_check)}`);
    if (row.observation) lines.push(`Latest observed liquidity: ${money(row.observation.selected?.liquidityUsd)} (fetched ${utc(row.observation.fetchedAt)})`);
    if (row.state === 'active' && now - row.last_check > 180_000) lines.push('Checks are over three minutes late; monitoring may be interrupted. Events during gaps may be missed.');
  } else lines.push(`Duration after you start: ${row.config.hours} hours. A fresh baseline and pool are selected at start.`);
  if (row.issue) lines.push('Some observations are unavailable. Unknown data is not a passed check.');
  if (row.config.rules.length) {
    const checks = row.baseline ? evaluateRules(row.config.rules, row.baseline, { requireStrict:false }).checks : [];
    lines.push('Captured approved market rules (later agent edits do not change this monitor):\n' + row.config.rules.map((rule) =>
      `${checks.find((c) => c.field === rule.field)?.state.toUpperCase() ?? 'NOT CHECKED'} at baseline · ${describeRule(rule)}`).join('\n'));
  }
  else lines.push('No approved market rules are included; this watches your chosen liquidity-drop threshold only.');
  lines.push(WATCH_SCOPE,
    'Checks run roughly once a minute while the bot runs; shared source limits may delay them. Each alert condition is reported once per monitor, up to three monitoring alerts per user per cycle. Extra reports are saved as suppressed in /watchalerts. Provider update time is unknown; responses may be delayed.');
  return lines.join('\n\n');
}

export function createWatchRunner({ agents, market, call, allowedUserIds, now = Date.now, wait = delay }) {
  let deliveryAfter = 0;
  let deliveries = new Map();
  const current = (row) => {
    if (!allowedUserIds.has(row.user_id)) return null;
    const saved = agents.watchGet(row.user_id, row.id);
    return saved?.state === 'active' && saved.revision === row.revision && saved.ends_at > now() ? saved : null;
  };
  async function notify(row, kind, body, signal) {
    if (!allowedUserIds.has(row.user_id) || signal?.aborted) return;
    const text = `Sift · Monitor #${row.id}\nSolana CA: ${row.token}\n\n${body}\n\nUse /watchlist for controls or /watchalerts for saved reports. Each condition is reported once per monitor; repeated occurrences may not send another alert.`;
    const eventId = agents.watchReserve(row.user_id, row.id, kind, now(), text);
    if (eventId === null) return;
    if (now() < deliveryAfter || (deliveries.get(row.user_id) ?? 0) >= 3) {
      agents.watchDelivery(row.user_id, eventId, 'suppressed');
      return;
    }
    deliveries.set(row.user_id, (deliveries.get(row.user_id) ?? 0) + 1);
    try {
      await call('sendMessage', withCopyableCAs({ chat_id: row.user_id, text,
        link_preview_options: { is_disabled: true } }, [row.token]), signal);
      agents.watchDelivery(row.user_id, eventId, 'sent');
    } catch (error) {
      if (error instanceof AgentStoreError) throw error;
      const definitive = error instanceof TelegramError && Number.isInteger(error.code);
      agents.watchDelivery(row.user_id, eventId, definitive ? 'failed' : 'uncertain');
      if (error instanceof TelegramError && [401,404].includes(error.code)) throw error;
      if (error instanceof TelegramError && error.code === 429) deliveryAfter = now() + error.retryAfter * 1000;
      if (error instanceof TelegramError && error.code === 403) agents.watchAllControl(row.user_id, 'pause');
    }
  }
  return {
    async cycle({ signal } = {}) {
      if (signal?.aborted) return;
      deliveries = new Map();
      for (const row of agents.watchExpire(now())) {
        await notify(row, 'ended', `Monitoring ended at ${utc(row.ends_at)}. No further checks will run for this monitor.\nLast check attempt: ${row.last_check ? utc(row.last_check) : 'none'}.\nAny events during pauses or downtime may have been missed; no catch-up is available.`, signal);
      }
      const snapshots = new Map();
      for (const row of agents.watchActive()) {
        if (!current(row) || signal?.aborted) continue;
        let snapshot = null, issue = null;
        const pinnedPool = row.baseline.selected.address;
        const key = row.token + ':' + pinnedPool;
        try {
          // Share a failed request too, rather than retrying the same outage
          // once for every user monitoring this pool during the cycle.
          if (!snapshots.has(key)) snapshots.set(key, watchMarketCheck(market, row.token, { signal, poolAddress: pinnedPool }, wait));
          snapshot = await snapshots.get(key);
          if (!usableWatchSnapshot(snapshot, row.token, now(), pinnedPool)) { snapshot = null; issue = 'SOURCE_UNAVAILABLE'; }
          else if (!Number.isFinite(snapshot.selected.liquidityUsd) || snapshot.selected.liquidityUsd < 0) issue = 'LIQUIDITY_UNKNOWN';
        } catch (error) {
          if (error instanceof AgentStoreError) throw error;
          if (signal?.aborted) return;
          issue = 'SOURCE_UNAVAILABLE';
        }
        if (!current(row) || signal?.aborted) continue;
        const checks = snapshot && row.config.rules.length ? evaluateRules(row.config.rules, snapshot, { requireStrict:false }).checks : [];
        if (checks.some((r) => r.state === 'unknown')) issue ??= 'METRIC_UNKNOWN';
        if (!agents.watchObserve(row.user_id, row.id, row.revision, snapshot, issue, now())) continue;
        const evidence = `Fixed pool: ${pinnedPool}\nChart: https://dexscreener.com/solana/${pinnedPool}\nSource: ${sourceUrl(row.token)}\n${snapshot ? 'API fetched: ' + utc(snapshot.fetchedAt) : 'Check attempted: ' + utc(now())}\nProvider update time: unknown; data may be delayed. No cross-cycle Sift market cache.`;
        const events = [];
        if (now() - row.last_check > 180_000) events.push(['gap', 'Monitoring resumed after a gap of over three minutes. Events during this gap may have been missed.']);
        if (issue) events.push(['unavailable', 'Monitoring data is unavailable or incomplete. A missing pool or metric is UNKNOWN, not zero and not a passed check. The baseline remains unchanged. Check /watchlist for current status.']);
        else if (row.issue) events.push(['recovered', 'Market observations are available again. This does not recover events missed during the interruption.']);
        if (snapshot && Number.isFinite(snapshot.selected.liquidityUsd) && snapshot.selected.liquidityUsd >= 0) {
          const baseline = row.baseline.selected.liquidityUsd;
          const drop = (baseline - snapshot.selected.liquidityUsd) / baseline * 100;
          if (drop >= row.config.dropPercent) events.push(['liquidity_drop',
            `USD liquidity fell ${drop.toFixed(2)}% from the starting baseline (${money(baseline)} → ${money(snapshot.selected.liquidityUsd)}).\nYour threshold: ${row.config.dropPercent}%.\nThis may reflect prices or balances; it does not prove liquidity removal, a developer sale or a broken lock.`]);
        }
        for (const check of checks) {
          if (check.state === 'pass') continue;
          events.push([`${check.field}_${check.state}`, `${check.state.toUpperCase()} · ${describeRule(check)}\nObserved value: ${check.valueObserved ?? 'unknown'}${check.field === 'poolAgeMinutes' ? ' minutes' : ' USD'}.\nCompared with the market rule captured when you reviewed this monitor. Unknown does not prove a breach or pass.`]);
        }
        for (const [kind, body] of events) {
          if (!current(row) || signal?.aborted) break;
          await notify(row, kind, body + '\n\n' + evidence, signal);
        }
      }
    },
  };
}

