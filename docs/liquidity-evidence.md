# Manual liquidity evidence: first supported account reader

> Historical stage notes. The current implementation, exact risk policy and remaining
> coverage limits are documented in [risk evidence](risk-evidence.md). Earlier live
> screenshots do not validate the newer verification paths.

This stage implements `/liquidity <CA>` for allowed testers in private chats.
It is a read-only account diagnostic, not a completed lock verifier. Every
report keeps the overall protection requirement **unknown**. It does not
approve a draft, start a scan, or add partial protection rules to discovery.

## What can be observed

DEX Screener selects the same pool used by `/check`: highest known reported
USD liquidity among its returned base-token pools, or an explicitly unranked
fallback if none has a known amount. Only that pool is examined. Other pools,
positions and venues remain outside this observation; a supported smaller
pool is not substituted when the selected one is unsupported.

The original decoder supports the classic Raydium AMM v4 mainnet program
`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`. A second reader now supports the documented PumpSwap formats; see
[PumpSwap evidence](pumpswap-evidence.md). Raydium CPMM/CLMM, Meteora, lockers
and other programs remain unsupported. A matching
DEX name alone is insufficient: the RPC account's owning program is checked.

The reader checks the pool's exact layout, trading state, token linkage and
distinct nonzero account addresses. It derives the expected AMM authority
from the program's seed and stored nonce. It then rereads the pool together
with its LP mint and two vaults in one finalized `getMultipleAccounts` call,
using the first slot as `minContextSlot`. Changed links stop the check.

Classic SPL Token ownership, account lengths, initialization, vault mints and
authorities, and absence of unexpected freeze/delegate/close permissions are
checked. Empty vaults and LP supply greater than the recorded pool amount
produce unknown evidence. Integer supplies remain BigInt/string values;
they are never rounded through JavaScript floating-point numbers.

An accepted snapshot reports how many LP ownership tokens are outstanding.
Zero is reported as zero outstanding supply **at that slot**. A nonzero value
does not establish that the tokens are freely held: they could be in lockers.
Neither observation identifies a developer or proves sales/transfers.

## Why this does not yet verify protection

Raydium initialization retains a minimum in pool accounting while minting a
smaller amount to the user. Deposits increase recorded LP amount and mint
supply; withdrawals reduce both. Consequently, the difference between
recorded amount and supply is not automatically a count of burned tokens.
This implementation deliberately computes no burned/locked percentage.

It does not trace burn instructions, distinguish all historical accounting
events, inspect locker ownership or early-withdrawal powers, or verify an
unlock date. It also does not attest deployed bytecode or audit upgrade
authority. An account observation is not a guarantee of future protection.

The user's requirement remains 100% protected by a valid verified burn or a
verified lock with at least six months remaining. A future verifier needs
pool-specific protection evidence, complete coverage and a reviewed duration
definition. Unknown required results must continue to block qualification.

## Transport and freshness

- Fixed public endpoint: `https://api.mainnet-beta.solana.com`. No key, paid
  endpoint, wallet connection, transaction submission or paid fallback.
- Up to three RPC reads per supported check: identify the pool; read the four
  linked accounts together; retrieve that slot's estimated block time. An
  unsupported pool stops after its first account read.
- One check at a time with a 30-second process-wide cooldown; 8-second request
  timeouts, a 256 KiB response limit and HTTP 429 Retry-After backoff. This is
  a private-testing limit, not a provider capacity guarantee. The existing
  market adapter's separate cooldown also applies to pool selection.
- Validate JSON-RPC IDs/envelopes, account count/order, returned slot and
  base64 account metadata. Raw provider errors are not exposed or logged.
- No Sift cache. Show the finalized slot, estimated block time and completion
  time separately. A block more than two minutes old is stale; a time more
  than 30 seconds ahead is flagged as future. Missing/failed time lookup is
  unknown. These diagnostic bounds are not an approved trading condition.
- Source/account links are constructed from fixed hosts and validated public
  keys. Explorer pages may show later state than the displayed slot; they do
  not stand in for a historical transaction proof.

Only public mint/pool/account addresses are sent to market/RPC providers.
Telegram IDs, user criteria and bot credentials are not sent there. Source
health is shared without submitted addresses; settings remain per user.

## Sources inspected

- [Raydium AMM program, pinned source](https://github.com/raydium-io/raydium-amm/tree/d26944bfb76fb5fa8f91e5d440c2050ed358ef81/program/src):
  `lib.rs` identifies the mainnet program; `state.rs` defines the packed
  account; `processor.rs` defines the authority seed, initialization, deposit
  and withdrawal accounting. Layout fields used: status 0, nonce 8, vaults
  336/368, token mints 400/432, LP mint 464, recorded LP amount 720; 752 bytes.
- [Official Raydium SDK v4 layout](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/liquidity/layout.ts)
  cross-checks the account ordering. The decoder is restricted to v4.
- [SPL Token account definitions](https://github.com/solana-program/token/blob/8185db13640f0df038266c7cf4306c212d81380a/interface/src/state.rs):
  classic mint/account sizes and fields, including u64 supply and COption tags.
- [Solana getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts)
  and [getBlockTime](https://solana.com/docs/rpc/http/getblocktime) document
  contextual account reads and estimated production time.
- [RugCheck API specification](https://api.rugcheck.xyz/swagger/doc.json):
  locker endpoints declare API-key authentication, and forced refresh is
  paid-only. This stage does not call those endpoints or interpret a risk score
  as protection evidence.

## Validation

76 offline tests pass, including the initial 16 liquidity tests and 10 PumpSwap
tests. The liquidity checks cover transport, binary account
linkage, authority mismatches, malformed data, exact integer supply, stale
snapshots, unsupported programs, quotas, access isolation and preservation
of the blocked draft. All fixtures are synthetic; no test uses real credentials
or contacts Telegram, a market API or RPC.

The managed execution environment's proxy was unreachable. The owner later
verified public RPC access from Codespaces (2026-10-12 screenshot), returning
finalized slot 456075024 and an unsupported PumpSwap program. The new PumpSwap
decoder still needs a live retest; source inspection is not live validation.

Live checks still required:

- [x] `/liquidity <CA>` reached public RPC from the existing Codespace.
- [ ] A selected classic Raydium pool returns account observations; compare
  program, LP mint and vault links with the snapshot slot.
- [x] The screenshot reported an unsupported pool as unknown, not unlocked.
- [ ] The owner's draft remains present and discovery remains stopped.

No real burn, timed lock, lock percentage or six-month duration has been
verified by this stage. Those remain subsequent evidence work.

