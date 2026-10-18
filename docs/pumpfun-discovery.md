# Pump.fun discovery

Sift can scout Pump.fun launches and PumpSwap migrations using the third-party
PumpPortal event feed, alongside GeckoTerminal's first page of new Solana pools
and direct Meteora DLMM/DAMM v2 feeds. See [source verification](source-verification.md)
for the Meteora coverage and recorded cross-provider disagreements.
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

The scanner interleaves the PumpPortal queue, GeckoTerminal and Meteora candidates before
applying a shared limit of 20 distinct mints per cycle. Overlapping mints are
checked once with the observed sources recorded. Existing private/group delivery limits,
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
partial coverage. If all enabled sources are unavailable, that cannot become a successful empty scan.
Raw status includes message and control-message counts, separately from valid
candidate delivery. Control messages do not prove that either subscription works;
provider message text is not stored in status or diagnostics.

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

### Run the live check in Codespaces

Stop any other Sift process first, keeping one PumpPortal connection at a time.
On Node.js 24, from the repository terminal, run:

```sh
npm run check:live
```

The command observes up to two distinct launch/migration candidates for up to
30 seconds, reads the GeckoTerminal feed and checks at most three distinct mints
with DEX Screener.
It prints stage progress and a JSON result. It requests cancellation at 45 seconds
and forcibly exits by 55 seconds if a transport fails to stop. It uses the existing
proxy environment when present, without disabling TLS verification.

This default command needs no Telegram token, calls no AI service, writes no
database, changes no criteria and sends no messages. It cannot prove a strategy
has a qualifying match. `pumpToMarketVerified: true` only means an observed
PumpPortal mint produced a fresh DEX Screener response containing a supported
pool. Required metrics can still be missing and provider update time is unknown.
An empty market response is reported as `not_indexed`, not a rejected or safe coin.

After the source check, an explicitly requested private delivery diagnostic is:

```sh
npm run check:live -- --telegram YOUR_NUMERIC_USER_ID
```

Replace the placeholder with your own numeric Telegram user ID. The existing
`TELEGRAM_BOT_TOKEN` secret and `SIFT_ALLOWED_USER_IDS` must already be configured
in that Codespace. The recipient must be in the allowlist; negative group IDs
are rejected. No token belongs in the command, Git or chat.

The command verifies @SiftAgentbot's identity and attempts one message clearly
labelled as a connection diagnostic, containing the observed CAs and market
response states. It does not poll updates, start scanning, contact group members
or evaluate/approve rules. `accepted_by_telegram` means Telegram accepted a private
message; check your chat to confirm receipt. Ambiguous sends are not retried in
the same run; rerunning an explicitly requested delivery check is a new attempt.

Exit code 0 confirms the observed PumpPortal-to-market path and, if requested,
Telegram API acceptance. Exit code 2 means incomplete coverage or delivery; exit
code 1 means configuration/runtime failure or the hard deadline. None of these
results establish a qualifying full-risk match or complete group delivery.

The separate **Public discovery diagnostic** GitHub Actions workflow runs the
same read-only command. It is manual-only after the initial development runs;
GitHub requires the workflow to exist on the default branch before manual dispatch.
The CLI can be run directly from the development branch in the meantime.
It uses no repository secrets and cannot send Telegram messages. An incomplete
observation makes that workflow fail; the offline test workflow remains separate.
There is no scheduled polling or continuous bot deployment in this workflow.

### Current evidence

Automated checks use synthetic events and mocked transport. They cover feed
lifecycle, reconnection, queue bounds, deduplication, partial outages, permissions,
source attribution, missing-index retries and delivery through the existing
scanner. No live Telegram message or paid API request was made for this change.

The first [public runner observation](https://github.com/Damianonyx/Sift-bot/actions/runs/39112973428)
on October 18, 2026 opened the PumpPortal socket but received no valid candidates
within 12 seconds. GeckoTerminal returned 18 candidates; the sampled mint had no
supported DEX Screener pool. The diagnostic correctly exited with code 2
(incomplete). The observation window is now 30 seconds, with message counters to
distinguish a quiet socket from rejected candidate data.

The [30-second observation](https://github.com/Damianonyx/Sift-bot/actions/runs/39113161925)
at 08:53 UTC received two valid PumpPortal candidates, two control messages and
zero rejected events. Both candidates initially returned no supported DEX
Screener pool. The [follow-up observation](https://github.com/Damianonyx/Sift-bot/actions/runs/39113310499)
at 08:55 UTC used the same market adapter to recheck those exact two mints:

| Observed PumpPortal mint | Initial market response | Follow-up market response |
| --- | --- | --- |
| `7QVsxWd2RaWxqhQGAswYrDR6A92jWwvqF36krRWJbxNN` | No supported pool | One supported pool; market cap $2,879.12; liquidity unknown |
| `BdBLNzhczGB9FRcrBencDc35HFXBG8RBiZDz7VApump` | No supported pool | One supported pool; market cap $2,884.35; liquidity unknown |

These are historical connectivity observations, not recommendations or current
quotes. They verify that observed event mints can reach the market adapter after
indexing; they do not establish complete metrics, on-chain truth or rule matches.
The follow-up also observed two further PumpPortal candidates and an indexed
GeckoTerminal candidate. Its fresh-launch check still exited 2 because its newly
observed PumpPortal candidates were not indexed within that short run.

The scanner already retains queued candidates for up to 20 minutes and rotates
them for later checks. Missing required liquidity must still block qualification
after indexing. The temporary fixed-mint probe was removed after recording these
results; no automatic repeated public checks or paid services were enabled.

The owner confirmed private Telegram delivery from the configured Codespace on
October 18, 2026 by sharing the received **Sift · Connection check** message. That
run received PumpPortal candidates and a GeckoTerminal response; all three sampled
mints were still unindexed. This confirms private diagnostic delivery, not a
qualifying match. This build environment still has no Telegram credentials.

A complete qualifying scan and live group delivery remain unverified. General
bundle coverage remains unknown. Private tester invitations and the test week
remain deferred.

### Copying a CA

New token reports format the CA as its own monospace span and include a **Copy CA**
button. The button uses Telegram's native
[clipboard action](https://core.telegram.org/bots/api#copytextbutton) to copy only
the full mint address, without the label or surrounding report. Messages containing
several coins have numbered buttons with abbreviated addresses for identification;
the copied value is always the full address.

This applies to private and enabled group discovery alerts, manual token/evidence
checks, monitoring reports, saved report views and connection diagnostics. Existing
Monitor, Mute and Pause controls remain available. Previously delivered messages
are not edited; reopen a saved report or request a new check after updating Sift.
