---
description: Understand the sources, coverage, timestamps and limits behind Sift's checks.
---

# Data and evidence

Sift's screening conditions use explicit rules applied to available data. AI is intended to help interpret instructions and explain findings; it is not connected in the current test and must not invent evidence.

## Current sources

| Source | Current use | Coverage limit |
| --- | --- | --- |
| [DEX Screener](https://docs.dexscreener.com/api/reference) | Market snapshots and supported numeric screening rules. | Indexed Solana pools where the submitted CA is the base token; one selected pool is assessed. |
| [GeckoTerminal](https://apiguide.geckoterminal.com/) | Candidate addresses for the discovery implementation. | First page of Solana new pools; up to 20 distinct base-token candidates per cycle. |
| [Solana RPC](https://solana.com/docs/rpc) | On-chain account observations for supported liquidity readers. | One selected pool and its linked accounts; not a complete lock or wallet investigation. |

Discovery does not cover every new Solana token or venue. It does not paginate the candidate feed or catch up on everything missed during downtime. Quote-only pools, newly launched tokens and unindexed venues may be missed.

DEX Screener selects the pool used for the market checks independently of the candidate feed. It can be a different pool from the one that introduced the token to Sift.

## What the market report measures

The report includes available price, estimated market cap, FDV, pool liquidity, volume and buy/sell counts. Activity windows are the provider's rolling 5-minute, 1-hour and 24-hour windows. Guided volume screening currently uses the 1-hour window only.

Sift selects the supported pool with the highest known reported USD liquidity. Pools with unknown liquidity cannot be ranked. If all supported pools have unknown liquidity, a report can use the first pool while keeping liquidity unknown; a strict liquidity requirement still cannot pass.

These distinctions matter:

- **Market cap and FDV are separate.** FDV means fully diluted valuation; it is not a replacement for missing market cap.
- **Pool age is not token age.** A pool-creation timestamp does not establish when the token was created or when trading first began.
- **Liquidity amount is not liquidity protection.** A dollar balance does not prove a lock or LP burn.
- **A pool result is not an all-pools result.** Checking one pool cannot establish protection across all liquidity venues.
- **A source response is not independent verification.** Successfully receiving metrics does not establish that every value is correct or current.

## Liquidity evidence

`/liquidity <CA>` is a manual evidence command. Readers exist for Raydium classic AMM v4 and supported PumpSwap account layouts. Unsupported programs, modes and token extensions remain unknown.

For supported layouts, the reader validates relevant account ownership, linked LP mint and vault fields, authorities and supply consistency. It reports finalized account context and available time information. LP tokens represent liquidity-provider positions in these supported pool types.

The current reader does **not**:

- Verify timed lockers or the remaining duration of a lock.
- Establish the history or extent of LP burning from a supply difference alone.
- Calculate a verified percentage of liquidity protected.
- Establish 100% protection across all pools.
- Investigate developer holdings, trades, bundles or coordinated wallets.

Consequently, a requirement such as “100% protected through a valid LP burn or a lock with at least six months remaining” still cannot pass. Unsupported does not mean unlocked. An observed LP-supply value does not, by itself, prove safe or permanent protection.

## Developer activity and bundles

These features are planned, not live checks. Reports currently identify them as unknown or unsupported.

The intended evidence standard is to identify wallets using supported attribution, distinguish token transfers from verified sales, and separate confirmed findings from suspicions. Wallet connections alone must not be presented as proof of a bundle or insider control. A label such as “developer” must not be guessed from an unrelated fee-recipient field.

## Retrieval time, freshness and history

A **retrieval time** says when Sift fetched a response. The market provider's underlying update time is currently unknown, so a recent fetch can contain delayed data.

- Market snapshots are fetched on demand without a Sift market cache.
- Candidate-feed results can be cached for less than a minute and are labelled when cached. Failed refreshes do not continue serving the previous success as a fresh result.
- On-chain reports show the finalized slot and block time when available. Missing time information leaves freshness unknown; stale or future-dated observations are not treated as current verified protection.
- `/alerts` retrieves saved reports. Viewing history does not run a fresh token check.
- Automated tests use synthetic data. Test fixtures and website walkthroughs are not live token findings.

If a source fails, unknown required results cannot qualify. Source health and scan issues are available through `/status`, `/sources` and `/scan`; proactive outage notifications are not implemented.

## Reading an alert

An implemented discovery report contains the full CA, token details, selected pool, reasons and measurements, unknown checks, retrieval time, and source/chart links. Important claims should be traceable to those links. Unsupported checks remain visible even when the supported market rules pass.

A match is a reason to investigate further. It is not a safety certificate or prediction of price performance.
