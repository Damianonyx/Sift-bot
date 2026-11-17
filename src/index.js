import { readConfig, respond, verifyBot } from './bot.js';
import { createClaude, readClaudeConfig } from './claude.js';
import { createDiscovery } from './discovery.js';
import { createMarketData } from './market-data.js';
import { runPolling } from './polling.js';
import { runScanner } from './scanner.js';
import { openStore } from './store.js';
import { createTelegram } from './telegram.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

// Scan cadence: 30s–3600s, default 60s (gentle on the public data source).
export function readScanInterval(env) {
  const raw = env.SIFT_SCAN_INTERVAL_SECONDS?.trim();
  if (!raw) return 60;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    throw new Error('SIFT_SCAN_INTERVAL_SECONDS must be a whole number of seconds between 30 and 3600.');
  }
  return seconds;
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const claudeConfig = readClaudeConfig(process.env);
  const claude = claudeConfig ? createClaude(claudeConfig) : null;
  const scanIntervalSeconds = readScanInterval(process.env);
  const dataDir = process.env.SIFT_DATA_DIR?.trim() || '.sift';
  const store = openStore(dataDir);
  const market = createMarketData();
  const discovery = createDiscovery();
  const call = createTelegram(token);

  const identity = await call('getMe', {}, shutdown.signal);
  const webhook = await call('getWebhookInfo', {}, shutdown.signal);
  verifyBot(identity, webhook);
  console.log('Sift is running: criteria setup, on-demand /check, and /scan discovery alerts. Follow-up monitoring is not connected.');
  console.log(`Saved state: ${dataDir} (criteria, scanning switches, the alert ledger and the update offset survive restarts).`);
  console.log(`Scanning cadence: every ${scanIntervalSeconds}s while at least one tester has /scan on.`);
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');
  console.log(claude
    ? `Plain-language commands and criteria are interpreted by Claude (${claudeConfig.model}).`
    : 'Plain-language commands and /criteria setup are off. Set ANTHROPIC_API_KEY to enable them.');

  // Either loop ending (fatal polling error, or shutdown) stops the other.
  const stop = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, stop.signal]);
  try {
    await Promise.all([
      runPolling({
        call,
        signal,
        initialOffset: store.getOffset(),
        onOffset: (offset) => store.setOffset(offset),
        handleUpdate: (update) => respond(update, { allowedUserIds, claude, store, market, signal }),
      }).finally(() => stop.abort()),
      runScanner({
        discovery,
        store,
        signal,
        intervalMs: scanIntervalSeconds * 1000,
        send: (message, sendSignal) => call('sendMessage', message, sendSignal),
      }).finally(() => stop.abort()),
    ]);
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
