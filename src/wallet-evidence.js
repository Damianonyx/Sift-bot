import { isSolanaAddress } from './market.js';
import { PUMPSWAP } from './pumpswap-liquidity.js';
import { publicKeyString } from './raydium-liquidity.js';
import { base58Bytes, instructionIs, instructions, successful, signer, rawAmount, TOKEN_PROGRAMS, txLink, unknown } from './evidence-utils.js';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const SYSTEM = '11111111111111111111111111111111';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function supportedFeeCall(ix, parent, side) {
  // Pinned Pump fee IDL: read-only get_fees / get_fees_with_quote_mint.
  // Bind both accounts to this trade, and allow only a direct CPI. Never
  // whitelist every call to a fee program or arbitrary nested token routes.
  const configIndex = side === 'sale' ? 19 : 21;
  if (ix.programId !== PUMP_FEE || ix.stackHeight !== 2 ||
      parent[configIndex + 1] !== PUMP_FEE || !isSolanaAddress(parent[configIndex]) ||
      ix.accounts?.length !== 2 || ix.accounts[0] !== parent[configIndex] || ix.accounts[1] !== PUMPSWAP) return false;
  const bytes = base58Bytes(ix.data);
  if (!bytes || bytes[8] > 1) return false;
  if (instructionIs(ix, PUMP_FEE, 'get_fees')) {
    // Legacy payload predates the final OptionBool wrapper (a single bool).
    return bytes.length === 33 || bytes.length === 34 && bytes[33] <= 1;
  }
  return instructionIs(ix, PUMP_FEE, 'get_fees_with_quote_mint') && bytes.length === 57 &&
    publicKeyString(bytes.subarray(25, 57)) === parent[4];
}

export function developerFromCreation(tx, mint) {
  if (!successful(tx)) return null;
  const found = new Set();
  for (const ix of instructions(tx)) {
    // Account/argument layouts pinned to pump-public-docs 639b87fb (idl/pump.json).
    // Fee recipients, metadata authorities and delegated creators are not proof
    // of the signing creator. Unfamiliar layouts remain unknown.
    const v2 = instructionIs(ix, PUMP, 'create_v2');
    if (!v2 && !instructionIs(ix, PUMP, 'create')) continue;
    const a = ix.accounts;
    if (!Array.isArray(a) || a.length !== (v2 ? 16 : 14) || a[0] !== mint || !a.every(isSolanaAddress)) continue;
    if (v2 ? a[6] !== SYSTEM || a[7] !== TOKEN_PROGRAMS[1] || a[8] !== ASSOCIATED_TOKEN ||
        a[9] !== 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e' || a[15] !== PUMP :
      a[5] !== 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' || a[8] !== SYSTEM ||
        a[9] !== TOKEN_PROGRAMS[0] || a[10] !== ASSOCIATED_TOKEN ||
        a[11] !== 'SysvarRent111111111111111111111111111111111' || a[13] !== PUMP) continue;
    const bytes = base58Bytes(ix.data);
    let cursor = 8, valid = true;
    for (let i = 0; i < 3; i++) {
      if (cursor + 4 > bytes.length) { valid = false; break; }
      const length = bytes.readUInt32LE(cursor); cursor += 4;
      if (length > 1024 || cursor + length > bytes.length) { valid = false; break; }
      cursor += length;
    }
    // Current v2 tail: bool, OptionBool(bool), OptionU64(u64), OptionBool(bool).
    // The IDL wrappers are structs, not Borsh Option tags. Other tails are unknown.
    if (!valid || cursor + 32 + (v2 ? 11 : 0) !== bytes.length) continue;
    if (v2 && [cursor + 32, cursor + 33, cursor + 42].some(i => bytes[i] > 1)) continue;
    const creator = publicKeyString(bytes.subarray(cursor, cursor + 32));
    if (creator === a[v2 ? 5 : 7] && signer(tx, creator) && signer(tx, mint) && isSolanaAddress(creator)) found.add(creator);
  }
  return found.size === 1 ? [...found][0] : null;
}

function transferAmount(ix, source, destination, mint) {
  const info = ix.parsed?.info;
  if (!TOKEN_PROGRAMS.includes(ix.programId) || !['transfer','transferChecked'].includes(ix.parsed?.type) ||
      info?.source !== source || info?.destination !== destination || (info.mint && info.mint !== mint)) return 0n;
  const amount = info.amount ?? info.tokenAmount?.amount;
  return rawAmount(amount) ? BigInt(amount) : 0n;
}
function balanceHasOwner(tx, address, owner, mint) {
  const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === address);
  return index >= 0 && [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
    .some((b) => b.accountIndex === index && b.owner === owner && b.mint === mint && rawAmount(b.uiTokenAmount?.amount));
}

