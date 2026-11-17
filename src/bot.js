import { MAX_CRITERIA_LENGTH } from './claude.js';
import { SOLANA_ADDRESS } from './market-data.js';
import { telegramMessage } from './message.js';
import { evaluate, formatApproved, formatEvaluation, formatProposal, formatSaved } from './rules.js';

export const BOT_USERNAME = 'SiftAgentbot';

export const WELCOME = [
  'Sift — Your personal agent in the trenches.',
  'Your criteria. Your watchlist. Less noise, more context.',
  [
    'Quick start:',
    '1. /criteria followed by what you look for, in plain words',
    '2. /approve to activate exactly those rules',
    '3. /scan on for automatic alerts when a new Solana token matches them',
    'Or paste any token address to check it against your rules.',
  ].join('\n'),
  'Use /help for all commands or /status to see what is running.',
].join('\n\n');

const helpText = (aiCommands) => [
  'Sift is in private testing.',
  [
    '/criteria <description> — propose screening rules from plain words' + (aiCommands ? '' : ' (off: needs ANTHROPIC_API_KEY)'),
    '/criteria — show your saved rules',
    '/approve — activate the proposed rules',
    '/discard — drop the proposed rules',
    '/scan on | off — automatic alerts when a new token matches your rules',
    '/check <token address> — evaluate one Solana token now (or just paste the address)',
    '/status — what is running for you',
    '/id — your Telegram user ID',
    '/start — welcome and quick start',
  ].join('\n'),
  ...(aiCommands ? ['You can also write in plain words, such as "what works today?" or "alert me on tokens under 500k market cap with 50+ trades an hour".'] : []),
  'Rules compare live numbers only: market cap, FDV, liquidity, 1h volume, 1h trades and pool age. Follow-up monitoring of chosen tokens will arrive later. No wallet connection is ever needed.',
].join('\n\n');

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function scanLine(agent, lastScan) {
  if (!agent?.scanning) return 'Scanning: off (/scan on to start)';
  if (!lastScan) return 'Scanning: on (no check has run yet)';
  const at = `${new Date(lastScan.at).toISOString().slice(11, 16)} UTC`;
  return lastScan.ok
    ? `Scanning: on (last check ${at}: ${plural(lastScan.newPools ?? 0, 'new pool')}, watching ${plural(lastScan.watching ?? 0, 'token')} from new pools, ${plural(lastScan.newMatches ?? 0, 'new match')} for all testers)`
    : `Scanning: on, but finding new pools failed at ${at} (GeckoTerminal ${lastScan.reason === 'RATE_LIMITED' ? 'rate-limited' : 'unavailable'}); retrying. Tokens already being watched are still re-checked`;
}

const statusText = (aiCommands, agent, lastScan) => [
  'Sift status',
  [
    'Telegram replies: available',
    `Plain-language commands: ${aiCommands ? 'available (Claude)' : 'off'}`,
    `Saved criteria: ${agent?.approved ? `v${agent.version} (${plural(agent.approved.rules.length, 'rule')})` : 'none saved'}${agent?.draft ? ' — a proposal is waiting for /approve' : ''}`,
    'Token checks: on demand via /check (DexScreener)',
    `${scanLine(agent, lastScan)} — sources: GeckoTerminal new pools, DexScreener`,
    'Follow-up monitoring of chosen tokens: not connected',
  ].join('\n'),
  agent?.scanning
    ? 'Alerts fire only while the bot process runs, at most once per token.'
    : 'No scans or alerts are running for you. /check works on demand.',
].join('\n\n');

const unsupportedText = 'This version supports /criteria, /approve, /discard, /scan on|off, /check <address>, /status, /help and /id. Follow-up monitoring of chosen tokens is not available yet.';

const CRITERIA_HELP = [
  'No saved screening rules yet.',
  'Describe them in plain words after /criteria, for example:',
  '/criteria at least 10k liquidity, market cap between 100k and 5m, warn if the pool is younger than 30 minutes',
  'Only explicit numbers become rules; anything unclear is listed back to you, and nothing activates without /approve.',
].join('\n\n');

