# Discovery intelligence and the competitor opportunities

This implements the product opportunities identified in the competitor review,
including the individual comparison points, not only the eight workflow items.
It does not assert that competitors lack these features today. Competitor docs
were a design input, not an independent product benchmark.

## What this build adds

| Opportunity | Implementation | Boundary |
| --- | --- | --- |
| Exact personal criteria | Local description parsing, required/warning policies, explicit review, original wording retained | Unrecognized requirements remain unresolved; no invented thresholds |
| Verifiable protection scope | Separate selected-pool and all-pools policies; exact 100% and six calendar months remaining; `/poolcoverage` lists indexed pools | Complete all-pool coverage is unavailable; an all-pools requirement cannot pass |
| Evidence over a security score | Short match cards and paginated, saved **View evidence** reports | Reports distinguish market observations, verified transactions, suspicions and missing coverage; no universal safety score |
| Data freshness and provenance | API retrieval times, unknown provider timestamps, bounded transaction counts, fresh chain checks, persisted creation-signature locators | Saved locators are reverified; holdings are never accepted from a historical cache |
| Promotion transparency | DEX Screener active boost disclosure | Boosts do not improve criteria ranking. Missing boost data or zero boosts cannot rule out other promotion |
| Timely free-source discovery | Existing anonymous feeds and public RPC; no paid priority queue or intentional free-tier delay | Real source limits, a 20-candidate cycle cap and interruptions still apply |
| Ongoing thesis checks | Optional after-call rule re-evaluation, liquidity deterioration, supported creator balance/activity, lock expiry observations and top-account share changes | Fixed pool, bounded samples, no complete wallet history; missing evidence is reported as unknown |
| Position-size awareness | `/size CA AMOUNT` requests read-only entry and exit quotes through Raydium routes | No wallet or trade. Unsupported/malformed/missing routes remain unknown; independent quotes do not simulate an executed round trip |
| Group strategy controls | Independent saved strategies, review before enabling, posting cadence, deduplication, pause/stop, admin rechecks and configuration audit | Three groups per owner; up to three messages per cycle; future matches only |
| Honest performance | Immutable call snapshots, all delivery attempts, fixed-horizon results, missed/unavailable outcomes, sampled drawdown | Paper results are not actual fills; old calls have no fabricated baselines |
| Tester feedback | Per-call rating and self-reported profit/loss/no-trade/suspected rug | Unverified reports never become confirmed rug or profitability findings |
| Private settings and ownership | Private preferences, evidence authorization, per-owner history, public group evidence contains only already-approved shared rules | Database is local and not encrypted; group messages are visible to the group |

## Use the new commands

- `/preferences` shows current settings and exact formats.
- `/preferences follow 24` enables private follow-up notifications for **future**
  calls for 24 hours. Default is off. No current scan or screening rule changes.
- `/preferences follow 0` stops existing and future follow-up notifications.
- `/followstop ID` stops notifications for one call.
- `/preferences quiet 22 7` suppresses discovery/follow-up notifications from
  22:00 inclusive to 07:00 exclusive **UTC**; `/preferences quiet off` removes it.
  Explicit `/watch` monitors have their own controls and are not silenced here.
- `/preferences position 100` saves a 100 USDC sizing amount. `/size CA` then uses
  it; `/size CA 250` checks a different amount without changing the preference.
- `/preferences paper 30 100` sets future paper assumptions to 30 basis points
  of fee and 100 basis points of slippage **per leg**. Those are the initial
  illustrative defaults, not measured execution costs. Allowed values: 0–1000
  bps for each. Existing call assumptions never change retroactively.
- `/holders CA` samples up to 20 largest token accounts using finalized RPC.
  Pool vaults, lockers and exchange accounts are not excluded. Account share is
  not wallet concentration, insider ownership, or proof of common control.
- `/performance` shows aggregate outcomes and coverage; `/calls PAGE` lists all
  recorded calls in pages of ten; `/performance ID` shows one call and recent
  follow-up reports, including suppressed/failed attempts.
- `/feedback ID 1-5 OUTCOME` saves a tester self-report. Outcomes: `no_trade`,
  `profit`, `loss`, `suspected_rug`. Updating feedback does not edit market data.
- `/audit` shows the latest ten private rule/configuration changes. Earlier
  entries remain in SQLite.

Match alerts have **Copy CA** and **View evidence** controls. Evidence is the
original saved observation, not a fresh check. Private evidence buttons enforce
the owner and private chat. Group evidence buttons work only in their original
group and disclose the already-shared strategy and evidence, not private drafts,
preferences, feedback or history.

## Precise descriptions

Example syntax, **not a recommended trading strategy**:

```text
market cap between 20k and 60k; require 100% selected-pool liquidity protection with at least six months remaining or verified LP burns; the identified developer must still hold tokens; allow partial developer sales, but flag them; report transfers separately from sales; exclude confirmed coordinated buying or bundles; flag suspected cases
```

