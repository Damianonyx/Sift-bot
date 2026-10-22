import { isSolanaAddress } from './market.js';
import { createSolanaRpc, RPC_URL, SolanaRpcError, rpcFailureReason } from './solana-rpc.js';
import { decodeRaydiumPool, observeLpAccounts, LiquidityEvidenceError, RAYDIUM_V4 } from './raydium-liquidity.js';
import { decodePumpSwapPool, observePumpSwapLp, PUMPSWAP } from './pumpswap-liquidity.js';
import { verifyLiquidityProtection } from './liquidity-protection.js';
import { unknown } from './evidence-utils.js';

const READERS = new Map([
  [RAYDIUM_V4, { name: 'Raydium classic AMM v4', decode: decodeRaydiumPool, observe: observeLpAccounts }],
  [PUMPSWAP, { name: 'PumpSwap', decode: decodePumpSwapPool, observe: observePumpSwapLp }],
]);

const REASONS = {
  NO_POOL: 'No supported market pool was returned for this CA.',
  UNSUPPORTED_POOL: 'This pool program is not supported by the current liquidity reader. It does not mean the pool is unlocked.',
  MISSING_ACCOUNT: 'A required on-chain account was missing.',
  POOL_NOT_TRADING: 'This Raydium pool is not in a supported active trading state.',
  TOKEN_POOL_MISMATCH: 'The on-chain pool did not contain the requested token.',
  ACCOUNT_LAYOUT: 'The account layout did not match the supported format.',
  ACCOUNT_OWNER: 'An account owner or executable flag did not match the expected program.',
  LP_MINT_AUTHORITY: 'The LP mint did not have the expected initialization and authority settings.',
  VAULT_AUTHORITY: 'A pool vault did not have the expected mint, authority or permissions.',
  INCONSISTENT_LP_SUPPLY: 'The LP mint supply exceeded the pool’s recorded LP amount.',
  EMPTY_VAULT: 'A pool vault had no token balance; protection was not assessed.',
  POOL_CHANGED: 'The pool’s linked accounts changed during the check. Retry later.',
  POOL_ADDRESS: 'The pool or LP mint address did not match the documented program seeds.',
  UNSUPPORTED_POOL_MODE: 'This pool uses an unsupported mode or virtual-reserve configuration.',
  UNSUPPORTED_TOKEN_EXTENSION: 'A Token-2022 extension is not supported by this reader; protection remains unknown.',
  SOURCE_UNAVAILABLE: 'Solana RPC was unavailable or denied access.',
  INVALID_RESPONSE: 'Solana RPC did not return a usable response.',
  NETWORK_OR_RESPONSE: 'Solana RPC could not be reached or read.',
  TIMED_OUT: 'Solana RPC request timed out.',
};
export const liquidityFailureReason = code => Object.hasOwn(REASONS, code)
  ? REASONS[code] : 'Required on-chain liquidity evidence could not be verified.';

