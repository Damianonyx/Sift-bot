import { setTimeout as delay } from 'node:timers/promises';
import { isPermanentReplyError, TelegramError } from './telegram.js';

// The bot itself is misconfigured: stop instead of retrying.
export const FATAL_CODES = [401, 404, 409];

// Long-polls Telegram and answers each update in order. Resolves when `signal`
// aborts; rejects only on a fatal Telegram error.
// The offset is held in memory: a restart can repeat a reply (see README).
export async function runPolling({ call, handleUpdate, signal, log = console, sleep = delay }) {
  let offset = 0;
  // A reply that was built but not yet delivered. If sending fails and the
  // batch is retried, the same reply is reused, so a retry never repeats a
  // paid Claude request for the same update.
  let pending = null;

  while (!signal.aborted) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal);
      if (!Array.isArray(updates)) throw new TelegramError('INVALID_RESPONSE');
      for (const update of updates) {
        if (signal.aborted) return;
        if (!Number.isSafeInteger(update?.update_id)) throw new TelegramError('INVALID_RESPONSE');
        if (pending?.updateId !== update.update_id) {
          pending = { updateId: update.update_id, reply: await safeHandle(handleUpdate, update, signal, log) };
        }
        if (signal.aborted) return;
        if (pending.reply) {
          try {
            await call('sendMessage', pending.reply, signal);
          } catch (error) {
            if (!isPermanentReplyError(error)) throw error;
            // e.g. the user blocked the bot (403) or the chat is gone (400).
            // Retrying would repeat forever and block every later update.
            log.warn(`Telegram rejected a reply (${error.code}); the update was skipped.`);
          }
        }
        pending = null;
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TelegramError && FATAL_CODES.includes(error.code)) throw error;
      log.warn(error instanceof TelegramError ? error.message : 'Polling failed; retrying without logging request data.');
      const seconds = error instanceof TelegramError ? error.retryAfter : 5;
      await sleep(seconds * 1000, undefined, { signal }).catch(() => {});
    }
  }
}

// An unexpected error while handling one update skips that update rather than
// retrying it forever, which would stop every later message from being answered.
async function safeHandle(handleUpdate, update, signal, log) {
  try {
    return await handleUpdate(update);
  } catch {
    if (!signal.aborted) log.warn('An update could not be processed and was skipped.');
    return null;
  }
}
