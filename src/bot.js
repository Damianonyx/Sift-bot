export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Your criteria. Your watchlist. Less noise, more context.',
  'Welcome to the first test version. Discovery, AI screening and monitoring are not live yet.',
  'Use /help for commands or /status to see what is available.',
].join('\n\n');

const helpText = (aiCommands) => [
  'Sift is in private testing.',
  '/start — Welcome to Sift\n/help — Available commands\n/status — What works today\n/id — Your Telegram user ID',
  ...(aiCommands ? ['You can also ask in plain words, such as "what works today?"'] : []),
  'Token checks, screening rules and monitoring will arrive in later stages. No wallet connection is needed.',
].join('\n\n');

const statusText = (aiCommands) => [
  'Sift status',
  `Telegram replies: available\nPlain-language commands: ${aiCommands ? 'available (Claude)' : 'off'}\nDiscovery: not connected\nAI screening: not connected\nToken data: not connected\nMonitoring: not connected\nSaved criteria: not available`,
  'This is a welcome-bot test. No scans or alerts are running.',
].join('\n\n');

const UNSUPPORTED = 'This version supports /start, /help, /status and /id. Token checks and scanning are not available yet.';

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

// Private text messages from people only; everything else is ignored.
function privateMessage(update) {
  const message = update?.message;
  if (message?.chat?.type !== 'private' || message.from?.is_bot ||
      !Number.isSafeInteger(message.from?.id) ||
      !Number.isSafeInteger(message.chat.id) || typeof message.text !== 'string') {
    return null;
  }
  return message;
}

function commandReply(command, message, allowedUserIds, aiCommands) {
  const chat_id = message.chat.id;
  if (command === 'id') {
    return { chat_id, text: `Your Telegram user ID: ${message.from.id}\n\nSift is in private testing. This command only shows your own ID.` };
  }
  if (!allowedUserIds.has(message.from.id)) {
    return { chat_id, text: 'Sift is in private testing. Your account does not have tester access yet.\n\nUse /id to find the ID needed for access.' };
  }
  if (command === 'start') return { chat_id, text: WELCOME };
  if (command === 'help') return { chat_id, text: helpText(aiCommands) };
  if (command === 'status') return { chat_id, text: statusText(aiCommands) };
  return { chat_id, text: UNSUPPORTED };
}

// Pure routing: private chats only, no state changes and no message logging.
export function replyFor(update, allowedUserIds, aiCommands = false) {
  const message = privateMessage(update);
  if (!message) return null;
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/.exec(message.text);
  if (match?.[2] && match[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  return commandReply(match?.[1]?.toLowerCase(), message, allowedUserIds, aiCommands);
}

// Plain-language messages from approved testers may be mapped to a command by
// `interpret` (Claude). Slash commands and unlisted accounts never reach it,
// and the reply is always one of the fixed texts above.
export async function respond(update, allowedUserIds, interpret, signal) {
  const message = privateMessage(update);
  if (interpret && message && !message.text.startsWith('/') && allowedUserIds.has(message.from.id)) {
    const command = await interpret(message.text, signal);
    if (command) return commandReply(command, message, allowedUserIds, true);
  }
  return replyFor(update, allowedUserIds, Boolean(interpret));
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
