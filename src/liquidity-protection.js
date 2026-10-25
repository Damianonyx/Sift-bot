import { publicKeyBytes, TOKEN_PROGRAM } from './raydium-liquidity.js';
import { STREAMFLOW, TOKEN_PROGRAMS, accountBytes, keyAt, matchesPda, sixMonthsAfter,
  unknown, rawAmount, instructions, successful, txLink, accountLink } from './evidence-utils.js';

// Deliberately narrow Streamflow subset: original metadata, classic SPL LP,
// fixed cliff, no fees, cancellation, top-ups, transfers, pausing or rate edits.
// Every live claim must be accounted for in one finalized contextual read.
export function streamEscrow(account) {
  return keyAt(accountBytes(account, STREAMFLOW, 1104), 209);
}
export function verifyStreamLock(metadata, address, escrowAccount, mint, checkedAt) {
  const d = accountBytes(metadata, STREAMFLOW, 1104);
  const u64 = (offset) => d.readBigUInt64LE(offset);
  const escrow = keyAt(d, 209);
  if (keyAt(d, 177) !== mint || !matchesPda(escrow, STREAMFLOW, [Buffer.from('strm'), publicKeyBytes(address)])) throw new Error('Lock linkage');
  // A nonzero state prefix and creation time are required; these are raw
  // program-owned metadata, not an Anchor discriminator (see pinned Rust SDK).
  if (u64(0) === 0n || u64(9) === 0n || u64(9) * 1000n > BigInt(checkedAt) || u64(417) === 0n || u64(425) === 0n ||
      u64(449) !== u64(417) || u64(441) < u64(409) || u64(33) < u64(441)) throw new Error('Lock schedule');
  for (const offset of [17,25,41,305,313,389,397,433,527,672,680,688,696]) if (u64(offset) !== 0n) throw new Error('Unsupported lock feature');
  // Reject fee percentages, every control flag, unknown padding, migrated
  // metadata, newer fee-partner/cancel-request state and nonzero future tails.
  for (const [start,end] of [[321,325],[405,409],[457,463],[535,672],[714,746],[779,1104]]) {
    if (d.subarray(start,end).some(Boolean)) throw new Error('Unsupported lock feature');
  }
  const tokens = accountBytes(escrowAccount, TOKEN_PROGRAM, 165);
  if (keyAt(tokens,0) !== mint || keyAt(tokens,32) !== escrow || tokens[108] !== 1 ||
      tokens.readUInt32LE(72) !== 0 || tokens.readUInt32LE(109) !== 0 || tokens.readUInt32LE(129) !== 0 ||
      tokens.readBigUInt64LE(64) !== u64(417)) throw new Error('Lock custody');
  const unlock = u64(441) * 1000n;
  return { amount: u64(417), meetsDuration: unlock >= BigInt(sixMonthsAfter(checkedAt)),
    unlockAt: unlock <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(unlock) : null,
    links: [accountLink(address), accountLink(escrow)] };
}

export function verifiedBurn(tx, mint, tokenProgram) {
  if (!successful(tx)) return false;
  return instructions(tx).some((ix) => {
    const info = ix.parsed?.info;
    const amount = info?.amount ?? info?.tokenAmount?.amount;
    return TOKEN_PROGRAMS.includes(tokenProgram) && ix.programId === tokenProgram &&
      ['burn', 'burnChecked'].includes(ix.parsed?.type) && info?.mint === mint && rawAmount(amount) && BigInt(amount) > 0n;
  });
}

export async function verifyLiquidityProtection({ rpc, pool, snapshotSlot, observation, lpProgram, readLinked, now, signal }) {
  const unsupportedMode = () => unknown('Boosted PumpSwap protection is not supported. Account balances and zero LP supply do not establish protection for this mode.');
  if (observation.protectionUnsupported) return unsupportedMode();
  if (observation.outstandingLp === '0') {
    const rows = await rpc.signatures(pool.lpMint, { signal });
    for (const row of rows) {
      if (row.err !== null || row.slot > snapshotSlot) continue;
      const tx = await rpc.transaction(row.signature, { signal });
      if (tx?.slot === row.slot && verifiedBurn(tx, pool.lpMint, lpProgram)) {
        return { state: 'pass', kind: 'burn', protectedPercent: 100,
          reason: 'Verified LP burn and zero outstanding LP at the checked slot; no live LP redemption claims remain.', links: [txLink(row.signature)] };
      }
    }
    return unknown('No verified LP burn in the bounded history. Zero supply alone is insufficient.');
  }
  const streams = await rpc.streams(pool.lpMint, { signal, minContextSlot: snapshotSlot });
  const candidates = [];
  for (const row of streams.accounts) {
    try { candidates.push({ address: row.pubkey, escrow: streamEscrow(row.account) }); } catch { /* Unknown candidates cannot contribute coverage. */ }
  }
  if (!candidates.length) return unknown('No supported LP lock found; other lockers and LP holders are unverified.');
  if (new Set(candidates.map((c) => c.escrow)).size !== candidates.length) return unknown('Duplicate escrow claims.');
  const addresses = candidates.flatMap((c) => [c.address, c.escrow]);
  const final = await readLinked(addresses, streams.slot);
  if (final.observation.protectionUnsupported) return unsupportedMode();
  if (final.observation.outstandingLp === '0') return unknown('LP supply changed; repeat the burn verification.');
  let protectedAmount = 0n, shortAmount = 0n;
  const links = [], unlocks = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const lock = verifyStreamLock(final.extra[i*2], candidates[i].address, final.extra[i*2+1], pool.lpMint, now());
      if (lock.meetsDuration) { protectedAmount += lock.amount; links.push(...lock.links); unlocks.push(lock.unlockAt); }
      else shortAmount += lock.amount;
    } catch { /* Incomplete, mutable or unfamiliar locks stay unverified. */ }
  }
  const supply = BigInt(final.observation.outstandingLp);
  if (protectedAmount > supply || protectedAmount + shortAmount > supply) return unknown('Inconsistent or duplicate LP coverage.');
  if (protectedAmount === supply) return { state: 'pass', kind: 'lock', protectedPercent: 100,
    reason: 'Every outstanding LP unit is in a verified fixed-cliff lock with six calendar months remaining.',
    unlockAt: unlocks.every((v) => v !== null) ? Math.min(...unlocks) : null, links };
  if (shortAmount > 0n) return { state: 'fail', reason: 'Some outstanding LP unlocks before the six-month deadline.', links: [] };
  return unknown('Less than 100% of outstanding LP is verified protected; uncovered claims cannot pass.');
}
