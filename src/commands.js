import { commandFor, replyFor } from './bot.js';
import { createMarketData, isSolanaAddress, MarketDataError } from './market.js';
import { formatTokenReport } from './token-report.js';
import { createAgentSetup } from './agent-setup.js';
import { formatRuleEvaluation } from './rules.js';

export function createResponder({ market = createMarketData(), agents } = {}) {
  const agentSetup = agents ? createAgentSetup(agents) : null;
  return async (update, allowedUserIds, signal) => {
    const agentReply = agentSetup?.(update, allowedUserIds);
    if (agentReply) return agentReply;
    const context = commandFor(update);
    // Authorize before inspecting addresses or making any market-data request.
    if (!context || !allowedUserIds.has(context.userId)) return replyFor(update, allowedUserIds);
    if (context.command === 'status') {
      const response = replyFor(update, allowedUserIds);
      const health = market.status();
      const states = { not_checked: 'not checked this session', responded: 'last request succeeded', unavailable: 'last request failed; market data may be unavailable' };
      response.text += `\n\nDEX Screener: ${states[health.state]}.`;
      if (health.checkedAt !== null) response.text += `\nSource last checked: ${new Date(health.checkedAt).toISOString()}`;
      response.text += '\nA successful API request does not establish how fresh the provider data is.';
      if (agents) {
        const saved = agents.get(context.userId);
        response.text += `\n\nYour saved criteria: ${saved.approved ? 'approved' : 'none approved'}${saved.draft ? '; draft in progress' : ''}. Use /agent to review.`;
      }
      return response;
    }
    if (context.command !== 'check') return replyFor(update, allowedUserIds);
    const reply = (text) => ({ chat_id: context.chatId, text, link_preview_options: { is_disabled: true } });
    if (!isSolanaAddress(context.args)) {
      return reply('Send /check followed by one full Solana token mint address (CA).\n\nExample format: /check <CA>\nUse the CA itself, without a link. Only Solana is supported in this test.');
    }
    const saved = agents?.get(context.userId);
    const approved = saved?.approved;
    let snapshot;
    try {
      snapshot = await market.check(context.args, { signal });
    } catch (error) {
      if (signal?.aborted) return null;
      if (error instanceof MarketDataError && ['COOLDOWN', 'RATE_LIMITED'].includes(error.code)) {
        return reply(`Market checks are temporarily limited. Try again in ${error.retryAfter} seconds.\nNo token assessment was made.`);
      }
      return reply('DEX Screener data is unavailable or could not be read. No token assessment was made.\n\nTry /check again later. Missing data does not count as a passed check.');
    }
    const assessment = approved ? '\n\n' + formatRuleEvaluation(approved, snapshot) : '';
    const draftNotice = saved?.draft ? '\n\nYou have an unapproved draft. It is not applied here; use /agent to review it.' : '';
    return reply(formatTokenReport(snapshot, { hasApprovedRules: Boolean(approved) }) + assessment + draftNotice);
  };
}
