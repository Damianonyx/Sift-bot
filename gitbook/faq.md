---
description: Practical answers about Sift's private test, controls, unknown data and planned features.
---

# Frequently asked questions

## Is Sift available to everyone?

Not yet. The Telegram bot is in private testing with approved users. Opening [@SiftAgentbot](https://t.me/SiftAgentbot) does not automatically grant access. Public availability is undecided.

## Do I need to connect a wallet?

No. Sift does not connect to your wallet, hold funds, request private keys or execute trades. Never send wallet secrets to the bot or a supposed support account.

## Does a Sift match mean a coin is safe?

No. It means available data satisfied the approved supported screening rules at the reported check time. It does not establish safety, verify every possible concern or predict profit. Read the concerns, unknown checks and source links before making your own decision.

## Can I describe my strategy in ordinary language?

That is the intended experience. Today, guided setup handles four supported numeric conditions. A description sent with `/setup <description>` is saved as unresolved and blocks approval; AI interpretation is not connected yet.

## Why can’t I approve my draft?

It may contain unresolved instructions or unsupported checks, or lack a required condition. Use `/agent` to review it. A liquidity, developer or bundle requirement cannot be ignored just to activate part of the strategy.

## Does “liquidity unknown” mean the pool is unlocked?

No. It means the current evidence does not establish the requested protection. `/liquidity` can read certain pool accounts, but it cannot yet verify timed locks, six months remaining or full protection across pools.

## Will Sift alert me when the developer sells?

That is planned. Developer attribution, holdings and sale monitoring are not connected. Sift should distinguish verified sales from transfers and uncertain activity once supported evidence is available.

## Can Sift detect bundles?

Reliable bundle and coordinated-buying analysis is not implemented. These checks remain unknown or unsupported. Future reports should distinguish suspicions from confirmed evidence instead of treating wallet connections as proof.

## Why am I not receiving discovery alerts?

Possible reasons include an offline bot process, an unapproved or unresolved draft, a scan that is stopped or paused, no qualifying candidates within limited coverage, source errors, muted tokens, delivery problems or alert limits. Use `/scan`, `/status` and `/alerts` where available. No alerts does not establish that no qualifying tokens exist elsewhere.

## Does the bot run when Codespaces is stopped?

The current test process must be running to receive messages and scan. Stopping the Codespace or bot process stops that work. Continuous hosting is not configured. Keeping a browser tab open is not a guarantee that the underlying process remains running.

## Are my settings saved?

The implementation saves criteria, scan state, mutes and alerts separately for each user in the bot's local database. Keeping the same database allows recovery across restarts. Storage loss or deleting the environment can remove that state; managed backups and account recovery are not established product features.

## What do pause, stop and cancel mean?

`/pause` pauses discovery; `/resume` can restart an eligible paused scan. `/stop` ends scanning while keeping rules and history. `/cancel` discards a setup draft and keeps previously approved rules; it does not stop an active scan. A message already being sent can still arrive after pause or stop.

## How much will Sift cost?

No public subscription or pricing plan has launched. Free private validation is the current direction; public pricing remains undecided. Bot hosting, data access and any future AI API usage have separate operating costs, so a ChatGPT subscription or development credits should not be assumed to cover them.

## Does the website control my agent?

No. The current website is a local landing-page draft with an illustrative walkthrough. Accounts and an agent dashboard are planned. Website examples are not real scans or alerts.

## Where should I report a problem?

Use the private-test contact channel already agreed with the project owner. Include the command, approximate time and a description of the issue. Remove credentials and personal details from screenshots. No public support channel or response-time commitment has been established.
