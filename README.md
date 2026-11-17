![Sift Agent — Sift through the noise. Find your signal.](assets/sift-banner.jpg)

# Sift

**Your personal agent in the trenches.**

Sift is a Telegram-first project for personalised memecoin
discovery and monitoring.

The goal is to help traders spend less time searching for
tokens, repeating screening checks, and monitoring wallet
activity across different tools.

Bot: [@SiftAgentbot](https://t.me/SiftAgentbot)

## Current status

Sift is ready for private testing: each tester describes what they look
for, approves the resulting rules, and gets evidence-backed alerts when
new Solana tokens match. **Every tester has their own criteria**; there
are no shared or default rules.

- `/criteria <description>`: Claude turns a tester's plain words into
  typed screening rules (market cap, FDV, liquidity, 1h volume, 1h
  trades, pool age). Every rule must quote its words from the tester's
  own message, and its number must trace back to that quote ("5m" is
  $5,000,000 of market cap but 5 minutes of pool age). Anything vague,
  unsupported or untraceable is listed back as unresolved and never
  activated. Describing wanted tokens in plain words, without the
  command, works too. Claude proposes; it never decides.
- `/approve` and `/discard`: nothing takes effect without explicit
  approval. Approved criteria are versioned and stored in SQLite.
- `/scan on` and `/scan off`: automatic discovery. About once a minute
  Sift reads GeckoTerminal's newest Solana pools (up to 3 pages, roughly
  40 launches a minute at busy times), adds DexScreener market cap and
  FDV, which brand-new pools lack on GeckoTerminal, and keeps watching
  each token for 30 minutes as its numbers change. When a token
  satisfies every required rule of a tester's criteria, that tester
  gets one alert for it, with each value's provider and time.
- `/check <address>`, or just pasting an address: evaluates any Solana
  token against the tester's rules with live DexScreener data.
- Token addresses in replies are tap-to-copy. `/status` and `/scan`
  show what is running, and when a data source is down.
- `npm run preflight` checks the whole setup (Telegram, Claude, storage
  and both data sources) through the bot's own code.

A value a data source does not provide is `unknown`, and an unknown
never satisfies a required rule, so an alert only ever carries known,
labelled, timestamped values.

95 offline tests pass, and mutation checks confirm the safety rules are
each covered by a test. Live runs against the real GeckoTerminal and
DexScreener APIs (with Telegram and Claude scripted) produced real
alerts, including tokens caught minutes after launch by the watch list.
Not yet confirmed: the live @SiftAgentbot on a host, and a real
Anthropic key; `npm run preflight` checks both. On 2026-10-11, owner
screenshots verified the earlier welcome-bot commands live on mobile.

Follow-up monitoring of chosen tokens is not implemented; that product
feature below remains planned. For the launch checklist and a guide to
send testers, see [docs/private-testing.md](docs/private-testing.md).

## How Sift will work

1. Describe the tokens you want to find in everyday language.
2. Answer targeted questions about unclear instructions.
3. Review measurable screening rules and their limitations.
4. Approve and activate your agent.
5. Receive alerts when tokens satisfy your strict requirements.
6. Choose tokens to monitor for relevant changes.

AI will interpret instructions and explain findings.
Explicit rules will evaluate actual market and blockchain data.

## Planned first-version features

### Personalised discovery

Configure screening conditions such as token age, market cap,
liquidity, trading activity, and holder metrics where reliable
data is available.

Separate strict requirements from warning-only checks.
Changes to active rules will require user approval.

### Evidence-backed Telegram alerts

Alerts will include:

- Token name, symbol, chain, and full contract address.
- Reasons the token qualified.
- Relevant metrics and measurement windows.
- Detected concerns and unknown checks.
- Time checked and data freshness.
- Supporting source or transaction links.
- Controls to monitor, dismiss, or mute the token.

### Follow-up monitoring

Monitor selected tokens and wallets with supported deployer
attribution.

Report verified sales, transfers, and uncertain activity
separately. Track approved liquidity changes and relevant
screening-condition changes where the data supports them.

### Simple controls

Provide help, status, edit, pause, resume, and stop controls.
Preserve user settings and monitoring state across restarts.

## Proposed initial scope

These choices remain provisional:

- Solana as the first supported chain.
- One named agent per user.
- Private testing with the owner before invited testers.
- Free access during validation.
- A 24-hour monitoring period with extend and stop options.

Screening thresholds will be chosen by users.
Example strategies will not become silent defaults.

