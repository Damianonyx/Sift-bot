import { setTimeout as delay } from 'node:timers/promises';
import { TelegramError } from './telegram.js';
import { AgentStoreError } from './agent-store.js';

// The caller owns the store lifetime. Only acknowledge updates after delivery.
export async function runPolling({ call, respond, agents, allowedUserIds, signal, wait = delay, log = console }) {
  let offset = agents.offset();
  while (!signal.aborted) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal);
      if (!Array.isArray(updates)) throw new TelegramError('INVALID_RESPONSE');
      for (const update of updates) {
        if (signal.aborted) return;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new TelegramError('INVALID_RESPONSE');
        if (update.update_id < offset) continue;
        const reply = await respond(update, allowedUserIds, signal);
        if (reply) {
          const { callbackQueryId, callbackNotice, ...message } = reply;
          if (callbackQueryId) {
            try { await call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: callbackNotice }, signal); }
            catch (error) {
              // Old callback acknowledgements expire. Still send the saved reply.
              if (!(error instanceof TelegramError) || ![400, 403].includes(error.code)) throw error;
            }
          }
          if (message.text) {
            try { await call('sendMessage', message, signal); }
            catch (error) {
              if (!(error instanceof TelegramError) || error.code !== 403) throw error;
              // The user blocked the bot or chat access was removed. Skip this reply.
              log.warn('Telegram denied a reply (403); the update was skipped.');
            }
          }
        }
        if (signal.aborted) return;
        agents.acknowledge(update.update_id);
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AgentStoreError) throw error;
      if (error instanceof TelegramError && [401, 404, 409].includes(error.code)) throw error;
      log.warn(error instanceof TelegramError ? error.message : 'Polling failed; retrying without logging request data.');
      const seconds = error instanceof TelegramError ? error.retryAfter : 5;
      await wait(seconds * 1000, undefined, { signal });
    }
  }
}
