# Risk evidence and the private-test policy

Implementation is offline tested. No live burn, lock, creator holding, sale,
coordinated-buy or Jito bundle has been independently validated by this change.
The development workspace's proxy is unreachable and has no Telegram token.

## Required policy

- 100% protection of the **selected pool's current LP redemption claims**.
  Other pools and concentrated-liquidity positions are outside the assessment.
- Verified LP burns are accepted only alongside zero outstanding LP supply and
  validated current pool/mint/vault accounts. No supply gap is called a burn.
- Accepted locks must have at least six **UTC calendar months remaining at
  evaluation**, preserving the time of day and clamping the day to month-end.
  Example: 31 August 2027 at noon becomes 29 February 2028 at noon. One second
  short fails. Original lock duration is irrelevant.
- The attributed signing token creator must currently hold a positive raw token
  amount. Partial sales are allowed and flagged. Transfers are described as
  transfers, not automatically sales. History can remain incomplete even when
  current holdings are known; this is always disclosed.
- Confirmed bundled or coordinated buying is excluded. Same-slot suspicions are
  flagged, never presented as proof. Unknown required coverage blocks matches.

`/setup` accepts the exact answer `risk` at its final question. This adds all
three required risk rules without deleting earlier unresolved text. `/riskrules`
shows the existing extra instructions and the replacement policy; its owner-only,
revision-bound button explicitly replaces those extras in a **draft**. The market
rules and name are retained. Review and approval are separate, as is `/scan`
activation. Existing drafts and approved settings are never auto-migrated.

The **Verification limits** button in `/agent` and `/scan` explains unmapped
instructions, supported evidence and incomplete coverage without changing rules,
approval or scanning. It is private, owner-only and revision-bound. A request
for 100% protection across **all pools** is broader than this selected-pool
policy. `/riskrules` is an explicit replacement, not a lossless interpretation
of that request. Keep the original draft when the scopes differ.

The general bundle requirement currently remains unknown, so **the complete
policy cannot produce a qualifying discovery alert**. Even a bare adapter result
claiming `pass` for bundle coverage is rejected by the evaluator. Adding a future
coverage provider requires implementing and testing its evidence contract;
changing a boolean or weakening the rule is insufficient.

## Liquidity evidence

`/liquidity <CA>` now attempts protection verification after selecting the same
DEX Screener pool as `/check`. On-chain program identity, account linkage,
permissions and supply checks retain the restrictions documented in
[liquidity account evidence](liquidity-evidence.md) and
[PumpSwap account evidence](pumpswap-evidence.md).

For a burn, inspect at most 20 recent LP-mint signatures. Require a successful
SPL Token/Token-2022 `burn` or `burnChecked` instruction for this LP mint with a
positive exact integer amount, at or before the current snapshot. Current LP
supply must be zero, the pool/vaults must remain valid and nonempty, and the
finalized block time must be recent. A transfer to a burn-looking address, a
provider percentage or the pool's supply gap is insufficient. This proves a
burn occurred and no current LP claims remain; it does not reconstruct a
historical percentage burned or promise future protection.

For locks, query public RPC for Streamflow metadata linked to the LP mint.
Support is intentionally narrow: original 1104-byte metadata, fixed full-amount
cliff, classic SPL escrow, no cancellation, fees, top-ups, transfer controls,
pausing, rate edits, migration or unknown nonzero extension state. Both cliff
and end must be consistent. Escrow address derivation, self-authority, LP mint,
balance, initialization and lack of delegates/close/freeze state are verified.
Token-2022 escrows and dynamic/vesting variants remain unknown.

Read the pool, LP mint, vaults, metadata and escrows together at a non-regressing
finalized slot. Every outstanding LP unit must be covered once. BigInt arithmetic
prevents a 99.999…% balance from rounding to 100%. Unexpected duplicates, supply
changes, unsupported controls and incomplete coverage remain unknown. A verified
short-duration claim fails the six-month condition. This method does not invent
a denominator by subtracting pool accounting from mint supply.

This is account/transaction verification under the documented programs. It does
not attest deployed bytecode, remove upgrade authority or establish token safety.

## Developer and buying activity

`/risk <CA>` combines supported liquidity evidence with:

- Attribution from a successful **Pump `create` or supported `create_v2` instruction** whose
  creator argument equals the signing `user`, with the token mint also signing.
  Fee recipients, mutable `coin_creator` fields, pool creators, metadata URLs
  and token-name suffixes are not accepted as developer attribution. Account
  layouts and program addresses must match the pinned Pump IDL. For `create_v2`,
  the supported argument tail after the creator is `bool`, `OptionBool(bool)`,
  `OptionU64(u64)`, `OptionBool(bool)`: exactly 11 bytes, with valid booleans.
  These wrappers are structs, not Borsh option tags. Other tails, launch programs
  and delegated creation remain unknown. Creation flags are not risk verdicts.
- During discovery, a same-mint PumpPortal **creation** signature received within
  the 20-minute queue window can locate that transaction directly. It must still
  resolve through finalized RPC to a successful, matching, signed creation.
  Feed creator labels and migration signatures never establish attribution.
  Unverified locators fall back to sampled mint history; manual checks use that
  history when no candidate locator is supplied.
- Finalized `getTokenAccountsByOwner` balances for that creator and exact mint,
  including all accounts in the bounded response. Empty complete responses mean
  zero; malformed, missing, stale or failed responses mean unknown.
- Direct top-level PumpSwap buys/sells with matching program/instruction, mint,
  signing user, vault ownership and base/quote transfers within the same invocation.
  Bonding-curve sales and unsupported routed/nested swaps are not labelled verified sales. Other observed
  outgoing token transfers are separate events. Amounts are raw token units.
