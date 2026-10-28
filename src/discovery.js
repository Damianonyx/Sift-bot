import { setTimeout as delay } from 'node:timers/promises';
import { assertApprovable, evaluateAgent, formatRuleEvaluation } from './rules.js';
import { criteriaKey } from './discovery-store.js';
import { formatTokenReport } from './token-report.js';
import { MarketDataError, isSolanaAddress } from './market.js';
import { AgentStoreError } from './agent-store.js';
import { TelegramError } from './telegram.js';
import { withCopyableCAs } from './telegram-format.js';
import { attachRisk, needsRisk, RISK_FIELDS, formatRiskReport } from './risk.js';
import { CANDIDATE_LIMIT, DISCOVERY_COVERAGE, formatCandidateSource } from './candidate-sources.js';
import { signalCard, evidencePages } from './signal-report.js';
import { quietNow } from './intelligence-store.js';

export const MAX_CANDIDATES = CANDIDATE_LIMIT;
export const ALERT_LIMIT = 3;
export const SCAN_INTERVAL_MS = 60_000;
export { DISCOVERY_COVERAGE };

export function formatDiscoveryAlert(agent, snapshot, feed, candidate) {
  return [
    `Discovery match · ${agent.name}`,
    formatTokenReport(snapshot, { hasApprovedRules: true, discovery: true }),
    formatRuleEvaluation(agent, snapshot, { discovery: true }),
    formatCandidateSource(candidate, feed),
    snapshot.risk ? formatRiskReport(snapshot.risk,{ compact:true }) : 'Only your approved market checks determined this match. Risk checks were not requested.',
    'Use /risk <CA> for detailed risk evidence. Monitor sets up market monitoring.',
  ].join('\n\n');
}

