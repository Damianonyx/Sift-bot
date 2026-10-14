import { commandFor } from './bot.js';
import { assertApprovable, describeRule } from './rules.js';
import { criteriaKey } from './discovery-store.js';
import { isSolanaAddress } from './market.js';
import { ALERT_LIMIT, DISCOVERY_COVERAGE } from './discovery.js';

const ISSUES = {
  RULES_CHANGED: 'Approved rules changed; review and start again.',
  FEED_UNAVAILABLE: 'Candidate feed unavailable. Coverage is interrupted.',
  PARTIAL_COVERAGE: 'Some feed rows were invalid or outside this cycle’s limit.',
  MARKET_UNAVAILABLE: 'Some market checks were unavailable; unknown data did not qualify.',
  RISK_UNKNOWN: 'Required risk evidence is incomplete, unsupported or temporarily limited. These candidates did not qualify.',
  DELIVERY_ISSUE: 'An alert delivery failed or is uncertain. Use /alerts to inspect saved reports.',
  DELIVERY_LIMITED: 'Telegram delivery is rate-limited; some alerts are suppressed.',
  CHAT_UNAVAILABLE: 'Telegram denied chat access; scanning was paused.',
  REPORT_TOO_LONG: 'A report could not be delivered. The bot needs a formatting fix.',
};
const button = (text, id, action, version) => ({ text, callback_data: `scan:${id}:${action}:${version}` });

function blockReason(saved) {
  if (saved.draft) return 'Your draft is unapproved. Use /agent to review it. Unresolved liquidity, wallet or bundle requirements cannot be dropped to start a partial scan.';
  if (!saved.approved) return 'No approved rules yet. Use /setup first.';
  try { assertApprovable(saved.approved); } catch { return 'Required checks remain unresolved; scanning cannot start.'; }
  return null;
}

export function scanSummary(agents, id) {
  const scan = agents.discoveryGet(id);
  const lines = [`Your discovery scan: ${scan.state}.`];
  if (scan.last_run !== null) {
    lines.push(`Last cycle: ${new Date(scan.last_run).toISOString()}`,
      `Checked ${scan.checked}; passed required rules ${scan.matched}; suppressed by mute/limits ${scan.suppressed}.`);
  } else lines.push('No cycle has completed for this agent yet.');
  if (scan.issue) lines.push(ISSUES[scan.issue] ?? 'A service issue affected scanning.');
  const undelivered = agents.discoveryIssues(id);
  if (undelivered) lines.push(`${undelivered} saved reports have failed or uncertain delivery. Use /alerts.`);
  if (scan.state === 'active' && scan.last_run !== null && Date.now() - scan.last_run > 180_000) {
    lines.push('The last cycle is over three minutes old. Scanning may be delayed or interrupted.');
  }
  return lines.join('\n');
}

