import { readConfig, verifyBot } from './bot.js';
import { createResponder } from './commands.js';
import { createTelegram } from './telegram.js';
import { openAgentStore } from './agent-store.js';
import { runPolling } from './polling.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const call = createTelegram(token);
  const signal = shutdown.signal;
  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  const agents = openAgentStore();
  const respond = createResponder({ agents });
  console.log('Sift private test bot is running. Manual Solana checks use DEX Screener; source health is checked on demand.');
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');

  try {
    await runPolling({ call, respond, agents, allowedUserIds, signal });
  } finally { agents.close(); }
}

main().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Config/identity errors are fixed text. Other transport errors are sanitised.
  console.error(error instanceof Error ? error.message : 'Sift could not start.');
  process.exitCode = 1;
});
