import { commandFor, replyFor } from './bot.js';
import { createMarketData, isSolanaAddress, MarketDataError } from './market.js';
import { formatTokenReport } from './token-report.js';
import { createAgentSetup } from './agent-setup.js';
import { formatRuleEvaluation } from './rules.js';
import { createScanCommands, scanSummary } from './scan-commands.js';
import { createLiquidityData, formatLiquidityReport } from './liquidity.js';
import { SolanaRpcError } from './solana-rpc.js';
import { createWatchCommands, watchSummary } from './watch-commands.js';
import { createRiskData, attachRisk, needsRisk, formatRiskReport } from './risk.js';
import { createBundleData, isBundleId } from './bundle-evidence.js';
import { formatSourceHealth } from './candidate-sources.js';
import { withCopyableCAs } from './telegram-format.js';

export function createResponder({ market = createMarketData(), agents, feed, groups, descriptionCommands, aiEnabled = false, liquidity = createLiquidityData(), risk = createRiskData({ liquidity }), bundles = createBundleData(), now = Date.now, wait } = {}) {
  const agentSetup = agents ? createAgentSetup(agents) : null;
  const scanCommands = agents && feed ? createScanCommands({ agents, feed }) : null;
  const watchCommands = agents ? createWatchCommands({ agents, market, now, wait }) : null;
  return async (update, allowedUserIds, signal) => {
    const groupReply = await groups?.respond(update, signal);
    if (groupReply) return groupReply;
    const descriptionReply = await descriptionCommands?.(update, allowedUserIds, signal);
    if (descriptionReply) return descriptionReply;
    const watchReply = await watchCommands?.(update, allowedUserIds, signal);
    if (watchReply) return watchReply;
    const scanReply = await scanCommands?.(update, allowedUserIds, signal);
    if (scanReply) return scanReply;
    const agentReply = agentSetup?.(update, allowedUserIds);
    if (agentReply) return agentReply;
    const context = commandFor(update);
    // Authorize before inspecting addresses or making any market-data request.
    if (!context || !allowedUserIds.has(context.userId)) return replyFor(update, allowedUserIds);
    if (context.command === 'status') {
      const response = replyFor(update, allowedUserIds);
      response.text += `\n\nDescription parser: local rules available. AI interpretation: ${aiEnabled ? 'configured; bounded API calls on unresolved descriptions' : 'disabled; no AI API calls'}.`;
      const health = market.status();
      const states = { not_checked: 'not checked this session', responded: 'last request succeeded', unavailable: 'last request failed; market data may be unavailable' };
      response.text += `\n\nDEX Screener: ${states[health.state]}.`;
      if (health.checkedAt !== null) response.text += `\nSource last checked: ${new Date(health.checkedAt).toISOString()}`;
      response.text += '\nA successful API request does not establish how fresh the provider data is.';
      const liquidityHealth = liquidity.status();
      response.text += `\n\nLiquidity evidence: /liquidity <CA> — limited Raydium/PumpSwap LP burn and fixed-cliff lock verification.\nSolana RPC: ${liquidityHealth.state === 'responded' ? 'account read succeeded' : liquidityHealth.state === 'unavailable' ? 'last evidence check unavailable' : 'not checked this session'}.`;
      response.text += '\nRisk evidence: /risk <CA>. Limited creator attribution and direct swaps; bundle coverage remains unknown. Unknown required checks cannot qualify.';
      if (liquidityHealth.checkedAt !== null) response.text += `\nLiquidity evidence last checked: ${new Date(liquidityHealth.checkedAt).toISOString()}`;
      if (agents) {
        response.text += '\n\n' + watchSummary(agents, context.userId, now());
        const saved = agents.get(context.userId);
        response.text += `\n\nYour saved criteria: ${saved.approved ? 'approved' : 'none approved'}${saved.draft ? '; draft in progress' : ''}. Use /agent to review.`;
        if (feed) {
          response.text += '\n\n' + scanSummary(agents, context.userId);
          const status = feed.status();
          response.text += status.sources ? '\n\n' + formatSourceHealth(status.sources) + '\nUse /sources to check access.' :
            `\nCandidate feed: ${status.state === 'responded' ? 'last request succeeded' : status.state === 'unavailable' ? 'last request failed' : 'not checked this session'}. Use /sources to check access.`;
        }
      }
      return response;
    }
    if (!['check', 'liquidity', 'risk', 'bundle'].includes(context.command)) return replyFor(update, allowedUserIds);
    const reply = (text) => withCopyableCAs({ chat_id: context.chatId, text,
      link_preview_options: { is_disabled: true } }, [context.args]);
    let bundleId;
    if (context.command === 'bundle') {
      const parts=context.args.split(/\s+/);
      if(parts.length!==2 || !isSolanaAddress(parts[0]) || !isBundleId(parts[1])) return reply('Send /bundle <Solana CA> <known Jito bundle ID>. This verifies a supplied bundle; it cannot establish that a token is bundle-free.');
      context.args=parts[0];bundleId=parts[1];
    }
    if (!isSolanaAddress(context.args)) {
      return reply(`Send /${context.command} followed by one full Solana token mint address (CA).\n\nExample format: /${context.command} <CA>\nUse the CA itself, without a link. Only Solana is supported in this test.`);
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
    if(context.command==='bundle') {
      const evidence=await bundles.check(snapshot,bundleId,{signal});
      if(signal?.aborted)return null;
      return reply([`Sift · Bundle evidence\nCA: ${snapshot.address}\nSelected pool: ${snapshot.selected?.address ?? 'unknown'}`,
        `${evidence.state.toUpperCase()} · ${evidence.reason}`,...evidence.links,
        'Manual evidence only. General bundle coverage remains unknown. Your rules and scan state are unchanged.'].join('\n\n'));
    }
    if (context.command === 'liquidity') {
      try {
        const result = await liquidity.check(snapshot, { signal, verifyProtection:true });
        if (signal?.aborted) return null;
        return reply(formatLiquidityReport(result));
      } catch (error) {
        if (signal?.aborted) return null;
        if (error instanceof SolanaRpcError && ['COOLDOWN', 'RATE_LIMITED'].includes(error.code)) {
          return reply(`Liquidity evidence checks are temporarily limited. Try again in ${error.retryAfter} seconds.\nLiquidity protection remains unknown; no rules were changed.`);
        }
        return reply('Liquidity evidence could not be read. Protection remains unknown; this cannot pass a required check. Your saved rules are unchanged.');
      }
    }
    if (context.command === 'risk' || needsRisk(approved?.rules)) {
      snapshot = await attachRisk(snapshot,risk,{ signal });
      if (signal?.aborted) return null;
      if (context.command === 'risk') return reply(formatRiskReport(snapshot.risk));
    }
    const assessment = approved ? '\n\n' + formatRuleEvaluation(approved, snapshot) : '';
    const draftNotice = saved?.draft ? '\n\nYou have an unapproved draft. It is not applied here; use /agent to review it.' : '';
    return reply(formatTokenReport(snapshot, { hasApprovedRules: Boolean(approved) }) + assessment +
      (snapshot.risk ? '\n\n' + formatRiskReport(snapshot.risk,{ compact:true }) + '\nUse /risk <CA> for transaction evidence and coverage.' : '') + draftNotice);
  };
}

