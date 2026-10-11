# Sift

**Your personal agent in the trenches.**

Sift is a Telegram-first project for personalised memecoin
discovery and monitoring.

The goal is to help traders spend less time searching for
tokens, repeating screening checks, and monitoring wallet
activity across different tools.

Bot: [@SiftAgentbot](https://t.me/SiftAgentbot)

## Current status

Sift is in private development for the existing @SiftAgentbot:

- `/start`: a welcome message for approved testers.
- `/help`: the commands available in this version.
- `/status`: an honest summary of what is and is not connected.
- `/id`: shows the sender their own Telegram user ID in a private chat.
- `/check <CA>`: a manual Solana market snapshot from DEX Screener for
  approved testers. Missing metrics and unsupported checks stay unknown.

All nine offline tests passed locally and in the owner's Codespace.
On 2026-10-11, owner-provided screenshots confirmed live `/id`,
`/start`, `/help`, and `/status` replies from @SiftAgentbot on mobile.
The status reply correctly identifies scanning and monitoring as unavailable.
The bot was run temporarily in GitHub Codespaces using Codespaces
secrets. Continuous hosting has not been configured and is postponed
until the bot's core flows are built and tested. The separate Cloudflare
proposal is not part of this manual token-check implementation.

The manual `/check` implementation and existing commands pass 20 offline
tests using mocked network responses. On 2026-10-11, the owner's
Telegram screenshot confirmed a live /check response for cat wif sword
(swordcat), including the full CA, selected Meteora pool, seven supported
pools, source links, measurements and unknown checks. An empty /check
also returned usage guidance. These observations verify the command and
data-delivery path; the reported metrics have not been independently
reconciled with the source. No mock metrics are used by the running bot.

Discovery, AI interpretation, monitoring, and durable user/agent state
remain unimplemented. The first welcome-response milestone is verified;
the manual-check delivery path is verified by the owner; independent data
accuracy and the remaining access/failure checks below still need validation.

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
- [x] Manual Solana market-data adapter, private command and offline tests.
- [ ] Live token-data checks and evidence validation.
- [ ] Durable user settings and agent state.
- [ ] Conversational setup and rule approval.
- [ ] One complete discovery-to-alert flow.
- [ ] Follow-up monitoring and event classification.
- [ ] Reliability testing and invited-user validation.

Each stage should report what works, what was tested,
and what remains incomplete.

Build order: validate one submitted CA; save and review measurable
criteria; connect conversational interpretation; validate one discovery
source and alert flow; then add follow-up monitoring with supported
evidence. Hosting follows those core stages. Providers, AI usage and
any operating costs must be reviewed before paid services are introduced.

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
They also mock market-data responses and do not contact DEX Screener.

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
delivery can repeat a reply or re-fetch a manual check. Persistent processing and delivery
records are required before adding discovery or monitoring alerts.
Telegram may retain pending updates for up to 24 hours; earlier
messages can be processed on first startup.

Credentials must remain outside source control, chat, and logs.

## Manual token-check stage

Use `/check` followed by one full Solana mint address. The bot verifies
its 32-byte base58 format before making any market request. Format alone
does not prove that an address is a token mint. Unknown users, groups,
and messages addressed to another bot cannot request market data.

The source is the public DEX Screener endpoint
`GET https://api.dexscreener.com/token-pairs/v1/solana/{tokenAddress}`.
This stage adds no API key, account, package dependency or paid service.
Only the submitted public CA is sent to the provider; Telegram IDs,
messages and bot credentials are not sent there.

The response reports one pool with the highest **known, reported** USD
liquidity among returned Solana pools where the CA is the base token.
Pools with missing liquidity are counted and disclosed. If every supported
pool has unknown liquidity, the first returned pool is explicitly labelled
as an unranked fallback. Quote-only pairs are excluded because their base
token's price, valuation and buy/sell direction would describe another asset.
Pool liquidity and activity are not aggregated across venues.

Each report includes the full CA, name/symbol, selected pool/venue, price,
market cap and FDV as separate provider estimates, USD liquidity, and
volume plus buy/sell counts over provider rolling 5m, 1h and 24h windows.
Pool creation age is labelled separately from unknown token creation and
trading start. Chart links use the validated pool address on DEX Screener;
an API source link identifies the response used.

Holder count/concentration, bundles, deployer attribution, developer
sales/transfers and token permissions remain unknown/unsupported.
No strategy is applied, no match alert is sent, and no safety score is invented.
An empty or unsupported response means coverage is unknown, not that the
token cannot exist. A provider error produces an unavailable-data reply.

Reports include the API retrieval time. The provider's actual update time
is unknown and data may be delayed; Sift does not cache snapshots in this
stage. `/status` shows the last source request result and timestamp for
this running session, without showing anyone's submitted CA or message.
This status is shared service health, not a record of individual checks.

The client allows one request at a time with a three-second process-wide
cooldown, an eight-second request timeout and a 2 MiB response limit.
HTTP 429 responses impose a provider Retry-After backoff (60 seconds if
unavailable). These are resource controls, not trading thresholds.
The temporary health/cooldown state resets when the bot restarts.

### Live acceptance still required

- [ ] Submit a known Solana token CA; compare the selected pool and reported
  metrics against its linked DEX Screener page around the retrieval time.
- [ ] Check missing market cap separately from any reported FDV.
- [ ] Confirm an invalid address receives usage help without a market request.
- [ ] Confirm `/status` reports provider success or failure truthfully.
- [ ] Check access from an unlisted Telegram account and a group.
- [ ] Check source outage/rate-limit behaviour during a controlled test.

Reference: [DEX Screener API](https://docs.dexscreener.com/api/reference).

## Product boundaries

Sift will not connect to trading wallets, hold funds, request
private keys, or execute trades.

A token matching screening conditions does not establish
safety or predict profit. Users remain responsible for their
research and trading decisions.
