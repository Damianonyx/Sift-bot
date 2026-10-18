# Describe, scout and share

Sift's intended flow is to understand your criteria, find matching Solana coins,
and send their contract addresses with reasons, evidence and warnings. Matching
screening rules does not establish that a coin is safe or will be profitable.

Candidate sources now include Pump.fun launches and migrations through PumpPortal,
alongside GeckoTerminal new pools. See [Pump.fun discovery](pumpfun-discovery.md)
for source settings, indexing delays, queue limits and verification status.

## Start with a description

Send this privately as a format example, using your own thresholds:

```text
/describe Find Solana coins with market cap between $30k and $50k; liquidity at least $20k; warn 1h volume at least $40k; pool age at most 20 minutes
```

The local parser supports semicolon-separated clauses for a market-cap range,
minimum liquidity, minimum one-hour volume and maximum pool age in minutes.
`require` is the default; `warn` or `flag` makes a condition advisory. It accepts
USD amounts with `$`, grouped commas and `k`/`m` suffixes. Unsupported wording is
kept unresolved. These examples do not set a strategy for every user.

1. Compare the displayed original description with every proposed rule.
2. Select **Use interpreted draft** only if that interpretation is what you mean.
   This accepts the displayed interpretation; it does not approve or start a scan.
3. Send `/agent`, review the saved draft and select **Approve rules**. Unresolved
   requirements block this step. The original description remains available.
4. Send `/scan`, review coverage and select **Start discovery**.
5. Sift checks the bounded candidate feed while its process runs. It sends new
   matches with their CAs, selected pool, metrics, reasons and source timestamps.
   `/pause` and `/stop` halt discovery; `/alerts` shows saved reports.

Existing drafts are not overwritten by `/describe`; use `/agent` or explicitly
discard the draft with `/cancel`. `/setup` still provides the guided wizard.
Approving changed rules pauses the old scan and connected group destinations.

## Risk requirements stay visible

The description interpreter extracts market rules only. Mentions of locks,
developer holdings, suspicious activity, bundles or similar risk requirements
remain unresolved. AI does not verify those facts, invent evidence or choose CAs.

`/riskrules` offers an explicit replacement policy for extra instructions. Read
that replacement carefully: it covers one selected pool and limited evidence.
It is not an automatic translation of every possible request. The complete
policy currently cannot produce matching alerts because general bundle coverage
remains unknown. `/bundle` verifies a supplied Jito ID; it cannot discover every
bundle or prove absence. Do not remove a required check merely to obtain alerts.

## Enable a group destination

An allowlisted tester who is a group admin configures Sift privately. The group
uses that admin's approved strategy and active private scan.

1. Finish the private criteria review. Clear any unfinished draft first.
2. Add `@SiftAgentbot` to the group and make it an administrator. Admin status
   lets Sift reliably verify other admins through Telegram's `getChatMember`.
3. In that group, send `/group@SiftAgentbot connect` from your own account.
   Anonymous admin/channel identities cannot control Sift.
4. Open Sift privately and send `/groups`. Select **Review** for the group ID.
5. Review the destination and disclosure: the group will see matching CAs, your
   agent name, approved rules, reasons, warnings and evidence links. Select
   **Enable group alerts** within ten minutes of connecting.
6. Keep the private scan active. Only future qualifying matches are sent to the
   group. Previous private alerts, drafts and monitoring history are not copied.

Any verified group admin can send `/group@SiftAgentbot stop`, even if that admin
is not a private tester. The controller can also stop a destination privately in
`/groups`. Another tester cannot take over a connection until it has been stopped.

Sift rechecks the controller's tester access and both admin memberships before
each group send. Loss of access or unavailable verification pauses sharing.
Changed approved rules require reconnecting and reviewing again. A group upgrade
that changes its chat ID requires a new connection. Forum topics are not separate
destinations in this version; messages use the group's default chat.

Limits: three connected destinations per tester, three posting attempts per
destination per scan cycle, and one attempt per group/rule set/token. Uncertain
delivery is recorded and never blindly retried, including after restart. `/groups`
shows pending/failed/uncertain delivery counts. This may miss a report; it does not
guarantee exactly-once delivery. Private monitor controls are not included in
group messages. Enabling a group does not change any required risk checks.

## Optional AI interpretation

The default `SIFT_AI_ENABLED=false` uses local parsing and makes no OpenAI calls.
The AI adapter is implemented and tested with mocked Responses API outputs;
no live model call has been validated or purchased in this build.

To enable it later, explicitly configure these as secrets/environment settings:

```dotenv
SIFT_AI_ENABLED=true
OPENAI_API_KEY=
SIFT_AI_MODEL=
```

Choose a model supporting structured outputs on the Responses API. This requires
separately billed OpenAI API access; ChatGPT/Codex credits are not API credit.
Do not place a real key in the repository or a Telegram message.

Only an unresolved private `/describe` or `/setup <description>` request can call
the model. It receives the submitted description and extraction instructions,
not Telegram credentials, user IDs, wallet keys or group history. `store:false`
is set on the request; provider data policies still apply. The model has no tools
and cannot approve rules, start scanning, post messages or execute trades.

Requests have a 15-second timeout, a 1,200-output-token ceiling, a 64 KiB response
limit and a process-wide 30-second cooldown. SQLite enforces at most 20 requests
per UTC day across all testers, reserving each Telegram update before sending.
Retries/restarts do not issue a second model request for the same update. This is
a request cap, not a dollar budget; configure provider project limits separately.

Missing configuration, refusal, malformed/incomplete output, invented numbers,
unsupported measurements and API failures preserve unresolved instructions.
The user must still compare the original request with the proposed rules. This
review is required even for a schema-valid AI result.

## Hosting later

Cloudflare is a hosting option. This build still runs as one Node.js 24 polling
process with local SQLite. Deploying it to Workers requires a webhook handler,
durable state, scheduled discovery and concurrency/delivery handling. A website
deployment alone does not run this polling process. No deployment or paid plan
has been configured here.

References: [Telegram admin verification](https://core.telegram.org/bots/api#getchatmember),
[OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
