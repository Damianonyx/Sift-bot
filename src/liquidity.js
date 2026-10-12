import { isSolanaAddress } from './market.js';
import { createSolanaRpc, RPC_URL, SolanaRpcError } from './solana-rpc.js';
import { decodeRaydiumPool, observeLpAccounts, LiquidityEvidenceError, RAYDIUM_V4 } from './raydium-liquidity.js';

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
  SOURCE_UNAVAILABLE: 'Solana RPC was unavailable or denied access.',
  INVALID_RESPONSE: 'Solana RPC did not return a usable response.',
  NETWORK_OR_RESPONSE: 'Solana RPC could not be reached or read.',
};

export function createLiquidityData({ rpc = createSolanaRpc(), now = Date.now } = {}) {
  let inFlight = false, nextAllowedAt = 0;
  let health = { state: 'not_checked', checkedAt: null };
  return {
    status: () => ({ ...health }),
    async check(snapshot, { signal } = {}) {
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
        const initial = decodeRaydiumPool(first.accounts[0], snapshot.address);
        const addresses = [result.pool, initial.lpMint, initial.baseVault, initial.quoteVault];
        const final = await rpc.accounts(addresses, { signal, minContextSlot: first.slot });
        const pool = decodeRaydiumPool(final.accounts[0], snapshot.address);
        if (['lpMint', 'baseVault', 'quoteVault', 'baseMint', 'quoteMint', 'authority'].some((key) => initial[key] !== pool[key])) {
          throw new LiquidityEvidenceError('POOL_CHANGED');
        }
        result.slot = final.slot; result.lpMint = pool.lpMint;
        result.observation = observeLpAccounts(pool, final.accounts.slice(1));
        let timeUnavailable = false;
        try {
          result.blockTime = await rpc.blockTime(final.slot, { signal });
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
    'Overall liquidity protection: UNKNOWN. This report cannot pass a required protection check.'];
  if (result.pool) lines.push(`Selected pool: ${result.pool}\nCoverage: one DEX Screener-selected pool from ${result.poolCount} supported market pools; other pools are not assessed. ${result.selection === 'reported_liquidity' ? 'Selected by highest known reported USD liquidity.' : 'Unranked fallback; pool liquidity amounts were unknown.'}`);
  if (result.reason) lines.push(REASONS[result.reason] ?? 'Required on-chain evidence could not be verified.');
  if (result.program) lines.push(`Pool program: ${result.program === RAYDIUM_V4 ? 'Raydium classic AMM v4' : 'unsupported'}\nProgram evidence: https://solscan.io/account/${result.program}`);
  if (result.observation) {
    const observation = result.observation;
    const units = observation.outstandingLp.padStart(observation.lpDecimals + 1, '0');
    const quantity = observation.lpDecimals ? `${units.slice(0, -observation.lpDecimals)}.${units.slice(-observation.lpDecimals)}` : units;
    lines.push(`LP ownership tokens outstanding: ${quantity}`);
    lines.push(observation.noOutstandingLp ? 'Observed: the LP mint has zero outstanding supply at this slot. The pool and its linked vaults passed the supported account checks.' :
      'Observed: LP tokens remain outstanding. They may be held by wallets or lockers; this check does not establish which.');
    lines.push('Burn history: unknown. Supply differences can include an unissued protocol minimum; they are not labelled as burned liquidity. No burn transaction was traced.');
  }
  lines.push('Verified lock percentage: unknown.\nUnlock time / six months remaining: unknown.\n100% protected across pools: unknown.\nTimed lockers, concentrated-liquidity positions and other pool programs are unsupported.');
  if (result.slot !== null) lines.push(`On-chain snapshot: finalized slot ${result.slot}\nEstimated block time: ${result.blockTime === null ? 'unknown' : new Date(result.blockTime).toISOString()}\nSnapshot freshness: ${result.freshness}${result.freshness === 'recent' ? ' (within two minutes of retrieval; not a future guarantee)' : ' — do not treat this as current verified protection'}.`);
  lines.push(`Market pool selected at: ${new Date(result.marketFetchedAt).toISOString()}\nEvidence check completed: ${new Date(result.fetchedAt).toISOString()}\nNo Sift cache.${result.pool ? ` RPC source: ${result.sourceUrl}` : ' No RPC request was made because no pool was selected.'}`);
  if (result.pool) lines.push(`Pool evidence: https://solscan.io/account/${result.pool}`);
  if (result.lpMint) lines.push(`LP mint evidence: https://solscan.io/account/${result.lpMint}`);
  lines.push('Manual evidence only. Your saved rules and scan state are unchanged. Developer activity and bundles are not checked here.');
  return lines.join('\n\n');
}
