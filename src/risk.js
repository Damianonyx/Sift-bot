import { createSolanaRpc } from './solana-rpc.js';
import { createLiquidityData } from './liquidity.js';
import { developerFromCreation, developerActivity, buyingEvidence } from './wallet-evidence.js';
import { unknown, txLink, accountLink, base58Bytes, successful } from './evidence-utils.js';

export const RISK_FIELDS = ['liquidityProtection', 'developerHolding', 'buyingCoordination'];
export const TEST_RISK_RULES = Object.freeze(RISK_FIELDS.map((field) => Object.freeze({ field, mode:'require', policy:'private-test-v1' })));
export const needsRisk = (rules) => rules?.some((r) => RISK_FIELDS.includes(r.field));

export function createRiskData({ rpc = createSolanaRpc(), liquidity = createLiquidityData({ rpc }), now = Date.now } = {}) {
  let busy = false, nextAt = 0;
  let health = { state:'not_checked', checkedAt:null };
  return {
    status: () => ({ ...health }),
    async check(snapshot, { signal, candidate } = {}) {
      const result = { address:snapshot.address, pool:snapshot.selected?.address ?? null, checkedAt:now(),
        liquidityProtection:unknown('Protection not verified.'), developerHolding:unknown('Developer attribution or balance not verified.'),
        buyingCoordination:unknown('Bundle and coordinated-buy coverage unavailable.'), events:[], warnings:[], coverage:[],
        history:'Sample only: up to 20 recent signatures per address, 40 creator/wallet/pool transaction reads plus 20 LP burn reads. Older history and other wallets/venues are not covered.' };
      if (busy || now() < nextAt || signal?.aborted || !result.pool) { result.warnings.push('Evidence check unavailable, limited, or no selected pool.'); return result; }
      busy = true; nextAt = now() + 60_000;
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
      const options = { signal:bounded };
      let reads = 0;
      const cache = new Map();
      // Wallet/pool transaction budget; the LP verifier separately permits 20 reads.
      const limitedRpc = Object.create(rpc);
      limitedRpc.transaction = async (signature, opts) => {
        if (!cache.has(signature)) {
          if (reads >= 40) throw new Error('Evidence budget');
          reads++;
          // Cache failed reads too: shared signatures cannot consume the budget twice.
          cache.set(signature, Promise.resolve().then(() => rpc.transaction(signature, opts)));
        }
        return cache.get(signature);
      };
      const history = async (address, role, reserve = 0) => {
        const report = { role, state:'sampled', returned:0, read:0, failed:0, missing:0, omitted:0 };
        result.coverage.push(report);
        const values = [];
        let rows;
        try { rows = await rpc.signatures(address, options); }
        catch { report.state = 'unavailable'; return values; }
        report.returned = rows.length;
        for (const [index, row] of rows.entries()) {
          if (row.err !== null) { report.failed++; continue; }
          if (!cache.has(row.signature) && reads >= 40 - reserve) { report.omitted++; continue; }
          if (bounded.aborted) { report.state = 'interrupted'; report.omitted += rows.length - index; break; }
          try {
            const tx = await limitedRpc.transaction(row.signature, options);
            if (successful(tx) && tx.slot === row.slot && tx.transaction.signatures?.[0] === row.signature) {
              values.push({ signature:row.signature, tx }); report.read++;
            } else report.missing++;
          } catch {
            // Keep already verified evidence; do not retry through a provider outage.
            report.missing++; report.state = 'interrupted'; report.omitted += rows.length - index - 1; break;
          }
        }
        return values;
      };
      try {
        try {
          // The liquidity service has its own bounded burn trace (20 reads).
          const evidence = await liquidity.check(snapshot, { ...options, verifyProtection:true });
          result.liquidityProtection = { ...(evidence.protection ?? unknown('Pool protection unsupported.')), observedAt:evidence.blockTime };
          result.liquiditySlot = evidence.slot;
        } catch { result.warnings.push('Liquidity source unavailable.'); }
        try {
          let creations = [];
          // A recent feed signature is only a locator. The finalized RPC response
          // must prove a successful, matching, signed creation for this exact mint.
          const hint = candidate?.address === snapshot.address && candidate.provenance?.find(p =>
            p.source === 'pumpportal' && p.kind === 'create' && Number.isSafeInteger(p.receivedAt) &&
            p.receivedAt <= now() && now() - p.receivedAt <= 20 * 60_000 && base58Bytes(p.signature,64)?.length === 64);
          if (hint) {
            result.creationLookup = 'Launch signature unverified; recent mint history used instead.';
            try {
              const tx = await limitedRpc.transaction(hint.signature,options);
              const wallet = tx?.transaction?.signatures?.[0] === hint.signature && developerFromCreation(tx,snapshot.address);
              if (wallet) { creations = [{ wallet, signature:hint.signature, tx }]; result.creationLookup = 'Launch signature verified against a finalized, signed creation.'; }
            } catch { /* A source label never substitutes for transaction proof. */ }
          }
          if (!creations.length) {
            const mintHistory = await history(snapshot.address,'Mint',20);
            creations = mintHistory.map((entry) => ({ ...entry, wallet:developerFromCreation(entry.tx,snapshot.address) })).filter((e) => e.wallet);
          }
          result.developerHolding = unknown(creations.length > 1 ? 'Creator attribution is ambiguous in the sampled transactions.' :
            'No supported signed creation was verified. Recent mint history may omit creation or be unavailable.');
          if (creations.length === 1) {
            const { wallet, signature, tx } = creations[0];
            result.developerHolding = unknown('Signing creator identified, but a current finalized token balance was not verified.');
            const balances = await rpc.tokenAccounts(wallet,snapshot.address,{ ...options, minContextSlot:tx.slot });
            const blockTime = await rpc.blockTime(balances.slot,options);
            if (blockTime === null || now() - blockTime > 120_000 || blockTime > now() + 30_000) throw new Error('Stale balance');
            const held = balances.accounts.reduce((sum,a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),0n);
            result.developerHolding = { state:held > 0n ? 'pass' : 'fail', wallet, amount:held.toString(), slot:balances.slot, observedAt:blockTime,
              reason:held > 0n ? 'The signing creator still holds tokens (raw units shown; not a percentage).' : 'The signing creator holds no tokens in the returned accounts.',
              links:[txLink(signature), accountLink(wallet)] };
            try {
              result.events = developerActivity(await history(wallet,'Creator',10),snapshot.address,wallet);
              if (result.events.some((e) => e.kind === 'sale')) result.warnings.push(held > 0n ? 'Verified developer sales; tokens still held. Partial sales are allowed and flagged.' : 'Verified developer sales; current holdings are zero.');
              if (result.events.some((e) => e.kind === 'transfer')) result.warnings.push('Developer transfers observed; a transfer alone is not proof of a sale.');
            } catch { result.warnings.push('Developer activity history unavailable.'); }
          }
        } catch { result.warnings.push('Developer attribution/balance source unavailable or incomplete.'); }
        try {
          result.buyingCoordination = buyingEvidence(await history(result.pool,'Pool'),snapshot.address,result.pool);
          result.warnings.push(...(result.buyingCoordination.suspicions ?? []));
        } catch { result.warnings.push('Buying-pattern history unavailable.'); }
        result.warnings.push('Developer sales/transfer history is incomplete; no claim of “never sold”.');
        result.checkedAt = now();
        for (const field of ['liquidityProtection','developerHolding']) {
          const evidence = result[field];
          if (evidence.state === 'pass' && (!Number.isFinite(evidence.observedAt) ||
              result.checkedAt - evidence.observedAt > 120_000 || evidence.observedAt > result.checkedAt + 30_000)) {
            result[field] = unknown('Underlying on-chain evidence is not current.');
          }
        }
        // Do not present earlier positive evidence as current after a long read.
        if (bounded.aborted || result.checkedAt - snapshot.fetchedAt > 120_000) {
          for (const field of RISK_FIELDS) if (result[field].state === 'pass') result[field] = unknown('Evidence check interrupted or market snapshot became stale.');
        }
        health = { state:RISK_FIELDS.some((f) => result[f].state === 'unknown') ? 'incomplete' : 'responded', checkedAt:result.checkedAt };
        return result;
      } finally { busy = false; }
    },
  };
}