export function createLiquidityData({ rpc = createSolanaRpc(), now = Date.now } = {}) {
  let inFlight = false, nextAllowedAt = 0;
  let health = { state: 'not_checked', checkedAt: null };
  return {
    status: () => ({ ...health }),
    async check(snapshot, { signal, verifyProtection = false } = {}) {
      if (signal?.aborted) throw new SolanaRpcError('STOPPED');
      if (!isSolanaAddress(snapshot?.address) || (snapshot.selected && !isSolanaAddress(snapshot.selected.address))) throw new LiquidityEvidenceError('INVALID_ADDRESS');
      if (inFlight || now() < nextAllowedAt) throw new SolanaRpcError('COOLDOWN', Math.max(1, Math.ceil((nextAllowedAt - now()) / 1000)));
      const result = { address: snapshot.address, pool: snapshot.selected?.address ?? null,
        marketFetchedAt: snapshot.fetchedAt, poolCount: snapshot.poolCount, selection: snapshot.selection,
        fetchedAt: now(), sourceUrl: RPC_URL, slot: null, blockTime: null, freshness: 'unknown',
        program: null, lpMint: null, observation: null, reason: null, protectionRequirement: 'unknown' };
      if (!result.pool) return { ...result, reason: 'NO_POOL' };
      inFlight = true; nextAllowedAt = now() + 30_000;
      try {
        const first = await rpc.accounts([result.pool], { signal });
        result.slot = first.slot;
        result.program = first.accounts[0]?.owner ?? null;
        const reader = READERS.get(result.program);
        if (!reader) throw new LiquidityEvidenceError(first.accounts[0] ? 'UNSUPPORTED_POOL' : 'MISSING_ACCOUNT');
        const initial = reader.decode(first.accounts[0], snapshot.address, result.pool);
        const addresses = [result.pool, initial.lpMint, initial.baseVault, initial.quoteVault];
        const final = await rpc.accounts(addresses, { signal, minContextSlot: first.slot });
        const pool = reader.decode(final.accounts[0], snapshot.address, result.pool);
        if (['lpMint', 'baseVault', 'quoteVault', 'baseMint', 'quoteMint', 'authority'].some((key) => initial[key] !== pool[key])) {
          throw new LiquidityEvidenceError('POOL_CHANGED');
        }
        result.slot = final.slot; result.lpMint = pool.lpMint;
        result.observation = reader.observe(pool, final.accounts.slice(1));
        if (verifyProtection) {
          try {
            result.protection = await verifyLiquidityProtection({ rpc, pool, snapshotSlot: final.slot,
              observation: result.observation, lpProgram: final.accounts[1].owner, now, signal,
              readLinked: async (extra, minContextSlot) => {
                const reread = await rpc.accounts([...addresses, ...extra], { signal, minContextSlot });
                const current = reader.decode(reread.accounts[0], snapshot.address, result.pool);
                if (['lpMint','baseVault','quoteVault','baseMint','quoteMint','authority'].some((k) => current[k] !== pool[k])) throw new LiquidityEvidenceError('POOL_CHANGED');
                result.slot = reread.slot;
                result.observation = reader.observe(current, reread.accounts.slice(1,4));
                return { observation: result.observation, extra: reread.accounts.slice(4) };
              } });
          } catch (error) {
            result.protection = unknown(error instanceof LiquidityEvidenceError
              ? liquidityFailureReason(error.code) : rpcFailureReason(error));
          }
        }
        let timeUnavailable = false;
        try {
          result.blockTime = await rpc.blockTime(result.slot, { signal });
          if (result.blockTime !== null) {
            const age = now() - result.blockTime;
            result.freshness = age < -30_000 ? 'future' : age > 120_000 ? 'stale' : 'recent';
          }
        } catch {
          // Keep the snapshot facts, but do not equate retrieval time with chain time.
          result.freshness = 'unknown';
          timeUnavailable = true;
        }
        if (signal?.aborted) throw new SolanaRpcError('STOPPED');
        result.fetchedAt = now();
        if (result.protection) {
          if (result.freshness !== 'recent') result.protection = unknown('The on-chain snapshot is not current.');
          result.protectionRequirement = result.protection.state;
        }
        health = { state: timeUnavailable ? 'unavailable' : 'responded', checkedAt: result.fetchedAt };
        return result;
      } catch (error) {
        if (signal?.aborted) throw new SolanaRpcError('STOPPED');
        if (error instanceof SolanaRpcError && error.code === 'RATE_LIMITED') {
          nextAllowedAt = Math.max(nextAllowedAt, now() + error.retryAfter * 1000);
          health = { state: 'unavailable', checkedAt: now() };
          throw error;
        }
        result.reason = error instanceof LiquidityEvidenceError || error instanceof SolanaRpcError ? error.code : 'INVALID_RESPONSE';
        result.fetchedAt = now(); result.observation = null;
        health = { state: error instanceof LiquidityEvidenceError ? 'responded' : 'unavailable', checkedAt: result.fetchedAt };
        return result;
      } finally { inFlight = false; }
    },
  };
}

