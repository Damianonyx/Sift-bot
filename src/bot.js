export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Sift is being built to find coins that fit your criteria and send their CAs with reasons. Personalised discovery is the goal.',
  'Today: /setup saves rules for review, /scan reviews supported discovery rules for activation, and /check followed by a Solana CA checks market data.',
  'Private test version. AI interpretation and complete bundle coverage are not live yet; /risk has limited evidence checks; /watch supports market monitoring. Unsupported required checks block discovery activation.',
  'Use /help for commands or /status to see what is available.',
].join('\n\n');

const HELP = [
  'Sift is in private testing.',
  '/start — Welcome to Sift\n/setup — Guided criteria setup\n/setup <description> — Save an unresolved request\n/agent — Review your saved rules\n/riskrules — Review the explicit private-test risk policy\n/risk <CA> — Liquidity, creator and buying evidence\n/bundle <CA> <ID> — Verify a known Jito bundle\n/cancel — Discard your draft\n/check <CA> — Solana market snapshot and approved-rule check\n/liquidity <CA> — Manual liquidity evidence (limited pool support)\n/scan — Review/start discovery and see scan status\n/watch — Set a liquidity-drop monitor\n/watchlist — Monitor status and controls\n/watchalerts — Saved monitoring reports\n/pause — Pause discovery and monitors\n/resume — Resume discovery; /watchlist resumes monitors\n/stop — Stop discovery and monitors\n/alerts — Latest saved discovery reports\n/unmute <CA> — Unmute a token\n/sources — Test the candidate feed without activating\n/help — Available commands\n/status — What works today\n/id — Your Telegram user ID',
  'Discovery uses GeckoTerminal candidates and DEX Screener market checks with limited coverage. AI interpretation and complete bundle coverage are not available yet; /risk has limited evidence checks; market monitoring uses /watch. Approving rules does not start a scan; review /scan separately. No wallet connection is needed.',
].join('\n\n');

const STATUS = [
  'Sift status',
  'Telegram replies: available\nToken checks: /check <CA> — Solana via DEX Screener\nGuided criteria: /setup and /agent\nDiscovery: approved rules only; explicit activation required\nAI interpretation: not connected\nMarket monitoring: /watch and /watchlist (fixed pool)\nRisk evidence: /risk (limited coverage; unknowns block qualification)',
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
    'Use /setup for guided rules, /scan for supported discovery or /check <CA> for a Solana market snapshot. AI interpretation and complete bundle coverage are not available yet; /risk checks supported evidence; market monitoring uses /watch.';
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

