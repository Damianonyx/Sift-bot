import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig, verifyBotIdentity } from '../src/bot.js';
import { createTelegram, TelegramError } from '../src/telegram.js';
import { SECRET_HEADER, webhookSecret } from '../src/webhook-auth.js';

class SetupError extends Error {}

function workerOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new SetupError('Provide the deployed sift-bot workers.dev URL.'); }
  if (url.protocol !== 'https:' || !/^sift-bot\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new SetupError('Use https://sift-bot.YOUR-SUBDOMAIN.workers.dev with no extra path or parameters.');
  }
  return url.origin;
}

export async function setupWebhook({ env, workerUrl, fetchImpl = fetch }) {
  const origin = workerOrigin(workerUrl);
  let token;
  try { ({ token } = readConfig(env)); }
  catch { throw new SetupError('Check TELEGRAM_BOT_TOKEN and SIFT_ALLOWED_USER_IDS in secure settings.'); }
  const call = createTelegram(token, { fetchImpl });
  try { verifyBotIdentity(await call('getMe')); }
  catch (error) {
    if (error instanceof TelegramError) throw error;
    throw new SetupError('The token does not belong to @SiftAgentbot. Nothing changed.');
  }
  const target = `${origin}/telegram`;
  const existing = await call('getWebhookInfo');
  if (typeof existing?.url !== 'string') throw new SetupError('Could not verify the existing webhook. Nothing changed.');
  if (existing.url && existing.url !== target) {
    throw new SetupError('A different webhook is active. Resolve the existing deployment first. Nothing changed.');
  }
  const secret = await webhookSecret(token);
  try {
    const ready = await fetchImpl(`${origin}/ready`, {
      headers: { [SECRET_HEADER]: secret }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    const data = await ready.json();
    if (!ready.ok || data?.service !== 'sift-bot' || data?.ready !== true) throw new Error();
  } catch {
    throw new SetupError('Worker readiness check failed. Check its URL, bot token and tester IDs. Nothing changed.');
  }
  const result = await call('setWebhook', {
    url: target, secret_token: secret, allowed_updates: ['message'],
    max_connections: 1, drop_pending_updates: false,
  });
  if (result !== true) throw new SetupError('Telegram did not confirm webhook setup. Verify the deployment before retrying.');
  const after = await call('getWebhookInfo');
  if (after?.url !== target) throw new SetupError('Webhook registration could not be verified. Verify the deployment before retrying.');
  return { pendingUpdates: Number.isSafeInteger(after.pending_update_count) ? after.pending_update_count : 'unknown' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  setupWebhook({ env: process.env, workerUrl: process.argv[2] }).then(({ pendingUpdates }) => {
    console.log(`Webhook registered for @SiftAgentbot. Pending updates: ${pendingUpdates}.`);
    console.log('Send /start, /help and /status in Telegram to verify live delivery.');
  }).catch((error) => {
    console.error(error instanceof SetupError || error instanceof TelegramError
      ? error.message : 'Webhook setup failed. Check the deployment without sharing credentials.');
    process.exitCode = 1;
  });
}