export function formatLiquidityReport(result) {
  const lines = ['Sift · Liquidity evidence check', `Solana CA: ${result.address}`,
    `Overall liquidity protection: ${(result.protectionRequirement ?? 'unknown').toUpperCase()}.${result.protectionRequirement === 'pass' ? ' Selected-pool LP claims only; other pools are not assessed.' : ' This report cannot pass a required protection check.'}`];
  if (result.protection) {
    lines.push(result.protection.reason);
    lines.push(...result.protection.links.slice(0,3));
  }
  if (result.pool) lines.push(`Selected pool: ${result.pool}\nCoverage: one DEX Screener-selected pool from ${result.poolCount} supported market pools; other pools are not assessed. ${result.selection === 'reported_liquidity' ? 'Selected by highest known reported USD liquidity.' : 'Unranked fallback; pool liquidity amounts were unknown.'}`);
  if (result.reason) lines.push(liquidityFailureReason(result.reason));
  if (result.program) lines.push(`Pool program: ${READERS.get(result.program)?.name ?? 'unsupported'}\nProgram evidence: https://solscan.io/account/${result.program}`);
  if (result.observation) {
    const observation = result.observation;
    const units = observation.outstandingLp.padStart(observation.lpDecimals + 1, '0');
    const quantity = observation.lpDecimals ? `${units.slice(0, -observation.lpDecimals)}.${units.slice(-observation.lpDecimals)}` : units;
    lines.push(`LP ownership tokens outstanding: ${quantity}`);
    lines.push(observation.noOutstandingLp ? 'Observed: the LP mint has zero outstanding supply at this slot. The pool and its linked vaults passed the supported account checks.' :
      'Observed: LP tokens remain outstanding. They may be held by wallets or lockers; this check does not establish which.');
    lines.push(result.protection?.kind === 'burn' ? 'Burn evidence: a successful LP burn instruction was verified. Current LP supply is zero. This does not infer a burn percentage from a supply difference.' : result.program === PUMPSWAP ? 'Burn history: unknown. The pool’s recorded LP amount and the current mint supply can differ. Supply differences are not labelled burns.' :
      'Burn history: unknown. Supply differences can include an unissued protocol minimum; they are not labelled as burned liquidity. No burn transaction was traced.');
  }
  lines.push(result.protection?.kind === 'lock' ? `100% of outstanding LP is in verified fixed-cliff custody.\nEarliest unlock: ${result.protection.unlockAt === null ? 'beyond supported display range' : new Date(result.protection.unlockAt).toISOString()}.\nAt least six UTC calendar months remain (month-end clamped).` : 'Verified lock percentage / unlock time: unknown or not applicable to verified burns.');
  lines.push('100% protected across all pools: unknown. Only supported Raydium/PumpSwap LP claims are assessed. Fixed, noncancelable Streamflow classic-SPL locks are supported; other lockers, positions and pool programs are unknown. Program upgrades are outside this snapshot guarantee.');
  if (result.slot !== null) lines.push(`On-chain snapshot: finalized slot ${result.slot}\nEstimated block time: ${result.blockTime === null ? 'unknown' : new Date(result.blockTime).toISOString()}\nSnapshot freshness: ${result.freshness}${result.freshness === 'recent' ? ' (within two minutes of retrieval; not a future guarantee)' : ' — do not treat this as current verified protection'}.`);
  lines.push(`Market pool selected at: ${new Date(result.marketFetchedAt).toISOString()}\nEvidence check completed: ${new Date(result.fetchedAt).toISOString()}\nNo Sift cache.${result.pool ? ` RPC source: ${result.sourceUrl}` : ' No RPC request was made because no pool was selected.'}`);
  if (result.pool) lines.push(`Pool evidence: https://solscan.io/account/${result.pool}`);
  if (result.lpMint) lines.push(`LP mint evidence: https://solscan.io/account/${result.lpMint}`);
  lines.push('Manual evidence only. Your saved rules and scan state are unchanged. Developer activity and bundles are not checked here.');
  return lines.join('\n\n');
}

