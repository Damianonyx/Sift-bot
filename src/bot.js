export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Check a Solana token with /check followed by its contract address.',
  'Private test version. Discovery, AI screening and monitoring are not live yet.',
  'Use /help for commands or /status to see what is available.',
].join('\n\n');

const HELP = [
  'Sift is in private testing.',
  '/start — Welcome to Sift\n/check <CA> — Solana market snapshot\n/help — Available commands\n/status — What works today\n/id — Your Telegram user ID',
  'Checks use DEX Screener market data and show coverage limits. Personalised screening and monitoring are not available yet. No wallet connection is needed.',
].join('\n\n');

const STATUS = [
  'Sift status',
  'Telegram replies: available\nToken checks: /check <CA> — Solana via DEX Screener\nDiscovery: not connected\nAI interpretation: not connected\nMonitoring: not connected\nSaved criteria: not available',
  'This is a manual token-check test. No scans or alerts are running.',
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
      !Number.isSafeInteger(message.chat.id) || typeof message.text !== 'string') {
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
    'Use /check <CA> for a Solana market snapshot, or /start, /help, /status and /id. Personalised screening and monitoring are not available yet.';
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
