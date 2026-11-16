import { readConfig, respond, verifyBot } from './bot.js';
import { createInterpreter, readInterpreterConfig } from './interpret.js';
import { runPolling } from './polling.js';
import { createTelegram } from './telegram.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const interpreterConfig = readInterpreterConfig(process.env);
  const interpreter = interpreterConfig ? createInterpreter(interpreterConfig) : null;
  const call = createTelegram(token);
  const signal = shutdown.signal;
  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  console.log('Sift welcome bot is running. Discovery and monitoring are not connected.');
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');
  console.log(interpreter
    ? `Plain-language commands from testers are interpreted by Claude (${interpreterConfig.model}).`
    : 'Plain-language commands are off. Set ANTHROPIC_API_KEY to enable them.');

  await runPolling({
    call,
    signal,
    handleUpdate: (update) => respond(update, allowedUserIds, interpreter, signal),
  });
}

main().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Config/identity errors are fixed text. Other transport errors are sanitised.
  console.error(error instanceof Error ? error.message : 'Sift could not start.');
  process.exitCode = 1;
});
