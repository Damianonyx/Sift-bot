---
description: What has been built, what has been observed live, and what still needs evidence or implementation.
---

# Current status and roadmap

**Documentation reviewed: 13 October 2026.** Sift is in private development. Public access, continuous hosting and pricing are not finalised.

This snapshot describes the development branch [`codex/liquidity-evidence`](https://github.com/Damianonyx/Sift-bot/tree/f0801188a07db71c598567bfebb1d0fbd843b52d), at commit `f0801188a07db71c598567bfebb1d0fbd843b52d`. The repository's `main` branch and the bot process actually running can be behind that development version. Check `/help` and `/status` in Telegram before assuming a feature is available.

## Implementation and live validation

“Implemented” means code exists. “Observed live” means a specific result was seen during private testing. Neither means complete production readiness.

| Area | Implementation | Live validation recorded so far |
| --- | --- | --- |
| Telegram welcome, help, status and own-ID commands | Implemented for private testing. | Replies confirmed on mobile. |
| Manual Solana market check | Implemented with DEX Screener snapshots and unknown labels. | A live token report and empty-command guidance were confirmed. Metric accuracy has not been independently reconciled. |
| Guided criteria and draft review | Implemented with approval, unresolved instructions and saved state. | Guided setup reached review; unsupported additional requirements correctly blocked approval. |
| Candidate feed | Implemented with limited GeckoTerminal coverage. | `/sources` returned 20 distinct candidates from 20 pools in one observed response. This is an observation, not a promise of each cycle's count. |
| Automatic discovery for supported approved rules | Implemented and covered by synthetic tests. | The blocked-draft scan state was confirmed. A complete live discovery-to-alert flow remains pending. |
| Pause, resume, stop, mutes and alert history | Implemented with automated coverage. | Complete mobile acceptance remains pending. |
| State recovery and per-user separation | Implemented with automated coverage. | Full live restart and second-tester checks remain pending. |
| Raydium classic and supported PumpSwap liquidity readers | Implemented as manual account observations. | Public RPC access and an unsupported-program response were confirmed before PumpSwap support was added. The new PumpSwap decoder still needs a live retest. |
| Verified liquidity protection | Incomplete. | No full-protection or six-month lock validation. |
| Conversational AI | Not connected. | Not available. |
| Developer monitoring, bundle analysis and follow-up alerts | Not connected. | Not available. |

The documented development version passed 76 offline tests. Those tests use synthetic network responses and account fixtures; they are not evidence that any real token meets a strategy.

## Discovery limits in this version

- Only approved, supported numeric rules can activate discovery. Unresolved drafts block new activation and resume.
- Up to 20 distinct candidates from the first Solana new-pools page are considered per cycle.
- Cycles begin roughly once a minute while the process runs; slow calls and rate limits can extend that interval.
- Up to three new alerts are attempted per user per cycle. Additional matches can be delayed or missed; scan status reports suppression.
- There is at most one automatic delivery attempt for each user, token and unchanged rule set. Failed or uncertain deliveries remain in history and are not blindly retried.
- A change in approved rules can permit a new report. Requalification and follow-up alerts for meaningful changes are not implemented.
- Quiet hours, user-configurable alert limits and grouped updates are not implemented.

These are private-test operating limits, not suggested trading thresholds. Delivery is not guaranteed, and a quiet bot does not prove that no qualifying coins exist.

## Next validation milestones

1. Retest the supported PumpSwap reader against live accounts and inspect the report's evidence and unknowns.
2. Complete a real discovery-to-alert flow using an explicitly approved, fully supported test configuration.
3. Validate mobile controls, persistence after a real restart, user separation and provider-failure behavior.
4. Extend verified liquidity evidence and attributed wallet checks before claiming those requirements are supported.
5. Add AI-assisted clarification and follow-up monitoring with explicit approval and data limitations.

Unsupported requirements in an existing user's strategy must remain intact. A separate test configuration does not validate that full strategy.

## Planned product scope

The first-version direction is Solana, one named agent per user, Telegram discovery alerts and user-selected monitoring. Natural-language setup should clarify ambiguity and show measurable conditions before activation.

A 24-hour monitoring period after selecting **Monitor** is a proposal, not a running feature. Liquidity changes, attributed developer sales and transfers, and failures of original screening conditions are intended monitoring events where evidence supports them.

The website currently has a local landing-page draft. It has not been published or connected to agent accounts. Later possibilities include a dashboard, multiple chains and agents, deeper wallet analysis, preference learning and subscriptions.

No public launch date is committed. Progress should be evaluated through accurate data, relevant alerts, delivery delay, duplicates and missed events—not only tokens that later rise. Unsuccessful and uncertain reports should remain part of that evaluation.
