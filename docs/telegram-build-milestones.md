# Telegram build milestones

Last updated: 2026-10-25. Branch: `codex/live-discovery-check`.
This ledger separates implementation, offline tests and live observations.
It does not declare the full screening policy complete or start a tester week.
Hosting migration and the web app remain deferred. No paid service is enabled.

Verification: **261 offline tests pass** on Node.js 24.19.0, including the new
scope, runtime/backup, CPMM, creator-pagination and outcome-replay regressions.
Local preflight correctly refuses startup without a Telegram token in this
workspace; that refusal is not live runtime acceptance.

## 1. Discovery delivery and explanations

Implemented and regression-tested:

- Market snapshots must match the requested token and be no more than two
  minutes old at delivery, including after asynchronous group-admin checks.
- Private notification limits/deduplication no longer accidentally suppress
  an independently eligible inherited-group delivery. Mute, quiet-hour,
  scan-state, strategy and group-admin controls still apply.
- Failed market requests are shared within a monitoring cycle instead of
  repeated for each user watching the same pool.
- `/why` explains saved draft/approval/risk blockers and the latest saved
  per-token evaluations for the current rules (at most 20). Those evaluations
  can span cycles. The command makes no provider requests and changes nothing.
- A fresh-process import regression test catches module initialization cycles
  that a shared test process could otherwise conceal.

Live status: bounded candidate-feed access is observed; a qualifying strict-policy
Telegram delivery and group delivery have not been verified by this milestone.

## 2. Exact strategy mapping

`/mapextras` recognizes the supported risk wording. If liquidity scope is the
missing detail, the owner can preview **selected pool** or **all pools**, then
explicitly apply that choice to the draft. Original and interpreted wording
are retained through approval, edits and restarts. Other unsupported wording
stays unresolved. Controls reject another user and an outdated draft revision.

Mapping, approval and scan activation remain separate. The saved market cap,
liquidity, volume and age thresholds are unchanged. The upgrade does not select
a scope, approve a draft, start scanning or substitute weaker conditions.
All-pools protection and general bundle coverage still cannot return a pass.

Live status: synthetic owner/revision/persistence tests pass; the new scope
buttons still need Telegram acceptance on the owner's existing saved draft.

## 3. Bounded chain evidence

Mint history can enumerate up to three pages (60 signatures). It reads at most
20 mint transaction bodies within the existing 40-body creator/wallet/pool
budget, reserving capacity for other checks. A recent verified launch locator
still avoids this search. Repeated/forward cursors, page limits, pruned history,
missing bodies and interruptions remain visible. An empty page is not proof
of complete historical coverage.

Transaction spacing is 1.1 seconds per RPC client. HTTP-200 JSON-RPC throttling
now activates the same backoff as HTTP 429. The 45-second risk deadline remains;
large samples may not finish. No paid RPC fallback is used.

### Liquidity coverage

The new reader supports the pinned **Raydium CPMM classic-SPL** layout, alongside
the existing Raydium AMM v4 and supported PumpSwap layouts. It checks program
ownership, exact binary layout, LP/vault seed identities, authorities, trading
availability, token permissions, fee-adjusted vault balances and exact supply.
Lock custody is reread together with the pool. Tests cover actual burn proof,
zero supply without proof, full/partial custody, exact six-month boundaries,
future trading start, stale snapshots and changed links.

