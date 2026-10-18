# Data sources and verification

Sift validates API responses and token identities. It does **not** certify every
provider metric as accurate. `/verify <CA>` compares fresh requests for the same
Solana pool and exposes disagreements without changing rules or scan state.
This diagnostic is manual; discovery still evaluates DEX Screener's reported
market estimates. Cross-provider agreement is not a new automatic screening rule.

## What each source does

| Source | Used for | Limit |
| --- | --- | --- |
| Pump.fun via PumpPortal | New-token and migration candidate events | Third-party stream, not a direct Pump.fun API; event price, reserve and safety claims are not screening metrics |
| DEX Screener | Base-token market estimates and one selected pool | Provider estimates, unknown update time; unindexed or quote-only coverage cannot satisfy missing metrics |
| GeckoTerminal | New-pool candidates and same-pool comparison | CoinGecko's on-chain data service, not a separate independent CoinGecko market feed; first new-pools page only |
| Meteora DLMM | Direct pool candidates and exact-pool identity comparison | First 20 newly created pools; token X and Y both considered |
| Meteora DAMM v2 | Direct pool candidates and exact-pool identity comparison | First 20 newly created pools; DBC before migration and DAMM v1 are not directly covered |

Meteora's public APIs require no key or subscription in this integration. No paid
fallback is configured. Set `SIFT_METEORA_ENABLED=false` to disable both direct
feeds. Invalid boolean configuration stops startup/preflight.

Feeds share the existing 20-candidate cycle limit. Meteora candidates are rotated
after actual scan selection, deduplicated with other sources and attributed in
alerts. Candidate refreshes are at most once per minute per protocol; failures
clear cached success and remain visible as partial coverage. Missing required
DEX Screener data cannot be replaced by Meteora estimates. A Meteora candidate
may be checked in a different pool if DEX Screener selects that pool; `/verify`
always compares the **selected** pool, never a different source's top pool.

## Compare a token in Telegram

Send `/verify` followed by a full CA in the allowed tester's private chat. The
report checks pool/network identity and **both** token mint addresses, then
compares DEX Screener and GeckoTerminal's USD price, market cap, pool liquidity
and rolling one-hour volume. If GeckoTerminal reverses base/quote orientation,
the correct token price is selected and its base-token market cap is not borrowed.
Missing numbers stay unknown, zero stays zero, and FDV is never substituted for
market cap. Percent differences use DEX Screener's value as the denominator;
a zero denominator with a nonzero comparison has no percentage.

For a DEX Screener-selected Meteora pool, the report also asks both official
Meteora APIs for that exact pool and verifies the mint pair. A pool absent from
one protocol is not evidence that the other protocol is unavailable. Meteora
TVL and one-hour volume are displayed as provider figures; their units and
methodology are not established explicitly by the published OpenAPI field
descriptions, so Sift does not silently compare them with USD values.

Checks have a 20-second process-wide diagnostic cooldown, eight-second HTTP
timeouts, two-MiB response limits and provider rate-limit backoff. Requests are
not synchronized. Retrieval time is not the provider's update time. Agreement
between providers does not prove independent indexing or on-chain correctness.
No liquidity-lock, developer-sale or bundle verdict follows from this report.
Native Copy CA buttons and code formatting are included.

## Recorded live observations — October 18, 2026

[Public diagnostic run](https://github.com/Damianonyx/Sift-bot/actions/runs/39150217935)
sampled the APIs from 17:34:41 to 17:34:50 UTC. The
[recorded JSON](evidence/source-audit-2026-10-18.json) retains the exact addresses,
retrieval times and values. No API keys, Telegram messages, AI calls or wallet
operations were involved.

- Both Meteora new-pool feeds responded with no rejected identities: 20 DLMM
  token candidates and 21 DAMM v2 token candidates, 37 distinct mints combined
  before the scanner's shared 20-candidate limit.
- For DLMM pool `DQ9weJhfiU4iL5LUoeshDrm5KxDHCMiSbnnKJz7buMcf`, all three
  providers agreed on the pool and mint identities. DEX Screener price was
  $0.2882 and GeckoTerminal price $0.2881805373 (about 0.00675% apart).
  Market cap was **$288,260,116 versus $86,155,479.94**, about 70.11% apart
  relative to DEX Screener. Liquidity differed by about 2.46%. Different supply
  methods may explain the market-cap gap, but this check did not establish its
  cause or determine which estimate is correct.
- The user's previously checked Pump.fun mint
  `7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump` had the same PumpSwap pool on
  both market providers. Price differed by about 0.122%, market cap 0.117%,
  liquidity 0.0011%, and one-hour volume 0.0683%.
- The highest-TVL DAMM v2 sample was returned by Meteora, but neither mint's
  DEX Screener response included that exact pool. Its comparison remained
  unavailable. **The diagnostic exited 2 (incomplete)**; it was not a full pass.

The two Meteora samples were selected by highest API TVL to complement the
new-pool feed checks. This is a tiny, deliberately bounded sample, not evidence
about all memecoins or sustained provider accuracy. The prior
[PumpPortal live observations](pumpfun-discovery.md#current-evidence)
established event-to-market connectivity, not accuracy of launch metadata.

## Re-run the public sample

Open the [existing Codespace](https://effective-carnival-wr5j9v5g9775c95q9.github.dev/)
and run `npm run check:sources`. No Telegram token is needed. It checks both
Meteora candidate feeds and at most three market samples, writes the ignored
`source-audit-results.json`, and exits within 85 seconds. Exit 0 means all sampled
comparisons were available, **not** that the metrics were accurate; exit 2 means
one or more observations were incomplete. The GitHub Actions workflow is
manual-only; it does not contact providers on every push. GitHub only exposes
manual dispatch once the workflow is available on the default branch.

## Next coverage priorities

1. [Raydium LaunchLab](https://docs.raydium.io/products/launchlab/overview) and its
   [platform configurations](https://docs.raydium.io/user-flows/launchlab-platforms):
   direct launch and migration events, with verified program/platform identities.
   Aggregators may already return migrated pools; that is not early launch coverage.
2. [Meteora DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc): launches
   before DAMM migration. Today's direct DLMM/DAMM v2 feeds do not close that gap.

Each needs matching market-data and risk coverage, deduplication and bounded
source limits. Adding launch names alone does not make unindexed coins qualify.

Bubblemaps integration is deferred at the owner's request because API access
requires a key and subscription credits. No connector or paid request was added.
Its [`supply_stats.bundles` metric](https://docs.bubblemaps.io/data/api/tokens/metrics)
means supply held by the ten largest linked clusters, excluding standalone
holders. It is **not** proof of transaction bundling. Transfer links can support
investigation; they cannot by themselves establish coordinated buys or fraud.
Complete bundle coverage remains unknown.

## API references

- [Meteora DLMM API](https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview)
- [Meteora DAMM v2 API](https://docs.meteora.ag/developer-guides/damm-v2/api-reference/overview)
- [DLMM OpenAPI schema](https://github.com/MeteoraAg/docs/blob/main/developer-guides/dlmm/api-reference/openapi.json)
- [DAMM v2 OpenAPI schema](https://github.com/MeteoraAg/docs/blob/main/developer-guides/damm-v2/api-reference/openapi.json)
- [GeckoTerminal public API](https://apiguide.geckoterminal.com/)
- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [PumpPortal data API](https://pumpportal.fun/data-api/real-time/)
