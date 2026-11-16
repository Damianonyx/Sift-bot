import { readConfig, respond, verifyBot } from './bot.js';
import { createClaude, readClaudeConfig } from './claude.js';
import { createMarketData } from './market-data.js';
import { runPolling } from './polling.js';
import { openStore } from './store.js';
import { createTelegram } from './telegram.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const claudeConfig = readClaudeConfig(process.env);
  const claude = claudeConfig ? createClaude(claudeConfig) : null;
  const dataDir = process.env.SIFT_DATA_DIR?.trim() || '.sift';
  const store = openStore(dataDir);
  const market = createMarketData();
  const call = createTelegram(token);
  const signal = shutdown.signal;

  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  console.log('Sift is running: criteria setup and on-demand /check. Scheduled discovery and monitoring are not connected.');
  console.log(`Saved state: ${dataDir} (criteria and update offset survive restarts).`);
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');
  console.log(claude
    ? `Plain-language commands and criteria are interpreted by Claude (${claudeConfig.model}).`
    : 'Plain-language commands and /criteria setup are off. Set ANTHROPIC_API_KEY to enable them.');

  try {
    await runPolling({
      call,
      signal,
      initialOffset: store.getOffset(),
      onOffset: (offset) => store.setOffset(offset),
      handleUpdate: (update) => respond(update, { allowedUserIds, claude, store, market, signal }),
    });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Config/identity errors are fixed text. Other transport errors are sanitised.
  console.error(error instanceof Error ? error.message : 'Sift could not start.');
  process.exitCode = 1;
});
