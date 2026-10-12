import { readConfig, verifyBot } from './bot.js';
import { createResponder } from './commands.js';
import { createTelegram } from './telegram.js';
import { openAgentStore } from './agent-store.js';
import { runPolling } from './polling.js';
import { createMarketData } from './market.js';
import { createDiscoveryFeed } from './discovery-feed.js';
import { createDiscoveryRunner } from './discovery.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const call = createTelegram(token);
  const runtimeStop = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, runtimeStop.signal]);
  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  const agents = openAgentStore();
  const market = createMarketData();
  const feed = createDiscoveryFeed();
  const respond = createResponder({ agents, market, feed });
  const discovery = createDiscoveryRunner({ agents, market, feed, call, allowedUserIds });
  console.log('Sift private test bot is running. Discovery requires approved supported rules and explicit activation.');
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');

  const tasks = [runPolling({ call, respond, agents, allowedUserIds, signal }), discovery.run({ signal })];
  try { await Promise.all(tasks); }
  finally {
    runtimeStop.abort();
    await Promise.allSettled(tasks);
    agents.close();
  }
}

main().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Config/identity errors are fixed text. Other transport errors are sanitised.
  console.error(error instanceof Error ? error.message : 'Sift could not start.');
  process.exitCode = 1;
});
