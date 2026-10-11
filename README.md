# Sift

**Your personal agent in the trenches.**

Sift is a Telegram-first project for personalised memecoin
discovery and monitoring.

The goal is to help traders spend less time searching for
tokens, repeating screening checks, and monitoring wallet
activity across different tools.

Bot: [@SiftAgentbot](https://t.me/SiftAgentbot)

## Current status

Sift is at the beginning of development. This repository now contains
the first welcome-bot implementation for the existing @SiftAgentbot:

- `/start`: a welcome message for approved testers.
- `/help`: the commands available in this version.
- `/status`: an honest summary of what is and is not connected.
- `/id`: shows the sender their own Telegram user ID in a private chat.

All nine offline tests passed locally and in the owner's Codespace.
On 2026-10-11, owner-provided screenshots confirmed live `/id`,
`/start`, `/help`, and `/status` replies from @SiftAgentbot on mobile.
The status reply correctly identifies scanning and monitoring as unavailable.
The bot was run temporarily in GitHub Codespaces using Codespaces
secrets. Continuous hosting has not been configured.

Discovery, AI interpretation, token checks, monitoring, and durable
user/agent state are not implemented. The product features below
remain planned. The first welcome-response milestone is verified;
the remaining live acceptance checks below still need confirmation.

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
- [ ] Durable user settings and agent state.
- [ ] Real token-data checks and evidence validation.
- [ ] Conversational setup and rule approval.
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

This first milestone uses Node.js 24 LTS and its built-in HTTP and
test APIs. There are no third-party packages to install.

### Local checks

```sh
npm test
```

Tests do not need credentials and do not contact Telegram.

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

### Testing in GitHub Codespaces

Set `TELEGRAM_BOT_TOKEN` and `SIFT_ALLOWED_USER_IDS` as personal
Codespaces secrets, granting access only to this repository. Stop and
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
Hosting selection and any spending are separate later decisions.

There is no database, scanning job, saved strategy, or alert history.
Tester IDs are read from configuration at startup. Message bodies and
bot tokens are not logged by this application. Telegram still handles
messages under its own service policies.

Update offsets are held in memory. A restart or an uncertain network
delivery can repeat a greeting. Persistent processing and delivery
records are required before adding discovery or monitoring alerts.
Telegram may retain pending updates for up to 24 hours; earlier
messages can be processed on first startup.

Credentials must remain outside source control, chat, and logs.

## Product boundaries

Sift will not connect to trading wallets, hold funds, request
private keys, or execute trades.

A token matching screening conditions does not establish
safety or predict profit. Users remain responsible for their
research and trading decisions.