export async function attachRisk(snapshot, risk, options) {
  try { return { ...snapshot, risk:await risk.check(snapshot,options) }; }
  catch { return { ...snapshot, risk:null }; }
}

export function formatRiskReport(result, { compact = false } = {}) {
  if (!result) return 'Risk evidence: UNKNOWN; required evidence cannot pass.';
  const labels = { liquidityProtection:'100% LP protection / six months remaining', developerHolding:'Developer still holds', buyingCoordination:'Bundles / coordinated buying' };
  const lines = compact ? [] : ['Sift · Risk evidence', `Solana CA: ${result.address}`, `Selected pool: ${result.pool ?? 'unknown'}`];
  for (const field of RISK_FIELDS) {
    const item = result[field] ?? unknown('Not verified.');
    lines.push(`${item.state.toUpperCase()} · ${labels[field]}${compact ? '' : '\n' + item.reason}`);
    if (!compact) lines.push(...item.links.slice(0,2));
  }
  if (!compact && result.developerHolding.wallet) lines.push(`Signing creator: ${result.developerHolding.wallet}\nCurrent holdings (raw units): ${result.developerHolding.amount}`);
  if (compact) lines.push(result.events.some((e) => e.kind === 'sale') ? 'FLAG · Developer sales observed; partial sales allowed while holdings remain.' : 'Developer sales history incomplete.');
  else {
    lines.push(...result.events.slice(0,3).map((e) => `${e.kind.toUpperCase()} · ${e.amount} raw token units\n${e.link}`));
    lines.push(...result.warnings, result.creationLookup,
      ...(result.coverage?.length ? ['Transaction sample (not complete history):\n' + result.coverage.map(c =>
        `${c.role}: ${c.state}; ${c.read}/${c.returned} verified, ${c.failed} failed, ${c.missing} missing/invalid, ${c.omitted} omitted.`).join('\n')] : []), result.history,
      'Scope: selected pool only; Pump create/create_v2 signing creator and direct PumpSwap trades. Bonding-curve sales, other attribution/venues and unfamiliar layouts remain unknown. Six months = UTC calendar months, clamped to month-end.',
      `Checked: ${new Date(result.checkedAt).toISOString()}. Public finalized RPC; no paid fallback.\nUnknown required checks block qualification. Saved rules and scan state are unchanged.`);
  }
  return lines.filter(Boolean).join('\n\n');
}