export function createScanCommands({ agents, feed }) {
  return async (update, allowedUserIds, signal) => {
    const cb = update?.callback_query;
    if (typeof cb?.data === 'string' && cb.data.startsWith('scan:')) {
      const id = cb.from?.id;
      const ack = (callbackNotice) => ({ callbackQueryId: cb.id, callbackNotice });
      if (!Number.isSafeInteger(id) || cb.from?.is_bot || typeof cb.id !== 'string' ||
          cb.message?.chat?.type !== 'private' || cb.message.chat.id !== id) return null;
      if (!allowedUserIds.has(id)) return ack('Sift is in private testing.');
      const match = /^scan:([1-9]\d*):(start|view|dismiss|mute):(\d+)$/.exec(cb.data);
      if (!match || Number(match[1]) !== id) return ack('This control does not belong to your agent.');
      return agents.process(update.update_id, () => {
        const action = match[2];
        const value = Number(match[3]);
        if (!Number.isSafeInteger(value)) return ack('This control is invalid.');
        if (action === 'start') {
          const saved = agents.get(id);
          if (saved.revision !== value) return ack('Rules changed. Use /scan for the current review.');
          const reason = blockReason(saved);
          if (reason) return { chat_id: id, text: reason, ...ack('Scanning remains blocked.') };
          agents.discoverySet(id, 'active', criteriaKey(saved.approved));
          return { chat_id: id, text: 'Discovery started for your approved rules. The next cycle begins within about one minute while this bot is running.\n\nUse /pause, /resume, /stop or /scan.\n\n' + DISCOVERY_COVERAGE, ...ack('Discovery started.') };
        }
        const alert = agents.discoveryAlert(id, value);
        if (!alert) return ack('That report is not available for your account.');
        if (action === 'view') return { chat_id: id, text: 'Saved discovery report (not a fresh check):\n\n' + alert.payload.text,
          link_preview_options: { is_disabled: true }, ...ack('Saved report.') };
        if (action === 'mute') agents.discoveryMute(id, alert.token);
        else agents.discoveryDelivery(id, value, 'dismissed');
        return ack(action === 'mute' ? 'Token muted. Use /unmute followed by its CA to undo.' : 'Dismissed in your Sift alert history.');
      });
    }
    const context = commandFor(update);
    if (!context || !allowedUserIds.has(context.userId)) return null;
    const { command, userId: id, args } = context;
    const reply = (text, rows) => ({ chat_id: id, text, link_preview_options: { is_disabled: true }, ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}) });
    if (command === 'scan') {
      const saved = agents.get(id);
      const reason = blockReason(saved);
      const scan = agents.discoveryGet(id);
      return reply([
        scanSummary(agents, id), reason,
        saved.approved ? `Approved rules · ${saved.approved.name}\n${saved.approved.rules.map(describeRule).join('\n')}` : '',
        DISCOVERY_COVERAGE,
        `Private test limits: roughly one cycle/minute, up to ${ALERT_LIMIT} new alerts per cycle per user. Extra matches may be delayed or missed; /scan shows suppression. Quiet hours are not implemented.`,
        'Only approved supported rules are applied. Risk checks have limited coverage; unknown bundle coverage blocks the full risk policy. Market monitoring is separate: use /watch. Unknown required metrics cannot pass. An unapproved edit does not change a running scan’s previously approved rules.',
      ].filter(Boolean).join('\n\n'), !reason && scan.state !== 'active' ? [[button('Start discovery', id, 'start', saved.revision)]] : undefined);
    }
    if (['pause', 'resume', 'stop', 'unmute'].includes(command)) {
      return agents.process(update.update_id, () => {
        if (command === 'unmute') {
          if (!isSolanaAddress(args)) return reply('Send /unmute followed by one full Solana CA.');
          agents.discoveryUnmute(id, args);
          return reply('Token unmuted. Previously attempted alerts will not be repeated for unchanged rules.');
        }
        const scan = agents.discoveryGet(id);
        if (command === 'resume') {
          const saved = agents.get(id);
          const reason = blockReason(saved);
          if (reason) return reply(reason);
          if (scan.state !== 'paused' || scan.criteria_key !== criteriaKey(saved.approved)) return reply('Use /scan to review and start the current approved rules.');
          agents.discoverySet(id, 'active', scan.criteria_key);
          return reply('Discovery resumed. Use /scan for status or /pause to pause again.');
        }
        agents.discoverySet(id, command === 'pause' ? 'paused' : 'stopped', scan.criteria_key);
        agents.watchAllControl(id, command);
        return reply(command === 'pause' ? 'Discovery paused. Market monitors also paused; their end times are unchanged. Use /resume for discovery and /watchlist to resume individual monitors. An alert already being sent may still arrive.' :
          'Discovery stopped. Market monitors also stopped. Your criteria and report history remain saved. Use /scan or /watch to review before starting again. An alert already being sent may still arrive.');
      });
    }
    if (command === 'alerts') {
      const history = agents.discoveryHistory(id);
      if (!history.length) return reply('No discovery reports have been recorded for your agent yet.');
      return reply('Your latest saved discovery reports (not fresh checks):\n\n' + history.map((row) =>
        `#${row.id} · ${row.state === 'pending' ? 'delivery uncertain after interruption' : row.state}\nCA: ${row.token}\n${new Date(row.created_at).toISOString()}`).join('\n\n'),
      history.map((row) => [button(`View report #${row.id}`, id, 'view', row.id)]));
    }
    if (command === 'sources') {
      try {
        const batch = await feed.read({ signal });
        return reply(`Candidate feed responded: ${batch.candidates.length} distinct Solana base-token candidates in ${batch.returnedPools} returned pools; ${batch.invalidPools} invalid pool rows excluded.\nFetched: ${new Date(batch.fetchedAt).toISOString()}${batch.cached ? ' (Sift feed cache; less than one minute old)' : ''}\n\n${DISCOVERY_COVERAGE}\n\nThis checks feed access only. It does not approve your rules or activate scanning.\nSource: ${batch.sourceUrl}`);
      } catch {
        if (signal?.aborted) return null;
        return reply('The candidate feed is unavailable or temporarily limited. No conclusion about available matches can be drawn. Try /sources later; no paid fallback is enabled.');
      }
    }
    return null;
  };
}

