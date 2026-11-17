import { COMMAND_MENU, readConfig, respond, verifyBot } from './bot.js';
import { createClaude, readClaudeConfig } from './claude.js';
import { createDiscovery } from './discovery.js';
import { createMarketData, createTokenBatch } from './market-data.js';
import { runPolling } from './polling.js';
import { runScanner } from './scanner.js';
import { openStore } from './store.js';
import { createTelegram } from './telegram.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

function readWholeNumber(env, name, { min, max, fallback }) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

// Scan cadence: 30s–3600s, default 60s (gentle on the public data sources).
export const readScanInterval = (env) => readWholeNumber(env, 'SIFT_SCAN_INTERVAL_SECONDS', { min: 30, max: 3600, fallback: 60 });
// How long each new token stays on the watch list: 0–120 minutes, default 30.
// 0 judges tokens only once, at launch.
export const readWatchMinutes = (env) => readWholeNumber(env, 'SIFT_WATCH_MINUTES', { min: 0, max: 120, fallback: 30 });

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const claudeConfig = readClaudeConfig(process.env);
  const claude = claudeConfig ? createClaude(claudeConfig) : null;
  const scanIntervalSeconds = readScanInterval(process.env);
  const watchMinutes = readWatchMinutes(process.env);
  const dataDir = process.env.SIFT_DATA_DIR?.trim() || '.sift';
  const store = openStore(dataDir);
  const market = createMarketData();
  const call = createTelegram(token);

  const identity = await call('getMe', {}, shutdown.signal);
  const webhook = await call('getWebhookInfo', {}, shutdown.signal);
  verifyBot(identity, webhook);
  try {
    await call('setMyCommands', { commands: COMMAND_MENU }, shutdown.signal);
  } catch {
    console.warn('The Telegram command menu could not be updated; commands still work.');
  }
  console.log('Sift is running: criteria setup, on-demand /check, and /scan discovery alerts. Follow-up monitoring is not connected.');
  console.log(`Saved state: ${dataDir} (criteria, scanning switches, the watch list, the alert ledger and the update offset survive restarts).`);
  console.log(`Scanning: every ${scanIntervalSeconds}s while a tester has /scan on; each new token is watched for ${watchMinutes} min.`);
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');
  console.log(claude
    ? `Plain-language commands and criteria are interpreted by Claude (${claudeConfig.model}).`
    : 'Claude is off: testers cannot create criteria until ANTHROPIC_API_KEY is set.');

  // Either loop ending (fatal polling error, or shutdown) stops the other.
  const stop = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, stop.signal]);
  const scanSettings = { intervalSeconds: scanIntervalSeconds, watchMinutes };
  try {
    await Promise.all([
      runPolling({
        call,
        signal,
        initialOffset: store.getOffset(),
        onOffset: (offset) => store.setOffset(offset),
        handleUpdate: (update) => respond(update, { allowedUserIds, claude, store, market, scanSettings, signal }),
      }).finally(() => stop.abort()),
      runScanner({
        discovery: createDiscovery(),
        refresh: createTokenBatch(),
        store,
        signal,
        allowedUserIds,
        intervalMs: scanIntervalSeconds * 1000,
        watchMs: watchMinutes * 60_000,
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
