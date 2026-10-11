# Host the welcome bot on Cloudflare Workers

This step moves the existing four commands from a temporary Codespace
to a Telegram webhook. It adds no discovery, AI, market data or monitoring.

## What is verified

- All 20 offline tests passed using fake credentials and mocked network calls.
- Tests cover command replies, tester isolation, webhook authentication,
  malformed requests, delivery failures and registration preflight checks.
- The four commands were previously verified live using Codespaces polling.
- This Worker has not yet been deployed or tested in Cloudflare's runtime.
  The checks at the end are required before calling hosted delivery verified.

## 1. Deploy the Worker

Use **Workers Free**. This small private test needs no paid plan, domain,
database, AI service or other paid integration. Free request, CPU and build
limits still apply; do not enable a paid plan to fix a deployment error.

1. Ensure the reviewed Cloudflare changes are on `main` in `Damianonyx/Sift-bot`.
2. In Cloudflare, choose **Create app**, then the option to import a GitHub
   repository. Give the Cloudflare GitHub app access to this repository.
3. Select `Sift-bot` and configure a **Worker**, with these settings:

   | Setting | Value |
   | --- | --- |
   | Worker name | `sift-bot` |
   | Production branch | `main` |
   | Root directory | Repository root (leave the default) |
   | Build command | `npm test` |
   | Deploy command | `npx wrangler@4 deploy` |
   | Build environment variable | `NODE_VERSION` = `24` |

   Wrangler is the deployment tool, fetched in Cloudflare's build environment.
   The bot itself uses no third-party runtime packages. The checked-in
   `wrangler.jsonc` selects `src/worker.js`; do not deploy `src/index.js`.
4. Deploy. The initial Worker is intentionally unable to process Telegram
   updates until runtime secrets are added.
5. Copy the **production** URL, shaped like
   `https://sift-bot.YOUR-SUBDOMAIN.workers.dev`. This URL is public, not a secret.

The dashboard labels can vary. Use Workers hosting for this endpoint.
Connecting GitHub enables builds and deployments when the production branch
changes. Keep unfinished work on other branches; disable non-production
branch builds for this private test if that setting is offered.

## 2. Add the two runtime secrets

Open the deployed Worker → **Settings** → **Variables and Secrets**.
Add both entries with **Secret** as the type, then deploy/save the changes:

| Name | Value to enter privately |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The existing @SiftAgentbot token from BotFather |
| `SIFT_ALLOWED_USER_IDS` | Your own numeric Telegram ID returned by `/id` |

These are Worker runtime settings, not build variables. Codespaces secrets
are not automatically copied to Cloudflare. Never put either value in Git,
a screenshot, an issue, chat, a browser address bar, or a shell command.

The `/health` path returns a liveness response. It does **not** prove the
token, tester access, or Telegram delivery is ready. The authenticated
readiness check in the next step verifies bot identity and tester setup.

## 3. Switch Telegram from polling to the Worker

Use the existing Codespace once for this setup. Its `TELEGRAM_BOT_TOKEN`
secret must still be available. Stop the running `npm start` process with
**Ctrl+C** before registering the webhook. Do not start another poller.

Load the merged code from `main` in that Codespace before running setup.
Preserve any local changes if Git reports them; do not force-reset the
workspace. Once the correct code is loaded, run:

```sh
npm test
npm run webhook:setup -- https://sift-bot.YOUR-SUBDOMAIN.workers.dev
```

Replace only the example URL with your production Worker URL. This command
uses the bot token already in secure environment settings; it never prints it.

Before switching, setup verifies @SiftAgentbot's identity, checks for an
existing deployment, and authenticates against the Worker's `/ready` route.
It refuses to replace a webhook at a different URL. It preserves pending
updates and verifies Telegram accepted the target URL.

Both runtimes derive the same webhook header secret using HMAC-SHA-256
with the bot token and a fixed Sift-specific purpose. The derived secret is
sent to Telegram over HTTPS and verified by Web Crypto on incoming requests.
It is never printed. There is no third secret to copy manually. After a bot
token rotation, update both runtime secrets and run setup again.

Successful registration confirms the connection settings; it does not prove
a message has made the full trip. Complete the following live checks.

## 4. Verify delivery, then stop Codespaces

- Send `/start`, `/help`, `/status`, and `/id` privately to @SiftAgentbot.
- Confirm each reply arrives, and `/status` still says discovery and monitoring
  are not connected.
- Stop the Codespace from GitHub's Codespaces page. Send another `/status`
  in Telegram to verify the response is independent of Codespaces.
- Record any failed, delayed or repeated replies. An unlisted-account and
  group-message check still need separate live validation.

The phone browser can close after setup. Cloudflare invokes the Worker for
new Telegram requests; it is not a continuously running polling process.
Avoid repeatedly starting the old poller: it refuses to start while a webhook
is registered. Returning to polling requires deliberately removing the webhook;
this project does not delete a deployment automatically.

## Current limits and troubleshooting

- `/ready` returning `401` usually means the token differs between the setup
  environment and the Worker. Check secure settings without sharing values.
- Readiness can also fail if no valid tester IDs are set or the token belongs
  to a different bot. Registration stops before changing Telegram in these cases.
- A reply is acknowledged only after Telegram confirms `sendMessage`.
  A blocked chat (403) is skipped; other send failures return 503 for retry.
- Telegram may retry delivery. There is no durable deduplication or alert
  history yet, so an ambiguous send can produce a repeated welcome reply.
  Reliable persisted processing must precede discovery and monitoring alerts.
- Unsupported updates and group messages are acknowledged without replies.
- The application does not log message bodies, tokens or header secrets.
  Worker observability is disabled in the checked-in configuration. Do not
  add request/header logging to debug authentication.
- No live message guarantees are implied by the offline tests. Record the
  actual Cloudflare deployment and Telegram results in the README after testing.

References: [Workers Git builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
[runtime secrets](https://developers.cloudflare.com/workers/configuration/secrets/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Telegram webhooks](https://core.telegram.org/bots/api#setwebhook).