## Data and evidence principles

- Missing information is unknown, never an invented value.
- Unknown results cannot pass strict requirements.
- Live, cached, mock, and unsupported data are distinguished.
- Market cap and fully diluted valuation are labelled separately.
- Token creation and the start of trading are distinct events.
- Discovery sources, venue coverage, and freshness are disclosed.
- Suspected wallet coordination is not presented as proof.
- Unsupported bundle analysis is explicitly labelled.
- Service failures and monitoring interruptions are visible.

## Development roadmap

- [x] Basic Telegram response and configured private tester access.
- [x] Durable user settings and agent state (SQLite; criteria and the
  update offset survive restarts).
- [x] Real token-data checks and evidence validation (`/check` and
  scanning use DexScreener and GeckoTerminal, each value labelled).
- [x] Conversational setup and rule approval (`/criteria` → `/approve`).
- [x] One complete discovery-to-alert flow (`/scan on`: new pools,
  enriched and watched for 30 minutes, evaluated against each tester's
  approved rules, alerted once per token with evidence).
- [ ] Private testing with invited testers (see
  [docs/private-testing.md](docs/private-testing.md)).
- [ ] Alert follow-up controls (monitor, dismiss, mute buttons).
- [ ] Follow-up monitoring and event classification.

Each stage should report what works, what was tested,
and what remains incomplete.

## Later possibilities

- Website dashboard.
- Additional chains.
- Multiple agents per user.
- Advanced wallet clustering and bundle investigation.
- Preference learning from feedback.
- Periodic summaries.
- Paid subscriptions.

## Development setup

Sift runs on Node.js 24 LTS and uses its built-in HTTP, SQLite and test
APIs. Its only package is Anthropic's official SDK (`@anthropic-ai/sdk`).
To run it on a server around the clock, follow
[docs/hosting.md](docs/hosting.md).

### Local checks

```sh
npm install
npm test
```

Tests do not need credentials and do not contact Telegram or Anthropic.

### Connect the existing bot

Run these steps on the machine that will run the bot, not in a
GitHub issue, a chat message, or a public repository file editor.

1. Run `npm install`, then copy `.env.example` to `.env`, which is
   ignored by Git.
2. Set `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` in that file. Never
   share or commit their values. Without the Anthropic key the bot runs,
   but testers cannot create criteria.
3. Start with `SIFT_ALLOWED_USER_IDS` empty and run `npm start`.
4. Open @SiftAgentbot privately in Telegram and send `/id`.
5. Add the returned numeric ID to `SIFT_ALLOWED_USER_IDS` (more testers
   as comma-separated IDs), stop the bot with Ctrl+C, and run
   `npm run preflight`. Fix anything marked with a cross, then
   `npm start` again.
6. In Telegram: `/criteria at least 10k liquidity and market cap under
   2m`, then `/approve`, then `/scan on`. Paste any Solana token address
   to check it.

Optional settings: `SIFT_CLAUDE_MODEL` (default `claude-opus-5-5`),
`SIFT_SCAN_INTERVAL_SECONDS` (default 60), `SIFT_WATCH_MINUTES`
(default 30; 0 judges tokens only at launch), and `SIFT_DATA_DIR`
(default `.sift/`).

The process verifies that the token belongs to @SiftAgentbot and
refuses to start polling if a webhook is configured. It never deletes
an existing webhook automatically. Run only one polling process for
this bot; Telegram conflict errors stop it.

### First live acceptance check

Checked items reflect owner-provided screenshots; unchecked items
have not yet been confirmed in live Telegram testing.

- [x] `/id` returns the sender's own ID in a private chat.
- [x] An allowed tester receives the welcome on mobile.
- [ ] An unlisted account receives a private-testing notice and can only
  retrieve its own ID.
- [ ] Group messages do not receive replies.
- [x] `/help` lists the supported commands.
- [x] `/status` gives an honest summary (verified on the welcome-bot version).
- [ ] `npm run preflight` passes on the host.
- [ ] Graceful process shutdown and restart with unchanged configuration.
- [ ] `/criteria` with a real Anthropic key proposes only explicitly
  stated rules and lists the rest as unresolved.
- [ ] `/approve` activates the proposal, and criteria survive a restart.
- [ ] `/check` on a real token reports live values with provenance, and
  an unknown value never passes a required rule.
- [ ] `/scan on` delivers an alert for a genuinely new pool on the live
  bot, exactly once per token, and `/scan off` stops alerts.
