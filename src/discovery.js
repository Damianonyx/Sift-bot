import { setTimeout as delay } from 'node:timers/promises';
import { assertApprovable, evaluateAgent, formatRuleEvaluation } from './rules.js';
import { criteriaKey } from './discovery-store.js';
import { formatTokenReport } from './token-report.js';
import { MarketDataError } from './market.js';
import { AgentStoreError } from './agent-store.js';
import { TelegramError } from './telegram.js';

export const MAX_CANDIDATES = 20;
export const ALERT_LIMIT = 3;
export const SCAN_INTERVAL_MS = 60_000;
export const DISCOVERY_COVERAGE = 'Solana · GeckoTerminal new-pools first page only; up to 20 base-token candidates per cycle. DEX Screener selects the pool used for your market checks. New/unindexed venues and quote-only tokens may be missed. Provider update time is unknown.';

export function formatDiscoveryAlert(agent, snapshot, feed) {
  return [
    `Discovery match · ${agent.name}`,
    formatTokenReport(snapshot, { hasApprovedRules: true, discovery: true }),
    formatRuleEvaluation(agent, snapshot, { discovery: true }),
    `Candidate source: ${feed.sourceUrl}\nFeed fetched: ${new Date(feed.fetchedAt).toISOString()}${feed.cached ? ' (Sift feed cache)' : ''}`,
    'Only your approved checks determined this match. Liquidity protection, wallet activity and bundles remain unsupported. Follow-up monitoring is not connected.',
  ].join('\n\n');
}

export function createDiscoveryRunner({ feed, market, agents, call, allowedUserIds, now = Date.now, wait = delay }) {
  let nextDeliveryAt = 0;
  function current(id, key) {
    if (!allowedUserIds.has(id)) return null;
    const scan = agents.discoveryGet(id);
    if (scan.state !== 'active' || scan.criteria_key !== key) return null;
    const approved = agents.get(id).approved;
    try {
      if (!approved || criteriaKey(approved) !== key) throw new Error();
      assertApprovable(approved);
    } catch {
      agents.discoverySet(id, 'paused', key, 'RULES_CHANGED');
      return null;
    }
    return approved;
  }

  async function cycle({ signal } = {}) {
    const scans = agents.discoveryActive().filter((scan) => current(scan.user_id, scan.criteria_key));
    if (!scans.length || signal?.aborted) return;
    const stats = new Map(scans.map((scan) => [scan.user_id, { checked: 0, matched: 0, suppressed: 0, issue: null, sent: 0 }]));
    const finish = () => {
      for (const scan of scans) agents.discoveryComplete(scan.user_id, scan.criteria_key, stats.get(scan.user_id), now());
    };
    let batch;
    try { batch = await feed.read({ signal }); }
    catch {
      if (signal?.aborted) return;
      for (const stat of stats.values()) stat.issue = 'FEED_UNAVAILABLE';
      finish();
      return;
    }
    if (batch.invalidPools || batch.candidates.length > MAX_CANDIDATES) {
      for (const stat of stats.values()) stat.issue = 'PARTIAL_COVERAGE';
    }
    for (const candidate of batch.candidates.slice(0, MAX_CANDIDATES)) {
      if (signal?.aborted) return;
      if (!scans.some((scan) => current(scan.user_id, scan.criteria_key))) break;
      let snapshot;
      try {
        try { snapshot = await market.check(candidate.address, { signal }); }
        catch (error) {
          // Share the existing process-wide market rate limit with /check.
          if (!(error instanceof MarketDataError) || error.code !== 'COOLDOWN' || error.retryAfter > 3) throw error;
          await wait(error.retryAfter * 1000, undefined, { signal });
          snapshot = await market.check(candidate.address, { signal });
        }
      } catch {
        if (signal?.aborted) return;
        for (const scan of scans) {
          if (!current(scan.user_id, scan.criteria_key)) continue;
          stats.get(scan.user_id).issue = 'MARKET_UNAVAILABLE';
          agents.discoveryRecord(scan.user_id, scan.criteria_key, candidate.address, now(), { matches: false, issue: 'MARKET_UNAVAILABLE' });
        }
        continue;
      }
      for (const scan of scans) {
        const id = scan.user_id;
        const approved = current(id, scan.criteria_key);
        if (!approved || signal?.aborted) continue;
        const stat = stats.get(id);
        const result = evaluateAgent(approved, snapshot);
        stat.checked++;
        agents.discoveryRecord(id, scan.criteria_key, candidate.address, snapshot.fetchedAt, result);
        if (!result.matches) continue;
        stat.matched++;
        if (agents.discoverySeen(id, scan.criteria_key, candidate.address)) continue;
        if (agents.discoveryMuted(id, candidate.address) || stat.sent >= ALERT_LIMIT) { stat.suppressed++; continue; }
        if (now() < nextDeliveryAt) { stat.suppressed++; stat.issue = 'DELIVERY_LIMITED'; continue; }
        const text = formatDiscoveryAlert(approved, snapshot, batch);
        if (text.length > 4000) { stat.issue = 'REPORT_TOO_LONG'; continue; } // leave room for /alerts history header
        const eventId = agents.discoveryReserve(id, scan.criteria_key, candidate.address, now(), { text });
        if (eventId === null) continue;
        stat.sent++;
        try {
          await call('sendMessage', { chat_id: id, text, link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [[
              { text: 'Dismiss', callback_data: `scan:${id}:dismiss:${eventId}` },
              { text: 'Mute token', callback_data: `scan:${id}:mute:${eventId}` },
            ]] } }, signal);
          agents.discoveryDelivery(id, eventId, 'sent');
        } catch (error) {
          if (error instanceof AgentStoreError) throw error;
          const definitive = error instanceof TelegramError && Number.isInteger(error.code);
          agents.discoveryDelivery(id, eventId, definitive ? 'failed' : 'uncertain');
          stat.issue = 'DELIVERY_ISSUE';
          if (error instanceof TelegramError && [401, 404].includes(error.code)) throw error;
          if (error instanceof TelegramError && error.code === 429) nextDeliveryAt = now() + error.retryAfter * 1000;
          if (error instanceof TelegramError && error.code === 403) agents.discoverySet(id, 'paused', scan.criteria_key, 'CHAT_UNAVAILABLE');
          // No blind retry after an ambiguous send. The saved report is in /alerts.
        }
      }
    }
    finish();
  }

  return {
    cycle,
    async run({ signal }) {
      while (!signal.aborted) {
        const startedAt = now();
        await cycle({ signal });
        if (!signal.aborted) await wait(Math.max(1000, SCAN_INTERVAL_MS - (now() - startedAt)), undefined, { signal });
      }
    },
  };
}
