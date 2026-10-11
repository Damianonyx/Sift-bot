import { commandFor, replyFor } from './bot.js';
import { createMarketData, isSolanaAddress, MarketDataError } from './market.js';
import { formatTokenReport } from './token-report.js';

export function createResponder({ market = createMarketData() } = {}) {
  return async (update, allowedUserIds, signal) => {
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
      return response;
    }
    if (context.command !== 'check') return replyFor(update, allowedUserIds);
    const reply = (text) => ({ chat_id: context.chatId, text, link_preview_options: { is_disabled: true } });
    if (!isSolanaAddress(context.args)) {
      return reply('Send /check followed by one full Solana token mint address (CA).\n\nExample format: /check <CA>\nUse the CA itself, without a link. Only Solana is supported in this test.');
    }
    try {
      const snapshot = await market.check(context.args, { signal });
      return reply(formatTokenReport(snapshot));
    } catch (error) {
      if (signal?.aborted) return null;
      if (error instanceof MarketDataError && ['COOLDOWN', 'RATE_LIMITED'].includes(error.code)) {
        return reply(`Market checks are temporarily limited. Try again in ${error.retryAfter} seconds.\nNo token assessment was made.`);
      }
      return reply('DEX Screener data is unavailable or could not be read. No token assessment was made.\n\nTry /check again later. Missing data does not count as a passed check.');
    }
  };
}
