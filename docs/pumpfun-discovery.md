# Pump.fun discovery

Sift can scout Pump.fun launches and PumpSwap migrations using the third-party
PumpPortal event feed, alongside GeckoTerminal's first page of new Solana pools.
Events identify candidates. The existing DEX Screener adapter supplies market
metrics, and separate on-chain readers supply supported risk evidence.

This does not complete the full risk strategy: general bundle coverage remains
unknown. An unindexed launch cannot pass required market checks with missing data.
Pump.fun virtual reserves are never substituted for USD liquidity, and an event's
creator or completion fields are never treated as verified holdings or protection.

## Configuration and cost

Node.js 24 provides the WebSocket client; no new package is needed.
`SIFT_PUMPFUN_ENABLED=true` is the default. Set it to `false` to retain only
GeckoTerminal candidates. Invalid values stop startup/preflight.

The connection is fixed to `wss://pumpportal.fun/api/data`, with exactly two
subscriptions: `subscribeNewToken` and `subscribeMigration`. It sends no API key,
wallet, user description, Telegram ID or scan settings. No trades are executed.

PumpPortal's [data documentation](https://pumpportal.fun/data-api/real-time/) and
[fee page](https://pumpportal.fun/fees/), reviewed on October 17, 2026, identify
those two subscriptions as free. Trade/account subscriptions are separately
metered; this adapter does not implement or enable them. No funded wallet or
paid fallback is configured. Existing hosting and optional AI costs are separate.

## When it connects

- An allowed user's active scan, with matching approved supported rules, keeps
  one shared connection open. No connection is made just by starting an idle bot.
- `/sources` can open the connection for a 30-second diagnostic lease. It does
  not approve rules, activate a scan, change thresholds or send candidate alerts.
- If all scans stop, pause or lose access, the runtime closes the stream within
  about one second, except for any remaining diagnostic lease.
- `/status` is passive. It shows whether the stream is idle, connecting, waiting
  for events, receiving events or unavailable. Opening a socket or receiving a
  subscription acknowledgement alone does not count as event delivery.

## Candidate handling and limits

The queue holds up to 200 distinct mints for 20 minutes after receipt. Pending
candidates rotate when the scanner attempts them, allowing another market check
after indexing catches up. A first migration refreshes a queued launch once;
duplicate events do not reset its position or retention time.

The scanner interleaves the PumpPortal queue and GeckoTerminal candidates before
applying a shared limit of 20 distinct mints per cycle. Overlapping mints are
checked once with both sources recorded. Existing private/group delivery limits,
ownership checks, rule approval and persistent alert deduplication still apply.
Source diagnostics do not advance the candidate rotation.

At capacity, new events are dropped and the count is visible in `/sources`.
Retention expiry, malformed events and connection interruptions are also shown.
The queue is memory-only and clears when the connection closes. There is no
historical backfill after downtime or restart, and high launch volume can exceed
coverage. Queue retention is a resource limit, not a user screening condition.

Transport failures discard the live batch and reconnect with bounded backoff.
Connections that do not open within ten seconds, or deliver no valid candidate
events for 90 seconds, are closed and retried. Unknown event formats cannot be
used as candidates. If one source fails, the other may continue with visible
partial coverage. Two unavailable sources cannot become a successful empty scan.

## What an alert establishes

An alert includes the CA, market retrieval time, approved-rule results and the
candidate source. PumpPortal candidates include the reported transaction link
and the time Sift received the event. Receipt time is not token age or proof of
on-chain finality. A migration event does not establish LP protection; the normal
evidence checks still have to verify any required protection independently.

This integration does not add historical trade reconstruction, bonding-curve
USD pricing, creator-wallet monitoring or comprehensive bundle detection.
Those require separate supported data and evidence adapters. No user requirement
is silently removed to make a Pump.fun candidate qualify.

## Verification status

Automated checks use synthetic events and mocked transport. They cover feed
lifecycle, reconnection, queue bounds, deduplication, partial outages, permissions,
source attribution, missing-index retries and delivery through the existing
scanner. No live Telegram message or paid API request was made for this change.

The live WebSocket access check from the build environment did not complete before
cancellation. Runtime connectivity and current event payload compatibility still
need verification. This is a code integration, not a claim that the deployed bot
is already connected. Private tester invitations and the test week remain deferred.
