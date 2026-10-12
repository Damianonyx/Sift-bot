# Free-data integration plan

Reviewed 2026-10-12. External-service budget: **$0**. No API subscription,
paid fallback, wallet connection or continuous hosting is enabled by this
plan. Existing Codespaces usage remains subject to the owner's allowance.

The next product milestone is candidate discovery with a disclosed source,
followed by evidence checks and an approved-rule alert. The owner's full
draft remains blocked until its strict requirements can actually be checked.
A partially screened candidate must not be presented as a qualifying match.

## Sources to validate

| Source | Useful for | Limitations and next decision |
| --- | --- | --- |
| GeckoTerminal public API; CoinGecko Demo as a possible free-key alternative | Newly indexed Solana pools and their token addresses | Keyless feed returned 20 parsed candidates in the owner’s Codespace; independent evidence validation pending. CoinGecko Demo requires its own key. Coverage is indexed pools, not every token launch. |
| Existing DEX Screener adapter | Market cap estimate, selected-pool liquidity, rolling volume and pool age | Already returns manual snapshots; it cannot prove liquidity protection or developer behaviour. |
| RugCheck public report and recently detected token endpoints | Candidate addresses and supporting risk observations | Inspect actual report schema, timestamps and evidence. A risk score or missing warning does not establish safety or absence of bundles. |
| Solana public RPC | Current holdings of an identified wallet, transaction retrieval and on-chain state | Attribution and transaction classification require additional logic; public capacity and historical coverage are limited. |
| Pool/locker program state | Verify a supported pool's liquidity ownership, lock conditions or burn mechanism | Requires pool-specific decoding and verifiable program/account links. A provider's aggregate locked percentage alone is insufficient. |

### Discovery

Start by validating `GET https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1`
as an anonymous read. The [provider's public API page](https://www.geckoterminal.com/dex-api)
currently advertises 10 calls/minute before a paid upgrade, while older
indexed FAQ text mentions 30. Do not design around the higher historical
number; keep probe traffic low and obey 429 responses.

The [CoinGecko Demo endpoint documentation](https://docs.coingecko.com/demo/reference/latest-pools-network)
provides a documented fallback with a free Demo key. It describes recently
created pools, page limits and nullable market cap. This is a separate endpoint
and authentication model; do not assume the same quotas as the keyless API.
Never replace a null market cap with FDV. Source the base mint explicitly;
a pool address is not the CA, and quote-token metrics must not be assigned to
the base token.

Before treating discovery as live-validated, measure actual pool age/delay, pagination gaps,
coverage and response fields. Deduplicate by token and approved-rule revision.
Record coverage interruptions and retain nonmatches with reasons. A fetch
failure or truncated page must not become “no matches exist.” Bound the
candidate workload before multiplying per-token evidence requests.

### RugCheck evidence

The [official API specification](https://api.rugcheck.xyz/swagger/doc.json)
lists recent-token and single-report GET routes without declaring an API-key
requirement there. Explicit report refresh is marked paid-only, and LP-locker
routes declare API-key authentication. These details do not establish a free
quota or freshness guarantee. Test anonymous reads; do not call paid refresh
or assume the authenticated locker routes are available at $0.

The specification's full-report and insider responses lack enough detailed
schema/evidence guarantees to implement classification confidently from docs
alone. A report may help locate an attributed creator or protected pool, but
those claims need timestamps, coverage and supporting on-chain evidence.
Wallet links alone remain suspicions, not confirmed coordinated control or
proof of bundling. Cache/retrieval time and source observation time must be
reported separately.

### Wallet and liquidity verification

Solana's documented [token-account lookup](https://solana.com/docs/rpc/http/gettokenaccountsbyowner),
[address history](https://solana.com/docs/rpc/http/getsignaturesforaddress) and
[transaction lookup](https://solana.com/docs/rpc/http/gettransaction) provide
building blocks for supported evidence checks. A wallet balance does not prove
who the developer is. A balance decrease does not prove a sale: inspect swaps,
transfers, failed transactions and relevant inner instructions separately.
An incomplete history cannot justify “the developer never sold.”

The [RPC provider guidance](https://solana.com/docs/rpc/providers) distinguishes
shared development endpoints from dependable production capacity. This plan
uses bounded public reads for validation only. No paid RPC service is enabled.

For liquidity, verify the exact pool/program and denominator used for the 100%
requirement, each protected position/share, lock ownership and unlock time.
Check that a burn applies to LP ownership rather than the traded token.
Supported permanent locks may work differently from fungible LP burns; for
example, [Raydium's official Burn & Earn announcement](https://t.me/s/raydium/307)
describes permanent liquidity protection while fees remain claimable.
This is an implementation lead, not proof about any submitted pool.
Unknown or unsupported positions prevent claiming 100% coverage. Six months
remaining must be defined and reviewed before activation, not inferred from
the original lock duration.

### Manual on-chain account reader

The `codex/liquidity-evidence` stage adds `/liquidity <CA>` using anonymous
Solana RPC. It reads and validates the selected pool’s classic Raydium v4
account links, LP supply and snapshot freshness. It now also includes a
[PumpSwap reader](pumpswap-evidence.md) for the program identified in the
owner’s live screenshot. Other programs remain unsupported. This is
account evidence collection, not a completed burn/lock verifier; no strict
protection rule is enabled. Public RPC access was verified by the owner; PumpSwap decoding and real
account findings still need live validation. The suite now contains 76 offline tests.

## Validation state and build sequence

Official documentation was inspected. The web reader did not provide
inspectable live token payloads for the attempted public feed reads, and a
report read failed. These observations are not successful API acceptance
checks. The owner subsequently verified the GeckoTerminal feed response in Codespaces:
20 parsed candidates from 20 returned pools, zero invalid rows. Independent
CA/pool comparisons and risk-evidence validation remain pending. No synthetic
response may stand in for that validation.

The `codex/discovery-feed` stage implements the bounded keyless adapter,
explicit scan activation, pause/resume/stop, persisted deduplication, alert
history and on-demand source status. It passes 50 offline tests, including a
synthetic feed-to-alert path. Owner screenshots on 2026-10-12 confirm live `/sources` access and `/scan`
remaining stopped with an unapproved draft. No real discovery alert has been
verified yet. The current full
strategy still needs all of its strict risk checks before it can qualify.

1. Validate one public feed and its real CA/pool/time fields; keep coverage
   visible and add a bounded candidate adapter.
2. Inspect real evidence reports and on-chain reads for one supported pool
   type and attributed wallet. Define freshness and missing-history rules.
3. Translate supported extra conditions into measurable rules for the owner's
   review. Keep unsupported bundle/coordination requirements blocking.
4. Enable scanning only for an explicitly approved, supported configuration;
   add pause/resume/stop, persisted delivery deduplication and source status.
5. Verify one real qualifying alert, or explain verified rejections/unknowns
   when none qualify. Do not relax user thresholds to manufacture a match.

This plan does not promise that every requested check can be supported by
free services. It identifies the evidence that must be tested before making
that claim or proposing a paid option.