const CHECK_ERRORS = {
  INVALID_ADDRESS: 'Send a Solana token address after /check, for example /check DezX… (32–44 base58 characters). Nothing was checked.',
  NO_SOLANA_POOLS: 'DexScreener lists no Solana pools where that token is traded. Nothing was evaluated.',
  RATE_LIMITED: 'The data source (DexScreener) is rate-limiting requests right now. Nothing was evaluated; try again in a minute.',
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

function approveCommand(userId, { store }) {
  const result = store.approveDraft(userId);
  if (!result) return 'No proposed rules are waiting. Describe rules with /criteria <description> first.';
  const scanning = store.getAgent(userId)?.scanning;
  return [
    formatApproved(result),
    scanning
      ? `Scanning continues with v${result.version}. Tokens you were already alerted about will not alert again.`
      : 'Turn on automatic alerts with /scan on.',
  ].join('\n\n');
}

function scanCommand(args, userId, { store, scanSettings = {} }) {
  const agent = store.getAgent(userId);
  const lastScan = store.getLastScan();
  const watchMinutes = scanSettings.watchMinutes ?? 30;
  if (args === 'on') {
    if (!agent?.approved?.rules?.length) {
      return 'Scanning needs active criteria first. Describe rules with /criteria <description>, then /approve them.';
    }
    store.setScanning(userId, true);
    const requiresLiquidity = agent.approved.rules.some((r) => r.severity === 'require' && r.field === 'liquidityUsd');
    return [
      `Scanning is on with criteria v${agent.version}. New Solana pools are read about once a minute (GeckoTerminal)` +
        (watchMinutes > 0 ? `, and each new token is re-checked on DexScreener for ${watchMinutes} minutes as its numbers change.` : '.') +
        ' You get at most one alert per token.',
      ...(requiresLiquidity ? ['Note: DexScreener reports no liquidity for pump.fun tokens still on their bonding curve. After launch, a required liquidity rule only matches tokens trading in an AMM pool (for example after moving to PumpSwap or Raydium).'] : []),
      'Alerts run only while the bot process is running. /scan off stops them.',
    ].join('\n\n');
  }
  if (args === 'off') {
    const wasOn = agent?.scanning;
    if (wasOn) store.setScanning(userId, false);
    return wasOn ? 'Scanning stopped, including alerts already queued. Your saved criteria are unchanged.' : 'Scanning is already off.';
  }
  return [scanLine(agent, lastScan), 'Use /scan on or /scan off.'].join('\n');
}

async function checkCommand(address, userId, { store, market, signal }) {
  const agent = store.getAgent(userId);
  if (!agent?.approved?.rules?.length) {
    return 'No active criteria to check against. Describe rules with /criteria <description>, then /approve them.';
  }
  const result = await market(address, signal);
  if (!result.ok) return CHECK_ERRORS[result.reason] ?? CHECK_ERRORS.UNAVAILABLE;
  const evaluation = evaluate(agent.approved.rules, result.metrics);
  return formatEvaluation(evaluation, {
    version: agent.version, address, pool: result.pool, checkedAt: result.checkedAt,
  });
}

// All routing. ctx: { allowedUserIds, claude, store, market, scanSettings,
// signal }. Claude only ever picks a command or proposes rules for approval;
// every reply text is written here. Messages from unlisted accounts never
// reach Claude, the store or the data sources.
export async function respond(update, ctx) {
  const { allowedUserIds, claude = null, store = null, signal } = ctx;
  const message = privateMessage(update);
  if (!message) return null;
  const parsed = parseCommand(message.text);
  if (parsed?.mention && parsed.mention.toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  const userId = message.from.id;
  const reply = (text, copyable = []) => telegramMessage(message.chat.id, text, copyable);
  const idReply = () => reply(`Your Telegram user ID: ${userId}\n\nSift is in private testing. This command only shows your own ID.`, [String(userId)]);

  if (parsed?.command === 'id') return idReply();
  if (!allowedUserIds.has(userId)) {
    return reply('Sift is in private testing. Your account does not have tester access yet.\n\nUse /id to find the ID needed for access.');
  }

  if (!parsed) {
    const text = message.text.trim();
    // A pasted token address is a check: deterministic, no Claude involved.
    if (SOLANA_ADDRESS.test(text)) return reply(await checkCommand(text, userId, ctx), [text]);
    const routed = claude?.available ? await claude.routeCommand(text, { userId, signal }) : null;
    if (routed === 'criteria') return reply(await criteriaCommand(text, userId, ctx));
    if (routed === 'id') return idReply();
    if (!routed || routed === 'unsupported') return reply(unsupportedText);
    return respond({ ...update, message: { ...message, text: `/${routed}` } }, ctx);
  }

  switch (parsed.command) {
    case 'start': return reply(WELCOME);
    case 'help': return reply(helpText(Boolean(claude?.available)));
    case 'status': return reply(statusText(Boolean(claude?.available), store?.getAgent(userId), store?.getLastScan()));
    case 'criteria': return reply(await criteriaCommand(parsed.args, userId, ctx));
    case 'approve': return reply(approveCommand(userId, ctx));
    case 'discard':
      return reply(store.clearDraft(userId) ? 'Proposal discarded. Your previously approved rules, if any, are unchanged.' : 'No proposal to discard.');
    case 'check': return reply(await checkCommand(parsed.args, userId, ctx), [parsed.args]);
    case 'scan': return reply(scanCommand(parsed.args.toLowerCase(), userId, ctx));
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

// The command menu Telegram shows when a tester types "/".
export const COMMAND_MENU = [
  { command: 'criteria', description: 'Set screening rules in plain words' },
  { command: 'approve', description: 'Activate the proposed rules' },
  { command: 'scan', description: 'Automatic alerts: /scan on or /scan off' },
  { command: 'check', description: 'Check a token: /check <address>' },
  { command: 'status', description: 'What is running for you' },
  { command: 'discard', description: 'Drop the proposed rules' },
  { command: 'help', description: 'All commands' },
  { command: 'id', description: 'Your Telegram user ID' },
];
