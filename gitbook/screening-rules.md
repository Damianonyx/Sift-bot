---
description: Choose measurable conditions, distinguish requirements from warnings and approve changes explicitly.
---

# Your screening rules

Sift's current guided setup supports one named agent per user. There is no preselected trading strategy. You choose which supported conditions to use and their thresholds.

## Required checks and warnings

| Choice | Meaning | If the result is unknown |
| --- | --- | --- |
| `require` | The condition must pass before the token qualifies. | The token cannot qualify. |
| `warn` | Show the result without independently excluding the token. | Show unknown as a warning. |
| Skip | Do not include that numeric condition in this draft. | The condition is not a screening rule. |

At least one required condition is needed for approval. An empty or warning-only strategy cannot be activated.

Failing to establish a required condition is different from proving the opposite. For example, an unknown lock cannot pass a lock requirement, but it is not evidence that the pool is unlocked.

## Conditions supported by guided setup

| Condition | Measurement | Input format example |
| --- | --- | --- |
| Market-cap range | DEX Screener's market-cap estimate for the selected pool. FDV is not substituted. Both bounds are inclusive. | `require 20k 60k` |
| Minimum liquidity | Reported USD liquidity in the selected pool. This is not a lock check. | `require 30000` |
| Minimum volume | Selected-pool USD volume over the provider's rolling one-hour window. | `warn 60000` |
| Maximum pool age | Time since the provider's pool-creation timestamp. This is not token creation or trading-start time. | `require 20` |

**These numbers demonstrate the input format only. They are not recommendations or default settings.** Replace them with your own criteria.

USD amounts accept `$`, correctly grouped commas and `k`/`m` suffixes. For example, `require $20,000 $60,000` and `require MIN $20,000 MAX $60,000` express the same example range. Pool age uses plain minutes, without a currency symbol or `k`/`m` suffix.

The mode must be explicit. A bare message such as `$20k - $60k` is not silently interpreted as required or warning-only.

## Additional instructions

At the last setup question, send any other requirements or warnings in one message, up to 800 characters. Send `none` only when there are no additional instructions for that setup.

Additional natural-language instructions are currently retained as unresolved. They block approval until Sift can interpret and support them, including when they describe warning-only checks. The current bot cannot turn arbitrary text into measurable rules.

You can also use:

```text
/setup <your description>
```

This preserves the description as a draft. It does not interpret the request, start an AI conversation or activate a scan.

Examples of checks that remain unsupported for screening include verified liquidity locks, developer holdings and sales, holder concentration, bundles and coordinated buying. A manual `/liquidity` report does not make these conditions supported.

## Review, approve, activate

1. **Draft:** Sift shows the selected conditions and any unresolved instructions.
2. **Approval:** review and explicitly approve a supported, complete rule set.
3. **Activation:** use `/scan`, review coverage and choose **Start discovery**.

Approval and activation are separate. Sift should never silently weaken a requirement to produce more matches.

## Editing an existing agent

Use `/agent` and choose **Edit rules**. While you edit, any previously approved rules remain saved. A scan that was already running continues using those previously approved rules until changed rules are approved; use `/pause` if you want it to stop during editing.

- An unapproved draft is not applied to manual checks or an existing scan.
- A draft blocks new activation or resume.
- Approval of changed rules pauses an active scan; use `/scan` to review and start again.
- `/cancel` discards the draft and retains previously approved rules. It is not a command to stop a scan.
- `/stop` stops discovery while keeping criteria and history.

Editing numeric conditions or replying `none` does not erase previously retained unresolved instructions. Discard a draft only when you intentionally want to replace it, not as a way to claim unsupported requirements have passed.

## Saved state

The development implementation stores each user's drafts, approved rules, scan state, mutes and alert records separately in a local database. Recovery across restarts depends on retaining that same database. Deleting the environment or losing its storage can lose the records.

Restart recovery and user separation have automated coverage. Their remaining live-test status is recorded in [Current status and roadmap](status-and-roadmap.md).
