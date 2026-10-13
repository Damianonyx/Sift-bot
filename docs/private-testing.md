# Private testing before public access

The owner requested a working bot, then more private testers for one week before
considering public access. The week has not started, nobody has been invited by
this change, and passing a week does not automatically publish the bot.

## What this branch makes testable

Saved and approved market rules, bounded discovery, manual checks, and fixed-pool
market monitoring have synthetic automated coverage. Telegram welcome/check
replies and candidate-feed access were previously observed in owner screenshots.
A real qualifying discovery alert and the new live monitoring path are pending.

Natural-language AI, verified liquidity protection, developer attribution and
sales/transfer classification, and coordinated-buy/bundle investigation are not
connected. The owner's full strategy remains blocked. Do not discard or weaken
that draft to manufacture an alert. A separate market-only test, if deliberately
chosen by a tester, must be reviewed for that limited scope and is not evidence
that the full strategy works.

## Owner acceptance before invitations

1. Stop the previous polling process. Run exactly one process for @SiftAgentbot.
2. In the existing Codespace, keep its `.sift/` directory and configured secrets.
   Do not delete the Codespace or database. Switch to the tested branch:

   ```sh
   git fetch origin &&
   git switch codex/market-monitoring &&
   npm test &&
   npm start
   ```

3. Send `/status`, `/agent` and `/scan`. Verify saved thresholds and unresolved
   instructions are intact. The full unsupported strategy must remain blocked.
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

The current version is incomplete for the owner's full screening requirements.
Broader testing of those claims waits for the missing evidence integrations.

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
| 2 | Discovery relevance, CA identity, evidence and missed-source coverage |
| 3 | Monitor baseline/pool, real threshold checks and expiry controls |
| 4 | Restart persistence, pause/stop, interruption and recovery behavior |
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
