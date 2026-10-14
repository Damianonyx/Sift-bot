# Private testing before public access

The owner requested a working bot, then more private testers for one week before
considering public access. The week has not started, nobody has been invited by
this change, and passing a week does not automatically publish the bot.

## What this branch makes testable

Saved and approved market rules, bounded discovery, manual checks, and fixed-pool
market monitoring have synthetic automated coverage. Telegram welcome/check
replies and candidate-feed access were previously observed in owner screenshots.
A real qualifying discovery alert and the new live monitoring path are pending.

Risk evidence now has offline coverage for exact LP burns/locks, signing-creator
holdings, direct sales/transfers, atomic coordinated buys and supplied Jito bundle
IDs. Read [the precise coverage](risk-evidence.md). General bundle coverage is
still unknown; the full strategy cannot yet qualify coins. AI interpretation
and continuous wallet/lock event monitoring remain unavailable. Do not weaken
required checks to manufacture an alert.

## Owner acceptance before invitations

1. Stop the previous polling process. Run exactly one process for @SiftAgentbot.
2. In the existing Codespace, keep its `.sift/` directory and configured secrets.
   Do not delete the Codespace or database. Switch to the tested branch:

   ```sh
   git fetch origin &&
   git switch codex/risk-verification &&
   npm test &&
   npm run preflight &&
   npm start
   ```

3. Send `/status`, `/agent` and `/scan`. Verify saved thresholds and unresolved
   instructions are intact. Old extra instructions must be retained. /riskrules can explicitly replace them
   with the displayed policy, followed by separate approval. Unknown required
   risk results must still prevent qualification.
4. Send `/watch`, then submit a chosen CA, drop percentage and duration using
   the displayed format. Review scope before starting. Check the reported fixed
   pool, baseline, source link and exact UTC end time against the source.
5. Use `/watchlist` to pause/resume, extend and stop a monitor. Stop/restart the
   bot with the same database and confirm the pool, original baseline and end
   time are unchanged. Look for an interruption notice if checks were delayed.
6. Observe a real threshold crossing if one occurs; compare both readings and
   retrieval times with the provider. Do not treat a mock response as live
   evidence or change thresholds just to manufacture a successful alert.
7. Validate discovery using a tester's explicitly approved supported rules;
   reconcile the CA, source pool, selected pool, metrics and reasons. No match
   during observation is a valid result, not a reason to silently relax rules.
8. Test an unlisted account and a group. They must not fetch token data, read
   private rules or operate another user's controls. `/id` remains available
   privately so invited testers can obtain their own IDs.

9. Run `/liquidity <CA>` and `/risk <CA>` against independently known examples:
   verified burn; full long-duration lock; one-second-short/partial/cancelable
   lock; creator with holdings; partial sale; zero holdings; ordinary transfer;
   atomic buys; same-slot suspicion; missing transaction and unsupported pool.
   Reconcile exact mint, pool, slot, amount, unlock time and transaction links.
10. Use `/bundle <CA> <known Jito bundle ID>` for a recent independently known
    bundle. Confirm finalized matching buys exclude it; expired/not-found statuses
    remain unknown. This does not test exhaustive bundle coverage.
11. Record source denial/rate limits, stale data and cooldown outcomes. Every
    required unknown must be visible and must suppress matching alerts. Confirm
    reports fit mobile and do not claim “never sold” or “bundle-free”.

Live evidence has not been validated here. This private build can test the
implemented decisions and unknown behavior, but the full strategy/public release
remain blocked by missing general bundle coverage and outstanding acceptance.

## Add invited testers after owner acceptance

The private allowlist already exists. Each invited person opens the bot privately
and sends `/id`, then gives their numeric ID to the owner through a private channel.
Do not put their IDs, bot token, user messages or database in a public issue,
repository or README. Do not request wallet secrets or trading-wallet access.

The owner adds the IDs to the existing `SIFT_ALLOWED_USER_IDS` Codespaces secret,
comma-separated, retaining their own ID. Keep repository access scoped to
Sift-bot. Stop and reopen the Codespace after changing secrets, then start one
bot process. Each tester uses `/start` and `/status` before setting their rules.
Removing an ID and restarting revokes access and background requests for that
user; it does not delete saved data. There is no public-access toggle.

Adding testers grants bot access only; it does not grant GitHub or Codespace access.
No invitations or messages are sent automatically by this change.

## One-week test record

Record the agreed start/end date and the actual hours the bot is running.
Codespaces is temporary: closed/suspended runtime means missed checks. A week
of scheduled test sessions does not establish continuous monitoring reliability.
Choose durable hosting and confirm its cost/limits separately before promising
continuous access. No purchase or paid upgrade is authorised here.

| Day | Focus |
| --- | --- |
| 1 | Access, mobile setup, explicit rule approval and scope comprehension |
| 2 | LP burn/lock evidence, exact 100% coverage and six-month boundary |
| 3 | Creator holdings, partial sales, transfers, coordination and bundle examples |
| 4 | Discovery/market monitor evidence, restart, pause/stop and recovery |
| 5 | Multiple testers, source limits, delayed/suppressed/duplicate reports |
| 6 | Repeat normal use and reproduce reported failures |
| 7 | Review all outcomes and decide what must be fixed before any public test |

Keep a private record per report or issue: time observed, feature, CA, report ID,
approved rule, expected result, actual result, source evidence, delivery delay,
duplicate/missed/unavailable status and tester feedback. Preserve irrelevant
alerts, failed/uncertain deliveries and unsuccessful outcomes too. Relevance and
accuracy must not be judged only by tokens whose prices later rise.

Private bot histories are `/alerts` and `/watchalerts`; each displays its latest
five reports, while older records remain in the local database. Back up that
database privately with the bot stopped, including any SQLite WAL/SHM sidecars,
before changing or deleting the runtime. GitHub does not back up this data.

## Public-release review remains separate

Before public access, review the real acceptance evidence, unresolved promised
features, data coverage/freshness, access isolation, missed/duplicate delivery,
capacity limits, retention/deletion behavior, uptime and operating costs. Any
remaining limitation must be accurately represented in the bot and public copy.
The user makes the public-release decision; this branch neither removes private
access restrictions nor deploys hosting.

