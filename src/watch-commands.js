import { commandFor } from './bot.js';
import { MARKET_FIELDS } from './rules.js';
import { isSolanaAddress } from './market.js';
import { WATCH_LIMIT, TOTAL_WATCH_LIMIT, REVIEW_TTL } from './watch-store.js';
import { watchDetails, usableWatchSnapshot, watchMarketCheck } from './watch.js';

const button = (text, row, action) => ({ text, callback_data: `watch:${row.user_id}:${action}:${row.id}:${row.revision}` });
const reply = (id, text, rows) => ({ chat_id: id, text, link_preview_options: { is_disabled: true },
  ...(rows?.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
function controls(row, now) {
  if (row.state === 'review' && now - row.created_at < REVIEW_TTL) return [[button('Start market monitoring', row, 'start'), button('Cancel', row, 'stop')]];
  if (!['active','paused'].includes(row.state) || row.ends_at <= now) return [];
  const rows = [[button(row.state === 'active' ? 'Pause' : 'Resume', row, row.state === 'active' ? 'pause' : 'resume'), button('Stop', row, 'stop')]];
  if (row.ends_at + 86_400_000 <= row.started_at + 168 * 3_600_000) rows.push([button('Extend by 24 hours', row, 'extend')]);
  return rows;
}
const USAGE = 'Send /watch CA DROP_PERCENT HOURS\n\nReplace CA with a full Solana mint address. Choose the percentage fall from starting USD liquidity (greater than 0, up to 100), then a duration of 1–168 whole hours.\n\nFor example, /watch <CA> 20 24 asks for a 20% drop alert over 24 hours. These are example values, not a trading recommendation. You will review before starting.\n\nThis watches market data only, not locks or developer activity. Your discovery rules stay unchanged.';

export function watchSummary(agents, id, now = Date.now()) {
  const open = agents.watchOpen(now).filter((row) => row.user_id === id);
  const issues = agents.watchIssues(id);
  return `Your market monitors: ${open.filter((r) => r.state === 'active').length} active, ${open.filter((r) => r.state === 'paused').length} paused, ${open.filter((r) => r.state === 'review').length} awaiting approval. Use /watchlist.\n${issues} monitoring reports have failed, suppressed or uncertain delivery; use /watchalerts.`;
}

export function createWatchCommands({ agents, market, now = Date.now, wait }) {
  return async (update, allowedUserIds, signal) => {
    if (signal?.aborted) return null;
    const cb = update?.callback_query;
    if (typeof cb?.data === 'string' && cb.data.startsWith('watch:')) {
      const id = cb.from?.id;
      const ack = (callbackNotice) => ({ callbackQueryId: cb.id, callbackNotice });
      if (!Number.isSafeInteger(id) || cb.from?.is_bot || typeof cb.id !== 'string' || cb.message?.chat?.type !== 'private' || cb.message.chat.id !== id) return null;
      if (!allowedUserIds.has(id)) return ack('Sift is in private testing.');
      const match = /^watch:([1-9]\d*):(start|view|pause|resume|stop|extend|event|prompt):(\d+):(\d+)$/.exec(cb.data);
      if (!match || Number(match[1]) !== id || !Number.isSafeInteger(Number(match[3])) || !Number.isSafeInteger(Number(match[4]))) return ack('This control is not available for your account.');
      const [, , action, rawId, rawRevision] = match;
      const value = Number(rawId), revision = Number(rawRevision);
      const receipt = agents.receipt(update.update_id);
      if (receipt) return receipt;
      if (action === 'event') {
        const event = agents.watchEvent(id, value);
        return event ? { ...reply(id, 'Saved monitoring report (not a fresh check):\n\n' + event.text), ...ack('Saved report.') } : ack('Report not available for your account.');
      }
      if (action === 'prompt') {
        const event = agents.discoveryAlert(id, value);
        return event ? { ...reply(id, `Choose your drop percentage and duration:\n/watch ${event.token} DROP_PERCENT HOURS\n\nThen review the monitoring limits before starting. Your discovery rules are unchanged.`), ...ack('Choose monitoring thresholds.') } : ack('Report not available for your account.');
      }
      const row = agents.watchGet(id, value);
      if (!row) return ack('Monitor not available for your account.');
      if (action === 'view') return { ...reply(id, watchDetails(row, now()), controls(row, now())), ...ack('Monitor status.') };
      if (row.revision !== revision) return ack('This control is old. Use /watchlist for current controls.');
      let snapshot;
      if (action === 'start') {
        if (row.state !== 'review' || now() - row.created_at >= REVIEW_TTL) return ack('Review expired. Start again with /watch.');
        try { snapshot = await watchMarketCheck(market, row.token, { signal }, wait); }
        catch {
          if (signal?.aborted) return null;
          return { ...reply(id, 'Market data is unavailable or temporarily limited. Monitoring has not started. Retry from /watchlist.'), ...ack('Could not establish a baseline.') };
        }
        if (signal?.aborted || !allowedUserIds.has(id)) return null;
        if (!usableWatchSnapshot(snapshot, row.token, now()) || !Number.isFinite(snapshot.selected.liquidityUsd) || snapshot.selected.liquidityUsd <= 0) {
          return { ...reply(id, 'No fresh response with a supported pool and known positive USD liquidity. Monitoring has not started; missing data cannot form a baseline.'), ...ack('Baseline unavailable.') };
        }
      }
      return agents.process(update.update_id, () => {
        const changed = action === 'start' ? agents.watchStart(id, value, revision, snapshot, now()) : agents.watchControl(id, value, revision, action, now());
        return changed ? { ...reply(id, watchDetails(changed, now()), controls(changed, now())), ...ack(action === 'start' ? 'Market monitoring started.' : 'Monitor updated.') } : ack('Monitor changed or expired. Use /watchlist.');
      });
    }
    const context = commandFor(update);
    if (!context || !allowedUserIds.has(context.userId)) return null;
    const { userId: id, command, args } = context;
    if (command === 'watch') {
      const parts = args.split(/\s+/);
      if (parts.length !== 3 || !isSolanaAddress(parts[0]) || !/^\d+(?:\.\d{1,2})?%?$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return reply(id, USAGE);
      const dropPercent = Number(parts[1].replace('%','')), hours = Number(parts[2]);
      if (dropPercent <= 0 || dropPercent > 100 || hours < 1 || hours > 168) return reply(id, USAGE);
      return agents.process(update.update_id, () => {
        const saved = agents.get(id);
        const row = agents.watchCreate(id, parts[0], { dropPercent, hours, rules: saved.approved?.rules.filter((r) => MARKET_FIELDS.includes(r.field)) ?? [] }, now());
        if (!row) return reply(id, `A monitor for that token already exists, or the private-test capacity is full (${WATCH_LIMIT} open monitors per user; ${TOTAL_WATCH_LIMIT} total). Use /watchlist to review or stop one.`);
        return reply(id, 'Review market monitoring · expires in 10 minutes\n\n' + watchDetails(row, now()), controls(row, now()));
      });
    }
    if (command === 'watchlist') {
      const rows = agents.watchList(id);
      return reply(id, watchSummary(agents, id, now()) + '\n\n' + (rows.length ? rows.map((r) =>
        `#${r.id} · ${(r.ends_at && r.ends_at <= now() && ['active','paused'].includes(r.state)) || (r.state === 'review' && now() - r.created_at >= REVIEW_TTL) ? 'expired' : r.state}\nCA: ${r.token}`).join('\n\n') : 'No monitors yet. Use /watch for setup.'),
      rows.map((r) => [button(`View monitor #${r.id}`, r, 'view')]));
    }
    if (command === 'watchalerts') {
      const rows = agents.watchHistory(id);
      return reply(id, rows.length ? 'Your latest saved monitoring reports (not fresh checks):\n\n' + rows.map((r) =>
        `#${r.id} · monitor #${r.watch_id} · ${r.state === 'pending' ? 'delivery uncertain after interruption' : r.state}\n${new Date(r.created_at).toISOString()}`).join('\n\n') : 'No monitoring reports recorded yet.',
      rows.map((r) => [{ text: `View report #${r.id}`, callback_data: `watch:${id}:event:${r.id}:0` }]));
    }
    return null;
  };
}

