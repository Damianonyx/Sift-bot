import { readConfig, verifyBot } from './bot.js';
import { createResponder } from './commands.js';
import { createTelegram } from './telegram.js';
import { openAgentStore } from './agent-store.js';
import { runPolling } from './polling.js';
import { createMarketData } from './market.js';
import { createDiscoveryFeed } from './discovery-feed.js';
import { createPumpFeed, readPumpConfig } from './pump-feed.js';
import { createCandidateSources } from './candidate-sources.js';
import { createMeteora, readMeteoraConfig } from './meteora.js';
import { createSourceAudit } from './source-audit.js';
import { criteriaKey } from './discovery-store.js';
import { assertApprovable } from './rules.js';
import { createDiscoveryRunner } from './discovery.js';
import { createWatchRunner } from './watch.js';
import { createRiskData } from './risk.js';
import { createLiquidityData } from './liquidity.js';
import { createSolanaRpc } from './solana-rpc.js';
import { createBundleData } from './bundle-evidence.js';
import { createGroups } from './groups.js';
import { createDescriptionInterpreter, readAiConfig } from './description-ai.js';
import { createDescriptionCommands } from './description-commands.js';
import { createPositionQuotes } from './position-size.js';
import { createHolderData } from './holders.js';
import { createSignalTracker } from './signal-tracking.js';
import { acquireRuntimeLock, readRuntimeConfig } from './runtime-safety.js';
import { createWebServer, readWebConfig } from './web-server.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const runtime = readRuntimeConfig(process.env);
  const { token, allowedUserIds } = readConfig(process.env);
  const aiConfig = readAiConfig(process.env);
  const pumpConfig = readPumpConfig(process.env);
  const meteoraConfig = readMeteoraConfig(process.env);
  const webConfig = readWebConfig(process.env);
  const lock = await acquireRuntimeLock({directory:runtime.directory});
  try { await runBot({token,allowedUserIds,aiConfig,pumpConfig,meteoraConfig,webConfig,lock}); }
  finally { await lock.release(); }
}

async function runBot({token,allowedUserIds,aiConfig,pumpConfig,meteoraConfig,webConfig,lock}) {
  const call = createTelegram(token);
  const runtimeStop = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, runtimeStop.signal, lock.signal]);
  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  const agents = openAgentStore({directory:lock.directory});
  const market = createMarketData();
  const meteora = createMeteora(meteoraConfig);
  const feed = createCandidateSources({ gecko: createDiscoveryFeed(), pump: createPumpFeed(pumpConfig), meteora });
  const audit = createSourceAudit({ meteora });
  const rpc = createSolanaRpc();
  const liquidity = createLiquidityData({ rpc });
  const risk = createRiskData({ rpc, liquidity, agents });
  const bundles = createBundleData({ rpc });
  const quotes=createPositionQuotes(),holders=createHolderData({rpc});
  const groups = createGroups({ agents, call, botId:identity.id, allowedUserIds });
  const interpreter = createDescriptionInterpreter({ ...aiConfig, agents });
  const descriptionCommands = createDescriptionCommands({ agents, interpreter });
  const respond = createResponder({ agents, market, feed, liquidity, risk, bundles, groups, quotes, holders, audit, descriptionCommands, aiEnabled:aiConfig.enabled });
  const web = webConfig ? createWebServer({config:webConfig,agents,respond,allowedUserIds,signal}) : null;
  const discovery = createDiscoveryRunner({ agents, market, feed, risk, groups, call, allowedUserIds });
  const monitoring = createWatchRunner({ agents, market, call, allowedUserIds });
  const tracking=createSignalTracker({agents,market,risk,holders,call,allowedUserIds});
  console.log('Sift private test bot is running. Discovery requires approved supported rules and explicit activation.');
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');

  const shouldListen = () => groups.targets().length>0 || agents.discoveryActive().some((scan) => {
    if (!allowedUserIds.has(scan.user_id)) return false;
    const approved = agents.get(scan.user_id).approved;
    try { assertApprovable(approved); return criteriaKey(approved) === scan.criteria_key; }
    catch { return false; }
  });
  let tasks = [];
  try {
    if(web) {await web.listen();console.log('Sift web workspace enabled. Private testers can sign in with /web.');}
    const telegramRespond = async (update,allowed,signal) => web?.telegram(update,allowed) ?? respond(update,allowed,signal);
    tasks = [runPolling({ call, respond:telegramRespond, agents, allowedUserIds, signal }),
      feed.run({ signal, shouldListen }), discovery.run({ signal, beforeCycle:monitoring.cycle, afterCycle:tracking.cycle })];
    await Promise.all(tasks); if(lock.signal.aborted)throw lock.signal.reason;
  }
  finally {
    runtimeStop.abort();
    feed.close();
    await web?.close();
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

