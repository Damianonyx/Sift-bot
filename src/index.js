import { setTimeout as delay } from 'node:timers/promises';
import { readConfig, verifyBot } from './bot.js';
import { createResponder } from './commands.js';
import { createTelegram, TelegramError } from './telegram.js';

const shutdown = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => shutdown.abort());
}

async function main() {
  const { token, allowedUserIds } = readConfig(process.env);
  const call = createTelegram(token);
  const respond = createResponder();
  const signal = shutdown.signal;
  const identity = await call('getMe', {}, signal);
  const webhook = await call('getWebhookInfo', {}, signal);
  verifyBot(identity, webhook);
  console.log('Sift private test bot is running. Manual Solana checks use DEX Screener; source health is checked on demand.');
  if (allowedUserIds.size === 0) console.log('No testers configured. Only /id lookup is available.');

  // No saved strategies or monitoring state in this manual-check milestone.
  // Persistent processing/delivery records belong to the monitoring milestone.
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal);
      if (!Array.isArray(updates)) throw new TelegramError('INVALID_RESPONSE');
      for (const update of updates) {
        if (signal.aborted) return;
        if (!Number.isSafeInteger(update?.update_id)) throw new TelegramError('INVALID_RESPONSE');
        const reply = await respond(update, allowedUserIds, signal);
        if (reply) {
          try {
            await call('sendMessage', reply, signal);
          } catch (error) {
            if (!(error instanceof TelegramError) || error.code !== 403) throw error;
            // The user blocked the bot or chat access was removed. Skip this reply.
            console.warn('Telegram denied a reply (403); the update was skipped.');
          }
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TelegramError && [401, 404, 409].includes(error.code)) throw error;
      console.warn(error instanceof TelegramError ? error.message : 'Polling failed; retrying without logging request data.');
      const seconds = error instanceof TelegramError ? error.retryAfter : 5;
      await delay(seconds * 1000, undefined, { signal });
    }
  }
}

main().catch((error) => {
  if (shutdown.signal.aborted) return;
  // Config/identity errors are fixed text. Other transport errors are sanitised.
  console.error(error instanceof Error ? error.message : 'Sift could not start.');
  process.exitCode = 1;
});
