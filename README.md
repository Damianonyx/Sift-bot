![Sift Agent — Sift through the noise. Find your signal.](assets/sift-banner.jpg)

# Sift

**Your personal agent in the trenches.**

Sift is a private Telegram bot for personalised Solana memecoin discovery and
monitoring: [@SiftAgentbot](https://t.me/SiftAgentbot).

This build combines description-based criteria, bounded discovery, risk evidence
and admin-controlled group alerts. Candidate sources include PumpPortal,
GeckoTerminal and direct Meteora DLMM/DAMM v2 APIs. `/verify <CA>` compares
provider observations for the same pool; it does not certify their accuracy.
**Unknown required checks never qualify a coin. General bundle coverage remains
unknown, so the owner's complete risk policy cannot yet produce matching alerts.**
Hosting migration, the web app and public release remain deferred.
See the [Telegram build milestones](docs/telegram-build-milestones.md) for the
implemented, tested, live-observed and still-blocked parts of this build.

This update adds compact alerts with saved evidence, separate group strategies,
posting cadence and quiet hours, optional after-call checks, an immutable call
ledger with fixed-horizon paper outcomes, tester feedback, promotion disclosure,
holder-account samples and read-only position-size quotes. See the complete
[competitor-opportunity implementation and operating guide](docs/scout-intelligence.md),
including what remains unverified or unsupported.

## Current capabilities

- DEX Screener market snapshots with one selected pool, retrieval times, unknown
  metrics and evidence links. Market cap is never replaced by FDV.
- Same-pool source comparisons with explicit differences and missing data.
- Individual Copy CA buttons in manual reports, discovery and monitor alerts.
- Guided criteria, drafts, explicit review/approval and local SQLite persistence.
- `/describe` turns supported descriptions into a draft with the original text
  retained. Optional OpenAI interpretation is disabled by default.
- Bounded GeckoTerminal, Pump.fun (via PumpPortal) and Meteora DLMM/DAMM v2 discovery;
  explicit activation, private reports, delivery
  records, pause/resume/stop, dismissal and mute controls.
- Fixed-pool USD-liquidity monitoring with captured market rules and controls.
- LP burn verification for supported classic Raydium AMM v4/CPMM and PumpSwap accounts; narrow fixed-cliff
  Streamflow lock verification for classic SPL LP tokens with exact coverage.
- Pump `create` and supported `create_v2` signing-creator attribution, current holdings, direct PumpSwap
  sales, separate transfers, confirmed atomic coordinated buys and same-slot flags.
- Launch signatures used as locators for finalized creation proof; up to three
  mint-signature pages, bounded transaction reads, and reserved pool-check capacity.
- `/why` explains saved approval/evidence blockers without changing criteria or
  making provider requests. `/mapextras` offers explicit liquidity-scope choices
  when supported wording leaves that choice unresolved.
- Default free-only configuration, one-process locking per local data directory,
  read-only storage inspection and consistent backup/restore commands.
- Read-only **Verification limits** controls in `/agent` and `/scan`; unmapped
  extra instructions stay saved and continue to block approval.
- Read-only verification of a supplied Jito bundle ID against finalized on-chain buys.
- Group admins configure privately, connect a destination in their group, then
  explicitly approve sharing future matches. Access is rechecked before posting.

All 261 automated checks pass on Node.js 24.19.0. Fixtures
are synthetic; tests contact no providers or Telegram. Live source accuracy,
new risk commands and end-to-end alert behavior still require owner acceptance.
Earlier owner screenshots verified Telegram welcome/check replies and discovery
feed access; they did not verify these new risk claims or continuous hosting.

## Private commands

| Command | Purpose |
| --- | --- |
| `/start`, `/help`, `/status` | Welcome, commands and actual service/user state |
| `/id` | Own Telegram ID, in a private chat only |
| `/setup` | Guided market criteria; send `risk` at the final question to add the explicit risk policy |
| `/describe <description>`, `/setup <description>` | Prepare a description for review; unresolved instructions block approval |
| `/agent`, `/cancel` | Review criteria or discard a draft |
| `/groups` | Review, enable or stop group destinations privately |
| `/riskrules` | Review replacement of existing extra instructions with the explicit risk policy |
| `/check <CA>` | Market snapshot and approved-rule evaluation |
| `/verify <CA>` | Compare DEX Screener/GeckoTerminal and check direct Meteora identity for supported pools |
| `/liquidity <CA>` | Selected-pool LP protection evidence |
| `/risk <CA>` | Liquidity, developer and buying evidence, flags and limitations |
| `/bundle <CA> <ID>` | Verify a known Jito bundle; missing status stays unknown |
| `/sources`, `/scan` | Inspect feed access; review and explicitly activate discovery |
| `/why` | Explain saved screening blockers and recent check results without starting a scan |
| `/watch <CA> <DROP_PERCENT> <HOURS>` | Review a market monitor; duration 1–168 whole hours |
| `/watchlist`, `/watchalerts` | Monitor controls and saved reports |
| `/pause`, `/stop` | Pause/stop discovery and all your market monitors |
| `/resume` | Resume discovery; resume individual monitors in `/watchlist` |
| `/alerts`, `/unmute <CA>` | Saved discovery reports and token unmute |
| `/preferences` | Follow-ups, UTC quiet hours, sizing and paper-cost assumptions |
| `/performance [ID]`, `/calls [PAGE]` | All-call outcomes, missing observations and saved delivery attempts |
| `/feedback ID RATING OUTCOME` | Unverified private tester feedback, separate from market results |
| `/followstop ID` | Stop one call's private follow-up notifications |
| `/size <CA> <USDC>` | Read-only Raydium entry/exit quotes; no wallet or transaction |
| `/holders <CA>`, `/poolcoverage <CA>` | Bounded account samples and indexed pools, with explicit coverage limits |
| `/mapextras`, `/audit` | Preview exact risk-policy mapping; inspect rule/configuration history |
| `/groupstrategy CHAT_ID`, `/groupconfig CHAT_ID MINUTES MAX`, `/grouppause CHAT_ID` | Independent group rules and posting controls, configured privately |

Start with the [description and group setup guide](docs/agent-discovery.md).
See [Pump.fun scouting and its coverage limits](docs/pumpfun-discovery.md) and
[data-source verification with recorded live results](docs/source-verification.md).
`/sources` now observes PumpPortal for up to 10 seconds before replying. It
distinguishes a valid event received during the check from a quiet or failed
observation; existing queued candidates and control messages cannot prove new
delivery. A live check on October 21 received a creation message in 3.263 seconds.
The source samples found a large market-cap disagreement and a missing pool
comparison; they do not establish uniform accuracy. Bubblemaps is deferred; no
paid integration was added.
In groups, `/group@SiftAgentbot connect` prepares a connection and
`/group@SiftAgentbot stop` stops sharing. Sift and the connecting tester must be
group admins. Other group messages are ignored; adding the bot starts nothing.

Risk rules require **100% selected-pool LP protection**, accept verified LP burns,
and require six **UTC calendar months remaining** on accepted locks (day clamped
to month-end). The developer must still hold tokens. Partial sales are allowed
and flagged; transfers are separate. Confirmed bundles/coordinated buys exclude;
suspicions are flagged. Unknown required evidence blocks qualification.

`/riskrules` first shows the exact unresolved text and replacement policy. Its
button creates a draft; approval and scan activation remain separate. Existing
market thresholds are retained. Nothing automatically discards old instructions,
approves rules, starts scans or invites testers. Editing preserves risk rules.
The replacement policy covers one selected pool, not every pool for a token.
Use **Verification limits** to review the difference without changing your draft.

Read [risk evidence and coverage](docs/risk-evidence.md) before testing. Complete
bundle coverage is unavailable; no lack of observed sales/bundles is treated as
proof of absence. Wallet attribution is limited to the supported signing creator,
not a claim about a real person's identity. Other venues, lockers, launch formats,
positions and missing histories remain unknown. `/watch` is market monitoring,
not a wallet event subscription or a lock-break detector.

## Local setup and verification

Node.js **24 LTS** on Linux with `flock` (available in Codespaces and Ubuntu).
No third-party runtime packages or install step.

```sh
npm test
npm run preflight
npm start
```

For the bounded live source diagnostic, stop the other Sift process and run
`npm run check:live`. It makes read-only public-data requests, leaves saved rules
unchanged and sends no Telegram message by default. See the
[live verification steps](docs/pumpfun-discovery.md#run-the-live-check-in-codespaces).

`preflight` checks local runtime/private configuration only. It prints no tokens
or tester IDs, makes no network requests and changes no saved data. It does not
replace live acceptance. GitHub Actions runs the same offline tests on changes.

To connect the existing bot, configure `TELEGRAM_BOT_TOKEN` and
`SIFT_ALLOWED_USER_IDS` as Codespaces/hosting secrets or in an ignored local
`.env` copied from `.env.example`. Never put values in chat, issues or Git.
An empty allowlist enables only private `/id` bootstrap; obtain your ID, add it
to the allowlist and restart. Test-week preflight requires at least one tester.

Run exactly one polling process. Startup holds a local OS lock for the configured
data directory and refuses a second process using that directory. Separate
hosts or separate copies of the database still require operator coordination.
Startup verifies @SiftAgentbot and refuses to
poll over an existing webhook; it never removes that webhook automatically.
Telegram polling conflicts stop the process. Unlisted users cannot use evidence
commands or background work. Group configuration is limited to verified admins;
other group traffic cannot read private settings. Access remains private.
The existing source repository is public; the bot's allowlist controls bot access.

## One week before any public release

Follow [the private testing plan](docs/private-testing.md), including owner
acceptance before invitations and a daily evidence record. No test week has been
started and no public release is automatic. General bundle coverage, live risk
evidence, complete full-strategy discovery and continuous hosting remain open
release requirements. Do not relax thresholds to manufacture a match.

The default build enforces **`SIFT_FREE_ONLY=true`** and makes **no paid AI calls**.
It refuses to start with paid AI enabled while this guard is on. Local description parsing and the
existing public data sources require no new paid subscription. Optional AI is
off. A future separately funded operator would need to explicitly disable the
free-only guard before enabling `SIFT_AI_ENABLED`, `OPENAI_API_KEY` and
`SIFT_AI_MODEL`; keep the guard on for the current $0 build. API usage is separately billed; ChatGPT/Codex credits do not
fund it. See the [limits and configuration](docs/agent-discovery.md#optional-ai-interpretation).
No paid service was activated, and no hosting purchase was made. Codespaces is
temporary and consumes existing compute/storage allowances. The bot only works
while its process runs; a calendar week is not a claim of seven-day uptime.

## Storage and operating limits

Local `.sift/agents.sqlite` (or `SIFT_DATA_DIR/agents.sqlite`) stores per-user criteria, drafts, polling receipts,
scan/watch state, evaluations, mutes, group destinations/delivery records and AI
request reservations. It also retains original call snapshots, fixed-horizon
observations, follow-up events, preferences, rule/configuration history and
unverified tester feedback. These records are not automatically pruned; monitor
disk usage and include them in private backups. Original descriptions may be saved with criteria. Its directory
and database use restrictive permissions; the database is not encrypted. Keep
the data directory and WAL/SHM files private. Use the consistent backup tool in
[storage recovery](docs/telegram-build-milestones.md#storage-recovery); copying
only an active database file can omit committed WAL data. Restarting
with the same database preserves state; deleting the runtime/database loses it.
Corrupt state stops the bot rather than replacing user settings.

Discovery checks at most 20 distinct candidates per cycle, interleaving the first
GeckoTerminal new-pools page, a bounded Pump.fun event queue and the first 20
pools from each Meteora protocol. Both Meteora pool mints are candidates; X/Y
is not assumed to mean base/quote. Meteora candidates rotate after selection.
`SIFT_METEORA_ENABLED=false` disables both direct Meteora feeds. PumpPortal's
free launch/migration subscriptions are enabled by default; no key or wallet is
used. The stream connects only for approved active scans or short `/sources`
diagnostics. It retains at most 200 candidates for 20 minutes in memory, rotating
attempted candidates for indexing retries. Dropped events and gaps remain visible.
Market checks share a three-second cooldown; GeckoTerminal has a one-minute
cache; Meteora refreshes at most once per minute per protocol. Risk checks have a one-minute cooldown and a 45-second deadline, so not
all candidates receive chain evidence. Unknown/limited evidence cannot match.
Source limits and slow calls extend cycle times; there is no downtime catch-up.

Each discovery rule set/token gets at most one automatic delivery attempt.
Reports are saved first; failed/uncertain sends are available in `/alerts`
instead of blindly retried. Monitoring allows three open monitors per user,
twenty process-wide, and three attempted alerts per user per cycle. Each monitor
condition reports once; repeat events may not re-alert. Extra reports are saved
as suppressed. This is not exactly-once delivery or a complete observation time
series. Retention/deletion and continuous hosting remain future work.

Group posting permits three destinations per tester and three attempts per
destination per cycle. Each destination/rule set/token is attempted once; a
restart or reconnect does not replay prior alerts. Group errors are visible in
`/groups`. Pausing a private scan prevents group posts. Approved-rule changes
pause group destinations until the admin reconnects and reviews them again.

A USD liquidity fall may reflect prices or balances; it is not proof of removal,
a broken lock or developer selling. Matching criteria never establishes safety
or predicts returns. Sift does not hold funds, ask for private keys or trade.
