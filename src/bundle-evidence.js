import { createSolanaRpc } from './solana-rpc.js';
import { base58Bytes, unknown, txLink } from './evidence-utils.js';
import { pumpSwapTrades } from './wallet-evidence.js';

const URL = 'https://mainnet.block-engine.jito.wtf/api/v1/getBundleStatuses';
export const isBundleId = (id) => typeof id === 'string' && (/^[a-f0-9]{64}$/.test(id) || base58Bytes(id,32)?.length === 32);

// Read-only verification of a supplied ID. Jito does not offer an exhaustive
// mint-to-bundle search here. A missing/null status never means bundle-free.
export function createBundleData({ fetchImpl = fetch, rpc = createSolanaRpc(), now = Date.now } = {}) {
  let busy = false, nextAt = 0;
  return {
    async check(snapshot, bundleId, { signal } = {}) {
      const missing = () => unknown('Bundle membership could not be verified. Missing or expired status is not proof of no bundle.');
      if (!isBundleId(bundleId) || !snapshot.selected || busy || now() < nextAt || signal?.aborted) return missing();
      busy = true; nextAt = now()+60_000;
      const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
      try {
        const response = await fetchImpl(URL,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',signal:bounded,
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBundleStatuses',params:[[bundleId]]})});
        if (!response.ok) {
          if (response.status === 429) {
            const value=response.headers.get('retry-after');
            const retry=/^\d+$/.test(value ?? '') ? Number(value)*1000 : Date.parse(value)-now();
            if (Number.isFinite(retry) && retry>0) nextAt=Math.max(nextAt,now()+retry);
          }
          await response.body?.cancel(); return missing();
        }
        const reader=response.body?.getReader(); if (!reader) return missing();
        const chunks=[];let size=0;
        try {
          while(true) {
            const {done,value}=await reader.read();if(done)break;
            size+=value.byteLength;if(size>32*1024){await reader.cancel();return missing();}chunks.push(value);
          }
        } finally {reader.releaseLock();}
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const rows=payload?.result?.value;
        if(payload.jsonrpc!=='2.0' || payload.id!==1 || payload.error || !Array.isArray(rows) || rows.length!==1) return missing();
        const row=rows[0];
        if(row?.bundle_id!==bundleId || row.confirmation_status!=='finalized' || row.err?.Ok!==null || Object.keys(row.err).length!==1 ||
          !Number.isSafeInteger(row.slot) || row.slot<0 || !Array.isArray(row.transactions) || row.transactions.length<1 || row.transactions.length>5 ||
          new Set(row.transactions).size!==row.transactions.length || row.transactions.some(s=>base58Bytes(s,64)?.length!==64)) return missing();
        const links=[];
        for(const signature of row.transactions) {
          const tx=await rpc.transaction(signature,{signal:bounded});
          if(!tx || tx.slot!==row.slot || tx.meta?.err!==null) return missing();
          if(pumpSwapTrades(tx,snapshot.address,snapshot.selected.address).some(t=>t.side==='buy'))links.push(txLink(signature));
        }
        if(bounded.aborted || !links.length) return missing();
        return {state:'fail',confirmed:true,reason:'Jito reports a finalized bundle containing a verified buy in the selected pool. Excluded by your no-bundles policy; intent is not inferred.',
          links:[`https://explorer.jito.wtf/bundle/${bundleId}`,...links]};
      } catch { return missing(); }
      finally {busy=false;}
    },
  };
}
