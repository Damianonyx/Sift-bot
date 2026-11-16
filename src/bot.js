import { evaluate, formatApproved, formatEvaluation, formatProposal, formatSaved } from './rules.js';
import { MAX_CRITERIA_LENGTH } from './claude.js';

export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Your criteria. Your watchlist. Less noise, more context.',
  'Describe screening rules in plain words with /criteria, approve them, then test any Solana token with /check. Scheduled discovery and alerts are not live yet.',
  'Use /help for commands or /status to see what is available.',
].join('\n\n');

const helpText = (aiCommands) => [
  'Sift is in private testing.',
  [
    '/start — Welcome to Sift',
    '/help — Available commands',
    '/status — What works today',
    '/id — Your Telegram user ID',
    '/criteria <description> — propose screening rules from plain words' + (aiCommands ? '' : ' (off: needs ANTHROPIC_API_KEY)'),
    '/criteria — show your saved rules',
    '/approve — activate the proposed rules',
    '/discard — drop the proposed rules',
    '/check <token address> — evaluate a Solana token against your rules',
  ].join('\n'),
  ...(aiCommands ? ['You can also ask in plain words, such as "what works today?"'] : []),
  'Rules only compare live market numbers. Scheduled scanning, alerts and monitoring will arrive in later stages. No wallet connection is ever needed.',
].join('\n\n');

const statusText = (aiCommands, agent) => [
  'Sift status',
  [
    'Telegram replies: available',
    `Plain-language commands: ${aiCommands ? 'available (Claude)' : 'off'}`,
    `Saved criteria: ${agent?.approved ? `v${agent.version} (${agent.approved.rules.length} rule${agent.approved.rules.length === 1 ? '' : 's'})` : 'none saved'}${agent?.draft ? ' — a proposal is waiting for /approve' : ''}`,
    'Token checks: on demand via /check (DexScreener)',
    'Scheduled discovery: not connected',
    'Monitoring and alerts: not connected',
  ].join('\n'),
  'No scans or alerts are running. Checks happen only when you send /check.',
].join('\n\n');

const unsupportedText = 'This version supports /start, /help, /status, /id, /criteria, /approve, /discard and /check <address>. Scheduled scanning and alerts are not available yet.';

const CRITERIA_HELP = [
  'No saved screening rules yet.',
  'Describe them in plain words after /criteria, for example:',
  '/criteria at least 10k liquidity, market cap between 100k and 5m, warn if the pool is younger than 30 minutes',
  'Only explicit numbers become rules; anything unclear is listed back to you, and nothing activates without /approve.',
].join('\n\n');

const CHECK_ERRORS = {
  INVALID_ADDRESS: 'Send a Solana token address after /check, for example /check DezX… (32–44 base58 characters). Nothing was checked.',
  NO_SOLANA_POOLS: 'DexScreener lists no Solana pools for that address. Nothing was evaluated.',
  UNAVAILABLE: 'The data source (DexScreener) could not be reached or answered unexpectedly. Nothing was evaluated; try again later.',
};

export function readConfig(env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Set a valid TELEGRAM_BOT_TOKEN in secure configuration.');
  }
  const allowedUserIds = new Set();
  // Empty entries (a trailing comma, say) are ignored; anything else must be an ID.
  for (const id of (env.SIFT_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
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

function parseCommand(text) {
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?=\s|$)/.exec(text);
  if (!match) return null;
  return { command: match[1].toLowerCase(), mention: match[2], args: text.slice(match[0].length).trim() };
}

async function criteriaCommand(args, userId, { claude, store, signal }) {
  if (!args) {
    const agent = store.getAgent(userId);
    if (agent?.draft) return formatProposal(agent.draft);
    return agent?.approved ? formatSaved(agent) : CRITERIA_HELP;
  }
  if (!claude?.available) {
    return 'Plain-language rule setup needs Claude, which is off (no ANTHROPIC_API_KEY, or it was rejected). No rules were changed.';
  }
  if (args.length > MAX_CRITERIA_LENGTH) {
    return `That description is over ${MAX_CRITERIA_LENGTH} characters. Please shorten it; nothing was changed.`;
  }
  const proposal = await claude.proposeCriteria(args, { userId, signal });
  if (!proposal) {
    return 'That description could not be interpreted safely right now (interpreter unavailable, over the per-minute limit, or the answer failed validation). Nothing was changed; try again or rephrase.';
  }
  if (proposal.rules.length === 0) {
    return [
      'No measurable screening rules were found in that description, so nothing was proposed.',
      ...(proposal.unresolved.length ? ['Not understood or not supported:', ...proposal.unresolved.map((item) => `• "${item}"`)] : []),
      'Rules need explicit numbers, for example "at least 10k liquidity".',
    ].join('\n');
  }
  store.setDraft(userId, proposal);
  return formatProposal(proposal);
}

async function checkCommand(args, userId, { store, market, signal }) {
  const agent = store.getAgent(userId);
  if (!agent?.approved?.rules?.length) {
    return 'No active criteria to check against. Describe rules with /criteria <description>, then /approve them.';
  }
  const result = await market(args, signal);
  if (!result.ok) return CHECK_ERRORS[result.reason] ?? CHECK_ERRORS.UNAVAILABLE;
  const evaluation = evaluate(agent.approved.rules, result.metrics);
  return formatEvaluation(evaluation, {
    version: agent.version, address: args, pool: result.pool, checkedAt: result.checkedAt,
  });
}

// All routing. ctx: { allowedUserIds, claude, store, market, signal }. Claude
// only ever picks a command or proposes rules for approval; every reply text
// is written here. Replies to unlisted accounts never reach Claude, the store
// or the data source.
export async function respond(update, ctx) {
  const { allowedUserIds, claude = null, store = null, market = null, signal } = ctx;
  const message = privateMessage(update);
  if (!message) return null;
  const parsed = parseCommand(message.text);
  if (parsed?.mention && parsed.mention.toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  const userId = message.from.id;
  const reply = (text) => ({ chat_id: message.chat.id, text });

  if (parsed?.command === 'id') {
    return reply(`Your Telegram user ID: ${userId}\n\nSift is in private testing. This command only shows your own ID.`);
  }
  if (!allowedUserIds.has(userId)) {
    return reply('Sift is in private testing. Your account does not have tester access yet.\n\nUse /id to find the ID needed for access.');
  }

  let command = parsed?.command;
  if (!parsed) {
    command = claude?.available ? await claude.routeCommand(message.text, { userId, signal }) : null;
    if (!command || command === 'unsupported') return reply(unsupportedText);
    if (command === 'id') {
      return reply(`Your Telegram user ID: ${userId}\n\nSift is in private testing. This command only shows your own ID.`);
    }
  }

  switch (command) {
    case 'start': return reply(WELCOME);
    case 'help': return reply(helpText(Boolean(claude?.available)));
    case 'status': return reply(statusText(Boolean(claude?.available), store?.getAgent(userId)));
    case 'criteria': return reply(await criteriaCommand(parsed?.args ?? '', userId, ctx));
    case 'approve': {
      const result = store.approveDraft(userId);
      return reply(result ? formatApproved(result) : 'No proposed rules are waiting. Describe rules with /criteria <description> first.');
    }
    case 'discard':
      return reply(store.clearDraft(userId) ? 'Proposal discarded. Your previously approved rules, if any, are unchanged.' : 'No proposal to discard.');
    case 'check': return reply(await checkCommand(parsed?.args ?? '', userId, ctx));
    default: return reply(unsupportedText);
  }
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
