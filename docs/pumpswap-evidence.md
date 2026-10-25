# PumpSwap liquidity evidence

Sift reads the selected pool using its on-chain program owner, never the token
name, `pump` suffix or DEX label. This document describes the current reader;
see [risk evidence](risk-evidence.md) for the complete screening policy.

## Account validation

For PumpSwap, the reader validates the Anchor Pool discriminator, pool seed
hash (stored bump, index, creator and mints), LP mint seed relationship and
linked token vaults. The pool, LP mint and both vaults are reread together at a
non-regressing finalized slot. These checks establish account relationships;
they do not attest deployed bytecode or remove program upgrade authority.

The stable prefix ends at byte 211. Appended fields through byte 287 and zero
allocation padding are supported. Missing complete trailing fields retain their
documented zero/false defaults. Partial nonzero fields, malformed booleans,
unknown nonzero tails and Mayhem mode remain unsupported.

LP mints must belong to Token-2022, be initialized, have the expected pool mint
authority and no freeze authority. Vaults can use classic SPL Token or supported
Token-2022 layouts, with matching mint/owner links, initialized state, positive
balances and no delegate/close authority. The reader does not assess all traded
mint permissions or infer a developer from the pool creator or fee recipient.

Token-2022 parsing validates account markers, padding, TLV boundaries, duplicate
extensions and lengths. Supported LP extensions are metadata pointer, bounded
metadata linked to the LP mint, and a disabled mint close authority. Vault
extension support is limited to immutable owner. Financial, privileged and
unknown extensions remain unsupported. Metadata URLs are never followed.

## Pending fees and signed reserves

PumpSwap v2 trades can leave protocol and creator fees in the quote vault.
Those fees are payable separately and are not LP liquidity. The reader uses
exact BigInt arithmetic, including the signed 128-bit virtual reserve field:

```text
pending fees = protocol_fees + creator_fees
quote liquidity = quote vault balance - pending fees
boost component = virtual_quote_reserves + pending fees
effective pricing reserves = quote vault balance + virtual_quote_reserves
```

The last quantity is a pricing quantity, not a cash balance. Negative virtual
reserves that exactly offset pending fees indicate a pool with no boost
component. Such pools can use the existing bounded LP protection verifier.
Fee sweeps reduce the raw vault balance and pending fees together; this does
not by itself reduce the quote liquidity used in this account check.

Negative boost components, fees consuming or exceeding the vault balance,
nonpositive effective reserves and values outside the documented u64 range are
rejected. Reported reserve values are raw quote-token units, not USD. They do
not replace the market provider's USD-liquidity observation or saved thresholds.

## Protection eligibility

A positive boost component permits validated account observations, but **boosted
pool protection remains UNKNOWN**. The pinned IDL treats boost liquidity
operations differently from ordinary LP deposit/withdraw operations. Sift does
not apply the legacy LP burn/lock proof to that mode, even with zero outstanding
LP supply. A final custody reread changing to an unsupported mode cannot pass.

For an unboosted supported pool, zero LP supply still requires an actual
successful LP burn transaction at or before the current account snapshot.
Current account freshness, linkage and permission checks remain mandatory.
The gap between recorded pool LP accounting and mint supply is never called a
verified burn percentage. Nonzero LP supply requires exact supported custody;
the present Streamflow reader supports classic-SPL escrows only, so a PumpSwap
Token-2022 LP lock cannot qualify through that reader.

All results cover one selected pool's current LP claims. Other pools, virtual
pricing amounts, pending fees, future deposits, program upgrades and token
safety are not covered by that proof. Unknown required checks continue to block
matches. Manual reads never approve drafts or start scanning.

## Validation and recorded live observations

The offline suite includes synthetic fixtures for negative reserves with exact
fee offsets, fee sweeps, positive and fee-masked boosts, overflow/inconsistent
balances, partial appended fields, burn requirements, stale snapshots and pool
mode changes. It also replays captured public account bytes; that replay is an
offline regression, not a new live check.

The [October 25 raw account capture](evidence/pumpswap-account-observation-2026-10-25.json)
records the owner's example pool at finalized slot 461382716. A separate
[fresh read through the updated reader](evidence/pumpswap-liquidity-observation-2026-10-25.json)
returned the same balances at slot 461383923 with recent block time:

- Zero outstanding LP mint supply; this is an account fact, not a burn proof.
- Pending protocol/creator fees: 6,612 / 572,369 raw quote units.
- Quote balance after pending fees: 59,499,200,759 raw units.
- Positive boost component: 17,584,505,479 raw units.
- Protection verdict: UNKNOWN, because boosted-pool protection is unsupported.

These are public RPC observations. No positive burn or lock was independently
verified, no Telegram message was sent, and no full-policy match was established.
A positive unboosted fee-bearing burn path currently has synthetic coverage;
it still needs independent live acceptance. No paid source or wallet is used.

## Pinned references

- [PumpSwap fee/reserve accounting](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md)
- [Signed virtual reserve semantics](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)
- [PumpSwap IDL](https://github.com/pump-fun/pump-public-docs/blob/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl/pump_amm.json): Pool fields and `BoostPoolLiquidityUnsupported`.
- [Official SDK 2.2.0](https://www.npmjs.com/package/@pump-fun/pump-swap-sdk/v/2.2.0): `src/sdk/offlinePumpAmm.ts` subtracts protocol/creator fees for LP deposit/withdraw inputs. The registry archive integrity was checked during source inspection; it is not a runtime dependency.
- [Original pool/LP seed documentation](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/docs/PUMP_SWAP_README.md)
- [Token-2022 extension definitions](https://github.com/solana-program/token-2022/blob/b4724e6e7fecc8fc36295f861a769401bf92b270/interface/src/extension/mod.rs)