export function pumpSwapTrades(tx, mint, pool = null) {
  if (!successful(tx)) return [];
  const trades = [];
  // Top-level trades only: matching inner token transfers must belong to this
  // exact invocation. Aggregators/unknown CPI nesting are not guessed as sales.
  tx.transaction.message.instructions.forEach((ix, index) => {
    const side = instructionIs(ix, PUMPSWAP, 'sell') ? 'sale' :
      ['buy','buy_exact_quote_in'].some((n) => instructionIs(ix, PUMPSWAP, n)) ? 'buy' : null;
    const a = ix.accounts;
    if (!side || !Array.isArray(a) || a.length < 17 || a[3] !== mint || (pool && a[0] !== pool) ||
      !a.slice(0,9).every(isSolanaAddress) || new Set(a.slice(3,9)).size !== 6 || !signer(tx,a[1]) ||
      !balanceHasOwner(tx,a[5],a[1],mint) || !balanceHasOwner(tx,a[6],a[1],a[4]) ||
      !balanceHasOwner(tx,a[7],a[0],mint) || !balanceHasOwner(tx,a[8],a[0],a[4])) return;
    const inner = tx.meta.innerInstructions?.find((g) => g.index === index)?.instructions ?? [];
    // Reject nested unknown calls; prevents attributing unrelated routed flows.
    if (inner.some((i) => !TOKEN_PROGRAMS.includes(i.programId) &&
        !(i.programId === PUMPSWAP && i.stackHeight === 2) && !supportedFeeCall(i, a, side))) return;
    const base = inner.reduce((sum,i) => sum + transferAmount(i, side === 'sale' ? a[5] : a[7], side === 'sale' ? a[7] : a[5], mint),0n);
    const quote = inner.reduce((sum,i) => sum + transferAmount(i, side === 'sale' ? a[8] : a[6], side === 'sale' ? a[6] : a[8], a[4]),0n);
    if (base > 0n && quote > 0n) trades.push({ side, wallet:a[1], pool:a[0], baseAmount:base.toString(), quoteAmount:quote.toString(), instruction:index });
  });
  return trades;
}

export function developerActivity(transactions, mint, developer) {
  const events = [];
  for (const { signature, tx } of transactions) {
    if (!successful(tx)) continue;
    const sales = pumpSwapTrades(tx,mint).filter((t) => t.wallet === developer && t.side === 'sale');
    for (const sale of sales) events.push({ kind:'sale', amount:sale.baseAmount, link:txLink(signature), slot:tx.slot });
    // Report remaining outgoing transfers separately. They can be gifts,
    // deposits or routed swaps; token movement alone is never a verified sale.
    const saleGroups = new Set(sales.map((s) => s.instruction));
    const other = [...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).filter((g) => !saleGroups.has(g.index)).flatMap((g) => g.instructions)];
    for (const ix of other) {
      const info = ix.parsed?.info;
      if (!info || !balanceHasOwner(tx,info.source,developer,mint)) continue;
      const amount = transferAmount(ix,info.source,info.destination,mint);
      if (amount > 0n) events.push({ kind:'transfer', amount:amount.toString(), link:txLink(signature), slot:tx.slot });
    }
  }
  return events;
}

export function buyingEvidence(transactions, mint, pool) {
  const slots = new Map();
  for (const { signature, tx } of transactions) {
    const buyers = new Set(pumpSwapTrades(tx,mint,pool).filter((t) => t.side === 'buy').map((t) => t.wallet));
    if (buyers.size >= 2) return { state:'fail', confirmed:true,
      reason:'Multiple distinct signing buyers executed verified buys in one atomic transaction.', links:[txLink(signature)], suspicions:[] };
    for (const buyer of buyers) {
      const group = slots.get(tx.slot) ?? { buyers:new Set(), links:[] };
      group.buyers.add(buyer); group.links.push(txLink(signature)); slots.set(tx.slot,group);
    }
  }
  const suspect = [...slots.values()].find((g) => g.buyers.size >= 2);
  return { ...unknown('Bundle membership and full buying history are unavailable; absence of observed coordination is not a passed check.'),
    confirmed:false, suspicions:suspect ? ['Distinct buyers bought in the same finalized slot; timing alone does not confirm coordination or a bundle.'] : [],
    links:suspect?.links ?? [] };
}