export function createDiscoveryRunner({ feed, market, agents, risk, groups, call, allowedUserIds, now = Date.now, wait = delay }) {
  let nextDeliveryAt = 0;
  const usable = (snapshot, token) => snapshot?.address === token &&
    Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt <= now() && now() - snapshot.fetchedAt <= 120_000 &&
    (!snapshot.selected || isSolanaAddress(snapshot.selected.address));
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
    groups?.beginCycle();
    const scans = agents.discoveryActive().filter((scan) => current(scan.user_id, scan.criteria_key));
    const groupScans=groups?.targets?.()??[];
    const groupStats=new Map(groupScans.map(g=>[g.chat_id,{checked:0,matched:0,issue:null}]));
    if (!scans.length && !groupScans.length || signal?.aborted) return;
    const stats = new Map(scans.map((scan) => [scan.user_id, { checked: 0, matched: 0, suppressed: 0, issue: null, sent: 0 }]));
    const finish = () => {
      for (const scan of scans) agents.discoveryComplete(scan.user_id, scan.criteria_key, stats.get(scan.user_id), now());
      for(const g of groupScans){const s=groupStats.get(g.chat_id);agents.groupComplete(g.chat_id,now(),s.checked,s.matched,s.issue);}
    };
    let batch;
    try { batch = await feed.read({ signal }); }
    catch {
      if (signal?.aborted) return;
      for (const stat of stats.values()) stat.issue = 'FEED_UNAVAILABLE';
      for(const stat of groupStats.values())stat.issue='FEED_UNAVAILABLE';
      finish();
      return;
    }
    if (batch.partial || batch.invalidPools || batch.candidates.length > MAX_CANDIDATES) {
      for (const stat of stats.values()) stat.issue = 'PARTIAL_COVERAGE';
      for(const stat of groupStats.values())stat.issue='PARTIAL_COVERAGE';
    }
    for (const candidate of batch.candidates.slice(0, MAX_CANDIDATES)) {
      if (signal?.aborted) return;
      if (!scans.some((scan) => current(scan.user_id, scan.criteria_key)) && !groups?.targets?.().length) break;
      feed.selected?.([candidate]);
      let snapshot;
      try {
        try { snapshot = await market.check(candidate.address, { signal }); }
        catch (error) {
          // Share the existing process-wide market rate limit with /check.
          if (!(error instanceof MarketDataError) || error.code !== 'COOLDOWN' || error.retryAfter > 3) throw error;
          await wait(error.retryAfter * 1000, undefined, { signal });
          snapshot = await market.check(candidate.address, { signal });
        }
        if (!usable(snapshot, candidate.address)) throw new MarketDataError('INVALID_RESPONSE');
      } catch {
        if (signal?.aborted) return;
        for(const stat of groupStats.values())stat.issue='MARKET_UNAVAILABLE';
        for (const scan of scans) {
          if (!current(scan.user_id, scan.criteria_key)) continue;
          stats.get(scan.user_id).issue = 'MARKET_UNAVAILABLE';
          agents.discoveryRecord(scan.user_id, scan.criteria_key, candidate.address, now(), { matches: false, issue: 'MARKET_UNAVAILABLE' });
        }
        continue;
      }
      const riskNeeded = scans.some((scan) => {
        const approved = current(scan.user_id,scan.criteria_key);
        if (!approved || !needsRisk(approved.rules)) return false;
        // Avoid expensive chain reads for candidates already failing required market rules.
        return evaluateAgent(approved,snapshot,{ now:now() }).checks.filter((r) => r.mode === 'require' && !RISK_FIELDS.includes(r.field)).every((r) => r.state === 'pass');
      }) || groupScans.some(g=>needsRisk(g.strategy.rules)&&evaluateAgent(g.strategy,snapshot,{now:now()}).checks.filter(r=>r.mode==='require'&&!RISK_FIELDS.includes(r.field)).every(r=>r.state==='pass'));
      if (riskNeeded && risk) snapshot = await attachRisk(snapshot,risk,{ signal, candidate });
      for (const scan of scans) {
        const id = scan.user_id;
        const approved = current(id, scan.criteria_key);
        if (!approved || signal?.aborted) continue;
        const stat = stats.get(id);
        const fresh = usable(snapshot, candidate.address);
        const result = evaluateAgent(approved, fresh ? snapshot : { ...snapshot, selected:null, risk:null },{ now:now() });
        if (result.checks.some((r) => RISK_FIELDS.includes(r.field) && r.state === 'unknown')) stat.issue = 'RISK_UNKNOWN';
        stat.checked++;
        if (!snapshot.selected) stat.issue = 'MARKET_NOT_INDEXED';
        if (!fresh) stat.issue = 'MARKET_UNAVAILABLE';
        agents.discoveryRecord(id, scan.criteria_key, candidate.address, snapshot.fetchedAt, result);
        if (!result.matches) continue;
        stat.matched++;
        // A private mute/quiet period also suppresses inherited destinations.
        // Private delivery deduplication/caps do not consume a group's own budget.
        if (agents.discoveryMuted(id, candidate.address) || quietNow(agents.preferences(id),now())) { stat.suppressed++; continue; }
        const text = signalCard(approved, snapshot, {now:now(),batch,candidate});
        if (text.length > 4000) { stat.issue = 'REPORT_TOO_LONG'; continue; } // leave room for /alerts history header
        const pages = evidencePages(approved,snapshot,batch,candidate);
        if (!agents.discoverySeen(id, scan.criteria_key, candidate.address)) {
          if (stat.sent >= ALERT_LIMIT) stat.suppressed++;
          else if (now() < nextDeliveryAt) { stat.suppressed++; stat.issue = 'DELIVERY_LIMITED'; }
          else {
            const eventId = agents.discoveryReserve(id, scan.criteria_key, candidate.address, now(), { text, snapshot, strategy:approved, evidence:pages });
            if (eventId !== null) {
              stat.sent++;
              try {
                await call('sendMessage', withCopyableCAs({ chat_id: id, text, link_preview_options: { is_disabled: true },
                  reply_markup: { inline_keyboard: [[{ text: 'View evidence', callback_data: `evidence:${id}:${eventId}:0` }], [{ text: 'Monitor', callback_data: `watch:${id}:prompt:${eventId}:0` }], [
                    { text: 'Dismiss', callback_data: `scan:${id}:dismiss:${eventId}` },
                    { text: 'Mute token', callback_data: `scan:${id}:mute:${eventId}` },
                  ]] } }, [candidate.address]), signal);
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
        }
        if (now() >= nextDeliveryAt && current(id, scan.criteria_key) && usable(snapshot,candidate.address) &&
          !agents.discoveryMuted(id,candidate.address) && !quietNow(agents.preferences(id),now())) {
          await groups?.deliver(id, scan.criteria_key, candidate.address, text, { signal, snapshot, strategy:approved, pages });
        }
      }
      for(const g of groupScans) {
        if(signal?.aborted)return;
        const result=await groups.match(g,snapshot,batch,candidate,{signal}),s=groupStats.get(g.chat_id);
        if(result){s.checked++;if(result.matches)s.matched++;if(result.checks.some(r=>r.state==='unknown'))s.issue='UNKNOWN_REQUIRED_OR_WARNING_DATA';}
      }
    }
    finish();
  }

  return {
    cycle,
    async run({ signal, beforeCycle, afterCycle }) {
      while (!signal.aborted) {
        const startedAt = now();
        await beforeCycle?.({ signal });
        await cycle({ signal });
        await afterCycle?.({signal});
        if (!signal.aborted) await wait(Math.max(1000, SCAN_INTERVAL_MS - (now() - startedAt)), undefined, { signal });
      }
    },
  };
}

