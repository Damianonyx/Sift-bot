# PumpSwap account observations

The owner's 2026-10-12 screenshot confirmed that `/liquidity` reached public
Solana RPC and read finalized slot 456075024. Its selected pool was owned by
`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, the official PumpSwap program.
The classic-Raydium-only reader correctly returned unsupported/unknown.
This update adds a PumpSwap reader to the same `codex/liquidity-evidence` branch.

## Scope

The command and pool-selection policy are unchanged. The reader is selected
from the on-chain account owner, not the token name, `pump` suffix or DEX label.
Both the initial and contextual reread must satisfy the same program reader.

For PumpSwap, validate the Anchor Pool discriminator and the documented pool
seed hash using the stored bump, index, creator and mints. Check the LP mint
against the `pool_lp_mint`/pool seed hash with a matching bump. This establishes
address relationships for a read-only observation; it does not attest deployed
bytecode or the program's upgrade authority. No transaction is constructed.

The stable pool prefix ends at byte 211: bump 8, index 9, creator 11, base mint
43, quote mint 75, LP mint 107, base vault 139, quote vault 171, recorded LP
amount 203. Support the documented appended fields through byte 287 and zero
allocation padding, including older accounts missing complete trailing fields.
Unknown nonzero tails, malformed booleans and partial nonzero fields fail closed.
Mayhem mode and nonzero virtual quote reserves remain unsupported.

LP mints must belong to Token-2022, be initialized, have the expected pool mint
authority and no freeze authority. Vaults can belong to classic SPL Token or
Token-2022, but must have matching mint/owner links, initialized state, positive
balance and no delegate/close authority. This does not inspect the underlying
traded token's mint permissions or attribute a developer.

Token-2022 extension parsing validates type markers, padding, TLV boundaries,
duplicate entries and lengths. The supported LP mint extensions are metadata
pointer, structurally validated token metadata linked to that LP mint, and a
disabled mint close authority. Vault extension support is limited to immutable
owner. Financial, privileged or unknown extensions are rejected explicitly;
their effects are not silently ignored. Metadata text/URLs are never displayed,
followed or used as evidence of protection.

## Interpretation

Reports label the program as PumpSwap and show its observed outstanding LP
supply with slot, freshness and account links. PumpSwap's pool accounting can
retain amounts that are absent from the live LP mint supply. This reader does
not reconstruct those historical events or turn that difference into a verified
burn/lock percentage. No burn transaction, lock owner or unlock timestamp is
verified. Zero outstanding supply remains a snapshot observation.

The public program documentation says migration normally burns received LP
tokens. That general behavior is not evidence that a specific current pool has
100% protection: later deposits, other pools, upgrades, and unsupported account
features must still be considered. The pool's `coin_creator` field is used for
fee allocation; it is not treated as proof of developer identity or holdings.

All protection requirements stay unknown. This update does not change drafts,
approve rules or start scans. The six-month requirement remains intact.

## Sources

- [Official PumpSwap documentation](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/docs/PUMP_SWAP_README.md):
  program identity, seed relationships, pool fields and accounting semantics.
- [Pinned PumpSwap IDL](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/idl/pump_amm.json):
  discriminator, appended fields and Token-2022 program used for LP creation.
- [Pump migration documentation](https://github.com/pump-fun/pump-public-docs/blob/2293f9a66c654e9fe82dc5e8f4618538f24bb35f/docs/PUMP_PROGRAM_README.md).
- [Token-2022 extension definitions](https://github.com/solana-program/token-2022/blob/b4724e6e7fecc8fc36295f861a769401bf92b270/interface/src/extension/mod.rs),
  [metadata pointer](https://github.com/solana-program/token-2022/blob/b4724e6e7fecc8fc36295f861a769401bf92b270/interface/src/extension/metadata_pointer/mod.rs)
  and [mint close authority](https://github.com/solana-program/token-2022/blob/b4724e6e7fecc8fc36295f861a769401bf92b270/interface/src/extension/mint_close_authority.rs).

## Validation

76 offline tests pass. Ten new tests cover documented seed identities, legacy
and appended layouts, Token-2022 supply, adversarial extensions and malformed
data, owner/authority/link mismatches, contextual reads, report bounds, and a
synthetic RPC-to-Telegram flow preserving the full draft and stopped scan.
The address example comes from official docs; all binary payloads, balances
and timestamps in tests are synthetic, not live findings about that pool.

- [x] Public RPC access and the unsupported-program response were verified by
  the owner's screenshot.
- [ ] Retest the same CA after updating this branch; inspect the actual pool
  program, account response and any remaining unsupported features.
- [ ] Independently compare the decoded LP mint/vault relationships and supply
  with real on-chain data at the reported slot.

No real PumpSwap LP balance, burn or timed lock has been verified by the new
decoder yet. No API key, paid endpoint, hosting or wallet connection is added.
