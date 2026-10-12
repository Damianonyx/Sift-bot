# First discovery validation scenario

This is the owner's proposed first test case, not a default strategy for
other users. It is not activated, and no scanner is running. Values below
record the latest draft shown in the owner's Telegram screenshot; they do
not represent approved activation or live token findings.

| Check | Intended treatment | Evidence available today |
| --- | --- | --- |
| Market cap from $20,000 through $60,000 inclusive | Required; label provider estimate, never substitute FDV | DEX Screener reports an estimate on a manual check; provider update time is unknown |
| Selected-pool liquidity of at least $30,000 | Required; measure the selected pool, not a sum across venues | DEX Screener snapshot; liquidity amount alone proves no lock |
| Selected-pool volume of at least $60,000 over the last 1h | Required; use the provider's rolling window | DEX Screener snapshot |
| Selected-pool age of at most 20 minutes | Required; do not substitute token creation or first trading time | DEX Screener pool timestamp where available |
| 100% of the assessed pool's liquidity protected | Required; verify coverage rather than infer protection from a dollar balance | Unknown / unsupported |
| At least six months remain on any accepted liquidity lock at the time of checking | Required; the original duration alone is insufficient | Unknown / unsupported |
| Verified LP burning as liquidity protection | Accepted where LP burning actually prevents withdrawal for that pool type | Unknown / unsupported |
| Identified developer still holds the token | Required; reliable wallet attribution and current holdings needed | Unknown / unsupported |
| Developer sold some tokens but still holds tokens | Allowed; flag verified sales with transaction evidence | Unknown / unsupported |
| Developer transfers | Report separately; a transfer alone is not proof of a sale | Unknown / unsupported |
| Confirmed coordinated buying or bundles | Exclude | Unknown / unsupported |
| Suspected coordinated buying or bundles | Flag the suspicion, supporting observations and limitations | Unknown / unsupported |

“No suspicious activity” is interpreted through these explicit checks; it
must never become a guarantee of safety or an absence-of-risk claim.
Unknown required protection, developer holdings or buying-pattern checks block
qualification even if market cap is inside the range. Unavailable sales
history must be shown as unknown, never “the developer has never sold.”
No wallet connection or trade execution is involved.

## Definitions to validate before activation

Evidence work still needs to establish the supported pool types, liquidity
ownership/position coverage, genuine lock or burn transactions, unlock times,
reliable developer attribution and the transaction criteria for confirmed
coordination/bundles. A generic burn or a wallet connection alone is not proof.
The source's observation period, missing history, excluded wallets and
uncovered venues must be disclosed. Pool scope across multiple venues also
needs review once the evidence adapter is selected. Six-month date arithmetic
must be stated explicitly in the final measurable rule review.

The external-service budget is $0. No paid source or AI service is
authorised. Evaluate public/free sources first; do not enable billing or
paid fallback when a free endpoint is limited or unavailable. Required unavailable checks
must not be silently removed to make a demonstration return a match.

## Current implementation

The owner has confirmed live guided entry and a review containing all four
numeric conditions plus the extra requirements. No approval button appeared,
and the bot explained the unresolved-check block. Restart recovery and a
complete approved-rule flow remain to be confirmed in live testing.

The guided setup stores the numeric rules, but additional requirements
stay in an unresolved draft and prevent approval. A full natural-language
request can also be saved as unresolved; it is not automatically interpreted.
The offline regression tests verify that unsupported requirements block
approval and qualification. They use synthetic data and do not validate real
liquidity locks, developer activity, bundles or market accuracy.

Next milestones are evidence-provider evaluation, approved rule interpretation,
and one complete discovery-to-alert flow over a disclosed source. The
private Telegram welcome and manual CA delivery already work; automatic
searching and follow-up monitoring remain incomplete. Hosting is postponed.

See the [free-data integration plan](free-data-plan.md) for the next evidence work.