- [ ] Tapping the token address in an alert copies it on mobile.
- [ ] Removing a tester's ID and restarting stops their alerts.

### Testing in GitHub Codespaces

Set `TELEGRAM_BOT_TOKEN` and `SIFT_ALLOWED_USER_IDS` (and optionally
`ANTHROPIC_API_KEY`) as personal Codespaces secrets, granting access only to this repository. Stop and
reopen an existing Codespace after adding or changing those secrets,
then run `npm start`. A local `.env` file is unnecessary in this setup;
the `.env not found` notice is expected when the variables come from
Codespaces secrets.

Codespaces is a temporary test environment. Stop it when finished to
conserve included compute usage; stored Codespaces also consume the
storage allowance. Review account usage and billing settings before
continued use. Running this test does not establish continuous hosting.

### Current runtime limits

This version uses long polling and replies only while its process is
running. GitHub stores the code; it does not host this always-on process.
To keep the bot online, run it on a small Linux server (VPS) as a
system service: [docs/hosting.md](docs/hosting.md) walks through the
setup, and `deploy/sift-bot.service` is the service file. The server
provider's fee is a separate decision for the owner.

Saved criteria, scanning switches, the watch list, the alert ledger and
the Telegram update offset live in a SQLite file under `SIFT_DATA_DIR`
(default `.sift/`, or `/var/lib/sift-bot` under the systemd service).
Tester IDs are read from configuration at startup; removing an ID and
restarting cuts that tester off at once, including queued alerts. Message bodies and
bot tokens are not logged by this application. Telegram still handles
messages under its own service policies.

When Claude features are on, two kinds of tester text reach Anthropic's
API under its policies: a non-command message (up to 500 characters) to
choose a command, and a criteria description (up to 1,000 characters)
to propose rules. `/check` and scanning send only token addresses to
DexScreener and GeckoTerminal, under their policies; no tester data.
Other slash commands, pasted addresses, and messages from unlisted
accounts are never sent to Claude.

Each Claude call is one paid API request. Per tester and minute, 5
routing and 3 criteria requests are allowed; beyond that, and whenever
Claude is unavailable, declines, or returns anything that fails
validation, Sift answers with fixed text and changes nothing. If
Anthropic rejects the API key or model, Claude features turn off until
the next restart, and `/status` says so. Updates are answered one at a
time, so a slow Claude or DexScreener request delays later replies (by
up to about 40 seconds in the worst case).

If Telegram permanently rejects a reply (a 4xx error other than a rate
limit, such as a blocked bot or a missing chat), that update is skipped
with a warning so one message cannot stall all later ones. Rate limits,
server errors, and network failures are retried.

The update offset is saved after each handled message, so a restart
resumes where the bot stopped. Delivery is at-least-once: a crash in
the moment between sending a reply and saving the offset can repeat
that one reply. Telegram may retain pending updates for up to 24
hours; messages sent while the bot is down are answered on startup.

Scanning runs only while at least one allowed tester has `/scan on`.
Each cycle reads up to 3 pages of new pools from GeckoTerminal; if it
rate-limits, discovery pauses with backoff (1 to 5 minutes) while the
watch list keeps being re-checked on DexScreener, at most 20 batch
requests a cycle. Pool values (liquidity, volume, trades, age) come
from the discovered pool and token values (market cap, FDV) from
DexScreener; every value in an alert names its provider. DexScreener
reports no liquidity for pump.fun tokens still on their bonding curve,
so after launch a required liquidity rule only matches tokens trading
in an AMM pool. A new pool can belong to an older token; the alert
shows the pool's age.

Alerts go through a ledger: each is recorded before sending, retried
on transient failures up to 5 times with sends paced about a second
apart, dropped if still undelivered after 30 minutes, and abandoned
(with that tester's scanning turned off) if Telegram rejects it
permanently. `/scan off` and approving new criteria both cancel alerts
still queued, even mid-burst, so nothing is sent that the tester's
current settings would not send; a cancelled token can still alert
later if it matches the current rules. A tester is alerted at most once
per token, and that survives criteria changes: a token alerted under v1
does not alert again under v2. Alerts only fire
while the process runs; launches during downtime are missed, not
backfilled.

Credentials must remain outside source control, chat, and logs.

## Product boundaries

Sift will not connect to trading wallets, hold funds, request
private keys, or execute trades.

A token matching screening conditions does not establish
safety or predict profit. Users remain responsible for their
research and trading decisions.

