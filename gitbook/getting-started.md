---
description: Open the Telegram bot, understand private-test access and learn the available commands.
---

# Getting started

Sift currently supports private chats on Telegram and Solana token checks. Access is limited to approved testers. Opening the bot does not automatically grant tester access.

The commands below describe the latest development version. The running bot may use an earlier version or be offline. Check `/help` and `/status`, and see the [version and validation notes](status-and-roadmap.md).

## Open Sift

1. Open [@SiftAgentbot](https://t.me/SiftAgentbot).
2. Send `/start`.
3. If you have tester access, send `/help` and `/status` to see the available features.

If your account is not approved, `/id` can show your own Telegram user ID. Share that ID privately with the project owner when arranging tester access. Never send a bot token, seed phrase or private key.

The current private test runs while its development process is running. Closing or stopping that process stops replies and scanning. Continuous hosting has not been completed.

## Check a submitted token

Use `/check` followed by one full Solana token mint address:

```text
/check <CA>
```

Replace `<CA>` with the actual address, without angle brackets or a link. The report identifies the selected pool, available metrics, retrieval time, source links and unknown checks.

If you have approved screening rules, the bot also evaluates them against the snapshot. An unapproved draft is not applied. A manual check does not start automatic discovery.

For a separate, limited liquidity account report:

```text
/liquidity <CA>
```

This reads supported on-chain account structures. It does not yet verify a timed lock, a six-month remaining lock or full liquidity protection. See [Data and evidence](data-and-evidence.md).

## Set up an agent

Send `/setup` and follow the guided questions. You choose an agent name, the numeric conditions you want, and any additional instructions.

Review every condition before approving. Approval saves supported rules; it does not start a scan. An unresolved description or unsupported extra check blocks approval. The [screening rules guide](screening-rules.md) explains input formats and draft behavior.

## Start discovery when your rules are supported

1. Use `/sources` to check candidate-feed access. This does not activate anything.
2. Use `/scan` to review your approved rules, coverage and scan state.
3. If your configuration is eligible, choose **Start discovery**.
4. Use `/scan` or `/status` to inspect progress and service issues.

If an essential requirement is unsupported, keep it in the draft. Sift cannot claim to satisfy the full strategy by scanning only the easier checks.

The current implementation checks a limited feed roughly once a minute while running. Timing and delivery are not guaranteed. Live end-to-end discovery acceptance is still pending.

## Command reference

| Command | Purpose |
| --- | --- |
| `/start` | Welcome message for approved testers. |
| `/help` | Commands supported by the running version. |
| `/status` | Capabilities, saved criteria, source health and scan status. |
| `/id` | Your own Telegram user ID in a private chat. |
| `/check <CA>` | A manual Solana market snapshot and any approved-rule evaluation. |
| `/liquidity <CA>` | Limited liquidity account evidence for the selected pool. |
| `/setup` | Start or continue guided agent setup. |
| `/setup <description>` | Save a description as an unresolved draft; no AI interpretation occurs yet. |
| `/agent` | Review the current draft or approved rules; access edit controls. |
| `/cancel` | Discard the draft while retaining previously approved rules. |
| `/sources` | Check the candidate feed without starting a scan. |
| `/scan` | Inspect discovery and, when eligible, review and start it. |
| `/pause` | Pause discovery. |
| `/resume` | Resume an eligible paused scan with unchanged approved rules. |
| `/stop` | Stop discovery while keeping criteria and history. |
| `/alerts` | View the latest five saved discovery reports and delivery states. |
| `/unmute <CA>` | Remove a token mute. This does not repeat an old delivery attempt. |

Discovery alerts have **Dismiss** and **Mute** controls in the implementation. Follow-up monitoring and a **Monitor** control are not available yet. A message already being sent may still arrive after pausing or stopping.

## If something does not work

- **No reply:** the development process may be offline. Contact the project owner through your existing private-test channel.
- **Input rejected:** begin a numeric rule with `require` or `warn`; follow the format shown in the bot.
- **Approval blocked:** use `/agent` to inspect unresolved instructions.
- **Source unavailable:** try again later. An outage does not mean that no matching coins exist.
- **Old button rejected:** use `/agent` or `/scan` for the current review.