- Two distinct signing buyers executing verified buys within one atomic
  transaction count as confirmed coordinated buying. This is an execution fact,
  not an assertion of malicious intent or proof of Jito membership. Distinct
  buyers in separate transactions in the same slot are only a suspicion.

History is a **sample**, not an exhaustive history: at most 20 recent signatures
for each inspected mint, creator and pool, with 40 creation/wallet/pool transaction
reads in total, including a direct launch lookup. Mint history leaves 20 reads
available; creator history leaves 10 available for pool activity. With a verified
direct creation lookup, recent mint enumeration is unnecessary. LP burn
verification separately permits 20 reads. Transactions, including failed lookups,
are shared only within that one risk check. Each report shows signatures returned,
verified transaction bodies, failed transactions excluded, missing/invalid bodies,
and omissions due to budget or interruption. A source error retains already
verified evidence but marks the sample interrupted or unavailable. Even a fully
read 20-signature page is not complete history. Creation beyond the bounded sample,
missing transaction bodies and RPC history pruning leave attribution unknown.
No sample with no sales becomes “never sold”; no sample with no suspicious buys
becomes “bundle-free”. Other wallets, closed token accounts and venues are not
fully covered. This is manual/discovery evidence, not a developer-wallet event
subscription; `/watch` continues to monitor market data only.

Reports preserve fixed, readable failure reasons: RPC rate limits, request
timeouts, unusable responses, network failures, missing transaction bodies and
budget omissions. Liquidity account-read and validation failures retain their
specific reason instead of being labelled an unsupported pool. Arbitrary provider
errors are never echoed. A report from before this diagnostic fix cannot identify
the cause of an interruption retrospectively. Better diagnostics do not increase
history coverage, establish creator identity or provide complete bundle evidence.

## Supplied Jito bundle IDs

The direct PumpSwap trade reader now accepts the pinned read-only Pump Fee
`get_fees` and `get_fees_with_quote_mint` CPI shapes, with the fee configuration
bound to the parent swap and direct stack depth required. Unrelated programs,
unknown fee instructions, mismatched accounts and deeper nesting remain unknown.
Regression fixtures cover developer sales, atomic buys and supplied bundles with
these calls. They are synthetic protocol-shaped fixtures, not captured live proof.
See the [fee-program IDL](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/idl/pump_fees.json).

`/bundle <CA> <known Jito bundle ID>` calls Jito's read-only `getBundleStatuses`.
Require the exact ID, a successful finalized status, distinct valid transaction
signatures, and independently fetched successful Solana transactions at the same
slot. At least one verified direct buy must match the selected token and pool.
That confirms a bundled buy and yields **FAIL** under the no-bundles policy.
One-transaction bundles are included. No transactions are submitted.

Missing, expired, malformed, non-finalized or unavailable statuses stay unknown.
Jito's status API does not provide an exhaustive token-to-bundle search. This
manual check does not persist a new rule or silently change a running scan.

## Resource, freshness and access controls

- Public free Solana RPC and Jito status endpoints only; no paid fallback, keys,
  wallet connections or transaction submission. DEX Screener still selects pools.
- One risk check at a time; 60-second process-wide risk cooldown, 45-second total
  risk deadline, 8-second individual RPC timeout, 256 KiB RPC response limit.
  Liquidity has a separate 30-second cooldown. Stream discovery is capped at
  20 metadata accounts; contextual reads at 44 accounts; holdings at 100 accounts.
- Jito checks have their own 60-second cooldown, 20-second total deadline, 32 KiB
  response limit, at most five transaction reads and HTTP 429 backoff.
- Chain time must be within two minutes, with at most 30 seconds future skew.
  Required evidence is checked again at rule evaluation, including lock expiry.
  Market provider update time remains unknown. Retrieval time is not chain time.
- Discovery spends risk reads only on candidates whose required market checks
  pass. Cooldown/unsupported/source gaps are saved as `RISK_UNKNOWN`, never
  qualifying matches. Existing market-only strategies retain their declared scope.
- Commands and background scans still require the private allowlist. Group and
  unlisted requests cannot fetch evidence or edit other users' rules.
- No chain evidence includes Telegram IDs, messages, criteria or credentials.
  Reports use fixed-host links to validated public addresses/signatures.

## Pinned sources and live acceptance

- [Streamflow Rust metadata and custody layout](https://github.com/streamflow-finance/rust-sdk/blob/63df7d7b831340daa27f31d007eec2a98380364c/programs/streamflow-sdk/src/state.rs)
- [Streamflow JS layout](https://github.com/streamflow-finance/js-sdk/blob/fb236fff325ab02d7ff5d0ff5e393be8934cda9d/packages/stream/solana/layout.ts)
- [Streamflow transfer authority usage](https://github.com/streamflow-finance/js-sdk/blob/fb236fff325ab02d7ff5d0ff5e393be8934cda9d/packages/stream/solana/StreamClient.ts)
- [Pump creation IDL](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump.json)
- [PumpSwap instruction IDL](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/idl/pump_amm.json)
- [Jito bundle status contract](https://docs.jito.wtf/lowlatencytxnsend/#getbundlestatuses)

Before relying on these claims, independently reconcile a real burn, accepted
lock, short/cancelable lock, creator balance, partial sale, ordinary transfer,
atomic buys and known bundle against the linked slot/transaction evidence. Save
private test records. Unsupported cases must remain unknown. Synthetic tests
exercise these decisions but are not live findings. See [private testing](private-testing.md).
