export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Sift is being built to find coins that fit your criteria and send their CAs with reasons. Personalised discovery is the goal.',
  'Describe your criteria with /describe, or use /setup for guided rules. Review and approve them, then use /scan to start scouting. Sift sends matching Solana CAs with reasons and warnings.',
  'Private test version. Complete bundle coverage is not live yet; unknown required checks cannot qualify coins. Description parsing works locally; optional AI requires separate configuration. /risk checks limited evidence and /watch monitors market data. Admins can enable group alerts through /groups.',
  'Use /help for commands or /status to see what is available.',
].join('\n\n');

const HELP = [
  'Sift is in private testing.',
  '/web — Open your private web workspace (when enabled)\n/web logout — Revoke your web sessions',
  '/start — Welcome to Sift\n/describe <description> — Prepare criteria for review\n/setup — Guided criteria setup\n/setup <description> — Prepare criteria from a description\n/agent — Review your saved rules\n/groups — Review and enable group destinations privately\n/riskrules — Review the explicit private-test risk policy\n/risk <CA> — Liquidity, creator and buying evidence\n/bundle <CA> <ID> — Verify a known Jito bundle\n/cancel — Discard your draft\n/check <CA> — Solana market snapshot and approved-rule check\n/verify <CA> — Compare sources for the same pool\n/liquidity <CA> — Manual liquidity evidence (limited pool support)\n/scan — Review/start discovery and see scan status\n/watch — Set a liquidity-drop monitor\n/watchlist — Monitor status and controls\n/watchalerts — Saved monitoring reports\n/pause — Pause discovery and monitors\n/resume — Resume discovery; /watchlist resumes monitors\n/stop — Stop discovery and monitors\n/alerts — Latest saved discovery reports\n/unmute <CA> — Unmute a token\n/sources — Test the candidate feed without activating\n/help — Available commands\n/status — What works today\n/id — Your Telegram user ID',
  'Group admins: send /group@SiftAgentbot connect in the group, then /groups privately to approve sharing. Adding the bot alone starts nothing. Any verified group admin can use /group@SiftAgentbot stop.',
  '/why — Explain approval blockers and recent saved discovery results without changing your rules',
  '/preferences — Follow-ups, quiet hours and paper-cost assumptions\n/performance — All-call paper outcomes and coverage\n/calls [PAGE] — Call IDs, including failed deliveries\n/feedback ID 1-5 OUTCOME — Your unverified tester report\n/followstop ID — Stop a call’s follow-up notifications\n/size <CA> <USDC> — Read-only entry/exit quotes\n/holders <CA> — Largest token-account sample\n/poolcoverage <CA> — Indexed pool inventory and its limits\n/mapextras — Review mapping saved explicit risk policies\n/audit — Your rule/configuration history\n/groupstrategy CHAT_ID — Separate group strategy draft\n/groupconfig CHAT_ID MINUTES MAX — Group posting cadence\n/grouppause CHAT_ID — Pause one group',
  'Discovery uses GeckoTerminal and, when enabled, Pump.fun events via PumpPortal and direct Meteora DLMM/DAMM v2 feeds. DEX Screener supplies market checks; new coins may lack indexed data. Complete bundle coverage is not available yet. Optional AI interpretation requires operator configuration; market monitoring uses /watch. Approving rules does not start a scan; review /scan separately. No wallet connection is needed.',
].join('\n\n');

const STATUS = [
  'Sift status',
  'Telegram replies: available\nToken checks: /check <CA> — Solana via DEX Screener\nCriteria: /describe, /setup and /agent\nDiscovery: approved rules only; explicit activation required\nGroup destinations: /groups (admin-controlled)\nMarket monitoring: /watch and /watchlist (fixed pool)\nRisk evidence: /risk (limited coverage; unknowns block qualification)',
  'Use /scan for your discovery status. A saved draft is not an active scan.',
].join('\n\n');

const REPLIES = new Map([['start', WELCOME], ['help', HELP], ['status', STATUS]]);

export function readConfig(env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Set a valid TELEGRAM_BOT_TOKEN in secure configuration.');
  }
  const ids = (env.SIFT_ALLOWED_USER_IDS ?? '').trim();
  const allowedUserIds = new Set();
  for (const raw of ids ? ids.split(',') : []) {
    const id = raw.trim();
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error('SIFT_ALLOWED_USER_IDS must contain comma-separated positive numeric IDs.');
    }
    allowedUserIds.add(Number(id));
  }
  return { token, allowedUserIds };
}

// Shared private-chat routing for both simple replies and data commands.
export function commandFor(update) {
  const message = update?.message;
  if (message?.chat?.type !== 'private' || message.from?.is_bot ||
      !Number.isSafeInteger(message.from?.id) ||
      !Number.isSafeInteger(message.chat.id) || message.chat.id !== message.from.id || typeof message.text !== 'string') {
    return null;
  }

  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
  if (match?.[2] && match[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  return { command: match?.[1]?.toLowerCase(), args: match?.[3]?.trim() ?? '',
    userId: message.from.id, chatId: message.chat.id };
}

// Pure replies: no state changes and no message logging.
export function replyFor(update, allowedUserIds) {
  const context = commandFor(update);
  if (!context) return null;
  const { command, userId, chatId } = context;
  if (command === 'id') {
    return { chat_id: chatId, text: `Your Telegram user ID: ${userId}\n\nSift is in private testing. This command only shows your own ID.` };
  }
  if (!allowedUserIds.has(userId)) {
    return { chat_id: chatId, text: 'Sift is in private testing. Your account does not have tester access yet.\n\nUse /id to find the ID needed for access.' };
  }
  const text = REPLIES.get(command) ??
    'Use /describe followed by your criteria, /setup for guided rules, /scan for discovery or /check <CA> for a Solana market snapshot. Complete bundle checks are not available yet; /risk checks supported evidence; /groups manages group alerts.';
  return { chat_id: chatId, text };
}

export function verifyBot(identity, webhook) {
  if (identity?.is_bot !== true || identity.username?.toLowerCase() !== BOT_USERNAME.toLowerCase()) {
    throw new Error('The configured token does not belong to @SiftAgentbot. Startup stopped.');
  }
  if (typeof webhook?.url !== 'string') {
    throw new Error('Telegram webhook status could not be verified. Startup stopped.');
  }
  if (webhook.url) {
    throw new Error('A Telegram webhook is already configured. Resolve the existing deployment before polling.');
  }
}

