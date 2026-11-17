import { readConfig, verifyBot } from './bot.js';
import { createClaude, readClaudeConfig } from './claude.js';
import { readDataDir, readScanInterval, readWatchMinutes } from './config.js';
import { createDiscovery } from './discovery.js';
import { createMarketData, createTokenBatch } from './market-data.js';
import { openStore } from './store.js';
import { createTelegram, TelegramError } from './telegram.js';

// Checks everything Sift needs for private testing, through the bot's own
// code paths, and prints one line per check. Safe while the bot is running:
// it never calls getUpdates, so it cannot steal or conflict with messages.
// With ANTHROPIC_API_KEY set it makes two small paid Claude requests.
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const SAMPLE_CRITERIA = 'at least 10k liquidity and market cap under 2m';

export async function runPreflight({
  env, nodeVersion = process.versions.node, fetchImpl = fetch, claudeClient, openStoreFn = openStore, out = console.log,
}) {
  let failures = 0;
  let warnings = 0;
  const pass = (label, detail) => out(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
  const warn = (label, detail) => { warnings += 1; out(`! ${label} — ${detail}`); };
  const fail = (label, detail) => { failures += 1; out(`✗ ${label} — ${detail}`); };

  const major = Number(nodeVersion.split('.')[0]);
  if (major === 24) pass('Node.js', `v${nodeVersion}`);
  else warn('Node.js', `v${nodeVersion}: runs, but Sift targets Node 24 (docs/hosting.md, step 3)`);

  let config;
  try {
    config = readConfig(env);
    readScanInterval(env);
    readWatchMinutes(env);
    pass('Configuration', `bot token format OK, ${config.allowedUserIds.size} tester${config.allowedUserIds.size === 1 ? '' : 's'} allowed`);
    if (config.allowedUserIds.size === 0) {
      fail('Testers', 'SIFT_ALLOWED_USER_IDS is empty: start the bot, send it /id, add that number to .env and restart');
    }
  } catch (error) {
    fail('Configuration', error.message);
  }

  if (config) {
    try {
      const call = createTelegram(config.token, { fetchImpl });
      const identity = await call('getMe');
      const webhook = await call('getWebhookInfo');
      verifyBot(identity, webhook);
      pass('Telegram', `token belongs to @${identity.username}, no webhook in the way`);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 401) fail('Telegram', 'the token was rejected (401): copy the current token from @BotFather');
      else fail('Telegram', error instanceof Error ? error.message : 'request failed');
    }
  }

  const dataDir = readDataDir(env);
  try {
    const store = openStoreFn(dataDir);
    const stats = store.stats();
    store.close();
    pass('Storage', `${dataDir}: ${stats.withCriteria} tester(s) with criteria, ${stats.scanning} scanning, ${stats.watching} token(s) watched, ${stats.alertsSent} alert(s) sent`);
  } catch (error) {
    fail('Storage', `cannot open ${dataDir}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  let claudeConfig = null;
  let claudeConfigError = false;
  try {
    claudeConfig = readClaudeConfig(env);
  } catch (error) {
    claudeConfigError = true;
    fail('Claude', error.message);
  }
  if (!claudeConfig && !claudeConfigError) {
    fail('Claude', 'ANTHROPIC_API_KEY is not set: testers cannot create criteria (/criteria) without it');
  } else if (claudeConfig) {
    const logs = [];
    const claude = createClaude({ model: claudeConfig.model, log: { warn: (m) => logs.push(m) }, ...(claudeClient ? { client: claudeClient } : {}) });
    const routed = await claude.routeCommand('what can you do?', { userId: 0 });
    if (routed) pass('Claude routing', `${claudeConfig.model}: "what can you do?" → ${routed}`);
    else fail('Claude routing', logs.at(-1) ?? 'no usable answer');
    if (claude.available) {
      const proposal = await claude.proposeCriteria(SAMPLE_CRITERIA, { userId: 0 });
      const found = (field, op, value) => proposal?.rules.some((r) => r.field === field && r.op === op && r.value === value);
      if (found('liquidityUsd', 'gte', 10_000) && found('marketCapUsd', 'lte', 2_000_000)) {
        pass('Claude criteria', `"${SAMPLE_CRITERIA}" → ${proposal.rules.length} rules, numbers traced to the quotes`);
      } else if (proposal) {
        fail('Claude criteria', `unexpected proposal for "${SAMPLE_CRITERIA}": ${JSON.stringify(proposal.rules)}`);
      } else {
        fail('Claude criteria', logs.at(-1) ?? 'no usable answer');
      }
    }
  }

  const check = await createMarketData({ fetchImpl })(BONK);
  if (check.ok) pass('DexScreener token lookup', `BONK: ${check.pool.poolCount} pools`);
  else fail('DexScreener token lookup', check.reason === 'RATE_LIMITED' ? 'rate-limited; try again in a minute' : 'unreachable');
  const batch = await createTokenBatch({ fetchImpl })([BONK, SOL]);
  if (batch.ok && batch.byToken.size > 0) pass('DexScreener batch lookup', `${batch.byToken.size} of 2 tokens returned`);
  else fail('DexScreener batch lookup', batch.ok ? 'no tokens returned' : 'unreachable or rate-limited');

  const discovery = await createDiscovery({ fetchImpl, maxPages: 1 })();
  if (discovery.ok) pass('GeckoTerminal new pools', `${discovery.pools.length} pools on the first page`);
  else fail('GeckoTerminal new pools', discovery.reason === 'RATE_LIMITED' ? 'rate-limited; try again in a minute' : 'unreachable');

  out('');
  if (failures === 0) out(`Ready for private testing${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'} above)` : ''}.`);
  else out(`${failures} check${failures === 1 ? '' : 's'} failed: fix the ✗ items above, then run this again.`);
  return { failures, warnings };
}