Source: [Raydium CP swap, pinned revision](https://github.com/raydium-io/raydium-cp-swap/tree/f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5/programs/cp-swap/src),
particularly `states/pool.rs` and `instructions/initialize.rs`.
These are source-shaped synthetic fixtures, not captured mainnet proofs.
CPMM Token-2022 variants, CLMM, Meteora positions and unrecognized layouts remain
unknown. Pool accounting minus mint supply is never treated as a burn.

For the owner's PumpSwap example, the reader now reports the specific
**nonzero virtual quote reserves** limitation. It does not label that pool
unlocked. Supporting CPMM does not resolve this different pool format.

Live status: the [October 25 risk observation](evidence/risk-observation-2026-10-25.json)
read 20 mint and 19 pool transaction bodies with matching successful signatures
and slots. It enumerated 60 mint signatures but did not find a supported creation.
Liquidity, creator holdings and general bundle coverage all remained unknown.
This is a public-RPC response check, not independent verification of every trade.
Positive mainnet CPMM burn/lock, creator-sale and bundle proofs remain unverified.

## 4. Outcome timing and recorded-call replay

Paper-only tracking fetches at due horizons instead of once per minute between
them. Missed windows are recorded without a backfill request. A fetch from
before a horizon cannot become that horizon's price after a slow risk check;
freshness is checked again when follow-up requests finish. Failed pool requests
are shared within a cycle. Tests cover these timing and outage cases.

Read-only replay exports frozen call snapshots, rules and cost assumptions,
including failed/uncertain delivery attempts, losses and missing observations:

```sh
npm run replay:calls -- .sift YOUR_NUMERIC_TELEGRAM_ID
```

The output is private. Keep it out of public GitHub issues and repositories.
It contains at most 100 calls per page; if `page.hasMore` is true, pass
`page.nextAfter` as the third argument for the next page. Replay makes no network
request, sends no Telegram message and changes no database record. It recomputes
paper returns from saved prices with the costs frozen at call time. It is not
a historical discovery backtest, executable-price guarantee or actual trader P&L.
Unrecorded, unavailable and missed prices never become zero returns.

Live status: offline coverage only for the new replay/timing paths. There are no
invented profitable calls or tester results in this milestone.

## 5. Local runtime and recovery

`SIFT_FREE_ONLY=true` is the default. Startup and preflight reject enabled paid
AI while that guard is on. Keep `SIFT_AI_ENABLED=false`. Free public APIs can
still rate-limit or deny requests; compute/storage allowances are separate.

Linux `flock` prevents two local processes from using the same canonical data
directory. The lock releases after process death. It does not coordinate
different hosts or separate copies of a database. Telegram identity/webhook
checks and polling-conflict handling remain in place.

`SIFT_DATA_DIR` defaults to `.sift`. Changing it to an empty directory creates
an empty store; use the existing directory to preserve rules and history.
`preflight` performs a read-only database integrity check when the database exists.

### Storage recovery

From the [existing Codespace](https://effective-carnival-wr5j9v5g9775c95q9.github.dev/),
these commands require no bot token and send no messages:

```sh
npm run storage -- inspect .sift
npm run storage -- backup .sift sift-private-backup.sqlite
npm run storage -- restore sift-private-backup.sqlite .sift-restored
```

Choose new backup and restore names each time: existing destinations are never
overwritten. The online SQLite backup includes committed WAL data, validates
integrity and writes a private file. Restore creates a new directory, leaving
the old one untouched. The backup contains private user records and is not
encrypted; keep it private. SQLite files are ignored by Git.

**Restore preserves active scan and monitor states.** Stop the old polling
process before starting with `SIFT_DATA_DIR=.sift-restored`. Never run both
copies. Crash recovery, contention, WAL backup, restore and non-overwrite
behavior are covered by local process/database tests.

## Live evidence ledger

| Recorded check | Observed result | What it does not establish |
| --- | --- | --- |
| [Feeds, October 23](evidence/feed-observation-2026-10-23.json) | One PumpPortal creation event received; GeckoTerminal and both Meteora feeds responded | Complete launch coverage or a qualifying match |
| [Source comparison, October 23](evidence/source-audit-2026-10-23.json) | Same-pool identities agreed in the DLMM sample; a large market-cap disagreement and an unindexed DAMM v2 pool were recorded | Uniform provider accuracy or token safety |
| [Risk before update, October 23](evidence/risk-observation-before-2026-10-23.json) | Bounded sample interrupted; required checks unknown | Complete creator history |
| [Risk after update, October 25](evidence/risk-observation-2026-10-25.json) | More transaction bodies read within the budget; required checks still unknown | A full-policy match, supported virtual-reserve protection or bundle absence |
| [Sizing/holders, October 24](evidence/sizing-holders-2026-10-24.json) | No validated two-way quote; holders rate-limited | A verified executable quote or complete ownership data |

No Telegram credentials are present in this development workspace. Diagnostics
made public read-only requests and did not send alerts, alter saved criteria,
invite testers or deploy hosting. The [private test plan](private-testing.md)
still governs the later owner/tester acceptance work.

## Remaining completion gates

- Preserve the owner's scope choice and verify the new controls in Telegram.
- Extend evidence for unsupported pool modes/lockers/positions and creation or
  trading formats only when their source contracts can be verified.
- Establish complete all-pool inventory/protection and general bundle coverage
  before calling those required checks passed. Neither is currently established.
- Independently reconcile positive live risk examples and a genuine matching
  alert, then test group delivery, restarts and sustained private operation.
- Run the planned tester week and record successful, failed and no-trade
  outcomes. No performance or rug-avoidance claim follows from offline tests.

The implemented milestones improve the bot without weakening its requirements.
They do not make an unverifiable full risk policy operational by themselves.
