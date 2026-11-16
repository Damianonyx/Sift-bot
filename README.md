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

Sift is early in development. This repository now implements the
criteria milestone for the existing @SiftAgentbot:

- `/start`, `/help`, `/status`, `/id`: welcome, commands, an honest
  summary of what is and is not connected, and the sender's own ID.
- `/criteria <description>` (needs `ANTHROPIC_API_KEY`): Claude turns a
  tester's plain words into typed screening rules. Every rule must
  quote its number from the tester's own message; anything vague,
  unsupported or embedded as an instruction is listed back as
  "unresolved" and never activated. Claude proposes; it never decides.
- `/approve` and `/discard`: nothing takes effect without explicit
  approval. Approved criteria are versioned and stored in SQLite, so
  they survive restarts.
- `/check <address>`: evaluates a Solana token against the tester's
  approved rules using live DexScreener data. Replies show each rule's
  result with the measured value, its provenance and timestamp, the
  selected pool (best liquidity, with DEX and link), and the rule that
  failed. A value the data source does not provide is `unknown`, and an
  unknown can never satisfy a required rule.
- Plain-language commands (optional): free text such as "what works
  today?" maps to one of the fixed commands. Sift always sends its own
  fixed reply text; Claude never writes replies.

All 44 offline tests pass. The full flow (describe, approve, restart,
check) was exercised end to end against the real DexScreener API with a
scripted Claude stand-in; it has not yet been run against the live
@SiftAgentbot or with a real Anthropic key, and continuous hosting has
not been configured. On 2026-10-11, owner screenshots verified the
earlier welcome-bot commands live on mobile.

Scheduled discovery, alerts, and follow-up monitoring are not
implemented; those product features below remain planned.

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
- [x] Real token-data checks and evidence validation (on-demand
  `/check` via DexScreener; scheduled scanning still pending).
- [x] Conversational setup and rule approval (`/criteria` → `/approve`).
- [ ] One complete discovery-to-alert flow.
- [ ] Follow-up monitoring and event classification.
- [ ] Reliability testing and invited-user validation.

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

This milestone uses Node.js 24 LTS and its built-in HTTP and test
APIs. Its only package is Anthropic's official SDK
(`@anthropic-ai/sdk`), used for optional plain-language commands.

### Local checks

```sh
npm install
npm test
```

Tests do not need credentials and do not contact Telegram or Anthropic.

### Connect the existing bot

Run these steps on the machine that will run the bot, not in a
GitHub issue, a chat message, or a public repository file editor.

1. Copy `.env.example` to `.env`, which is ignored by Git.
2. Set `TELEGRAM_BOT_TOKEN` in that local file. For hosting, use the
   provider's secret settings instead. Never share or commit its value.
3. Start with `SIFT_ALLOWED_USER_IDS` empty and run `npm start`.
4. Open @SiftAgentbot privately in Telegram and send `/id`.
5. Add the returned numeric ID to `SIFT_ALLOWED_USER_IDS` and restart.
   Additional testers can be added as comma-separated IDs.
6. Send `/start`, `/help`, and `/status` from an allowed account.
7. Optional: set `ANTHROPIC_API_KEY` to turn on plain-language commands
   and `/criteria` setup, then restart. Send "what can you do?" from an
   allowed account; the reply should be the `/help` text. Then try
   `/criteria at least 10k liquidity`, `/approve`, and `/check` with a
   Solana token address. `SIFT_CLAUDE_MODEL` overrides the default
   model, `claude-opus-5-5`. `SIFT_DATA_DIR` moves the SQLite state
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
- [x] `/status` says that discovery, AI, data, and monitoring are not connected.
- [ ] Graceful process shutdown and restart with unchanged configuration.
- [ ] `/criteria` with a real Anthropic key proposes only explicitly
  stated rules and lists the rest as unresolved.
- [ ] `/approve` activates the proposal, and criteria survive a restart.
- [ ] `/check` on a real token reports live values with provenance, and
  an unknown value never passes a required rule.

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

There is no scanning job and no alert history. Saved criteria and the
Telegram update offset live in a SQLite file under `SIFT_DATA_DIR`
(default `.sift/`, or `/var/lib/sift-bot` under the systemd service).
Tester IDs are read from configuration at startup. Message bodies and
bot tokens are not logged by this application. Telegram still handles
messages under its own service policies.

When Claude features are on, two kinds of tester text reach Anthropic's
API under its policies: a non-command message (up to 500 characters) to
choose a command, and the description after `/criteria` (up to 1,000
characters) to propose rules. `/check` sends only the validated token
address to DexScreener, under DexScreener's policies. Slash-command
text and messages from unlisted accounts are never sent anywhere.

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

Credentials must remain outside source control, chat, and logs.

## Product boundaries

Sift will not connect to trading wallets, hold funds, request
private keys, or execute trades.

A token matching screening conditions does not establish
safety or predict profit. Users remain responsible for their
research and trading decisions.