Use `all-pools` instead of `selected-pool` when that is your actual requirement.
Sift preserves it and returns UNKNOWN because complete pool coverage has not
been established. Do not substitute selected-pool scope merely to get matches.

Use `warn` instead of `require` only when you explicitly intend a warning-only
condition. Warning failures and unknowns remain visible. Unknown **required**
checks block a match. Six months means UTC calendar months, clamped to month-end.
The structured policy currently supports the requested 100%/six-month policy;
other percentages/durations are kept unresolved, not rounded or inferred.

`/mapextras` previews whether saved draft extras can be mapped exactly. Applying
that mapping edits the draft only; approval and scan activation remain separate.
Ambiguous scope stays unresolved. Existing drafts are never automatically
rewritten, narrowed, approved or activated by this upgrade.

## Independent groups

Connect and review a group through `/group@SiftAgentbot connect` and `/groups`
as before. For a different group strategy:

1. Prepare and approve the desired rules privately.
2. Send `/groupstrategy CHAT_ID` privately. This copies the approved rules into
   a separate group draft, without the private description or agent name.
3. Review the disclosure and press **Enable group alerts**.
4. Later private rule edits do not change the saved group strategy.

An enabled independent group scans even when the private scan is stopped.
`/groupconfig CHAT_ID MINUTES MAX_PER_CYCLE` sets 0–1440 minutes between posting
attempts and 1–3 alerts per cycle. This pauses posting for a fresh review.
`/grouppause CHAT_ID` pauses one destination; configure/review again to re-enable.
`/pause` and `/stop` also pause/stop all the owner's group destinations and disable
after-call notifications. `/resume` resumes private discovery only. Any verified
group admin can stop posting inside that group.

Cadence limits can cause candidates to be missed; there is no promise to replay
every suppressed match. Duplicate rules/token deliveries are not repeated after
reconnection or restart. Failed or ambiguous sends are retained and not blindly
retried. Group call outcomes remain visible to the controlling admin privately.

## Performance methodology

Every new private/group delivery attempt captures its token, pool, original
criteria, market snapshot, timestamp and paper costs before sending. Dismissing
a discovery alert never deletes or changes that performance record. Failed and
uncertain deliveries remain counted separately. Confirmed sends receive paper
observations at **15 minutes, 1 hour, 6 hours and 24 hours**, using the same pool.
The first attempt after each horizon must finish within five minutes. Otherwise
the horizon is marked missed; no later observation is backfilled as if it had
been available then. An unavailable price is not zero and not a zero return.

For valid entry/exit prices:

```text
gross return = exit_price / entry_price - 1
paper net return = (exit_price / entry_price)
                   × (1 - fee_bps/10000)² × (1 - slippage_bps/10000)² - 1
```

These assumptions exclude network/priority fees, failures, MEV, price impact and
execution delays. Quotes from `/size` are **not** silently substituted into this
price-series calculation. Drawdown is peak-to-trough across available samples,
not the full tick history. Provider update time is unknown. Mean returns and
paper win counts show observed horizons alongside missed/unavailable horizons;
they are not evidence that testers earned those returns. Counts describe calls
to destinations: the same token sent to two destinations is two delivery records.

After-call work checks at most four due records per cycle; limited risk/holder
work rotates across eligible records. Discovery gets priority over after-call
work. Source limits, larger cohorts and downtime can delay checks or miss fixed
horizons. Follow-up sampling does not promise complete event coverage. Newly
found creator transactions may predate the original call; the message says so.
Existing `/watch` remains a separate explicitly started market monitor.

## Integrations and unresolved requirements

The sizing adapter calls only the public Raydium compute quote endpoint:
`https://transaction-v1.raydium.io/compute/swap-base-in`. It never builds, signs or
submits a transaction and supplies no wallet, API key, referral or authorization.
Entry is USDC → token and exit is the quoted token amount → USDC. Each response
must match both mints, amounts and the connected route. USDC is assumed to be one
USD only for sizing. Route fees are reflected in quotes; network fees and future
execution are not. The quotes are independent current-state observations, not a
simulation of the entry changing pool reserves or a guarantee of future exit.

Reference: [Raydium Trade API source documentation](https://github.com/raydium-io/raydium-docs-v1/blob/main/sdk-api/trade-api.mdx).
The adapter has offline protocol-shaped tests. Live route availability could not
be checked from this build environment; failures return UNKNOWN. The new
end-to-end bot paths need runtime acceptance after updating Codespaces.

No paid service or hosting was activated. Optional AI remains disabled by
default; Bubblemaps remains deferred as requested. Complete bundle absence,
complete historical creator attribution, every locker/Meteora position layout,
all-pool protection and guaranteed rug detection are **not implemented** by
adding a report or connecting an AI API. These remain explicit data/verification
gaps. The owner's full required policy still cannot produce qualified alerts
until those requirements can be verified; this upgrade does not relax it.
