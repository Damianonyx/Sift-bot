import { createMarketData, isSolanaAddress } from '../src/market.js';
import { createSolanaRpc } from '../src/solana-rpc.js';
import { createLiquidityData } from '../src/liquidity.js';
import { createRiskData } from '../src/risk.js';

// Public, read-only evidence only. This script does not load .env, open saved
// strategies, send Telegram messages or purchase/activate any data service.
const [address,...extra]=process.argv.slice(2);
if(!isSolanaAddress(address)||extra.length) {
  console.error('Usage: npm run check:risk -- SOLANA_CA');process.exitCode=1;
} else {
  const deadline=setTimeout(()=>{console.error('Risk observation incomplete: process deadline.');process.exit(2);},60_000);
  try {
    const signal=AbortSignal.timeout(55_000),rpc=createSolanaRpc();
    const snapshot=await createMarketData().check(address,{signal});
    const risk=await createRiskData({rpc,liquidity:createLiquidityData({rpc})}).check(snapshot,{signal});
    const report={schemaVersion:1,kind:'public-read-only-risk-observation',completedAt:new Date().toISOString(),
      address,marketFetchedAt:snapshot.fetchedAt,pool:snapshot.selected?.address??null,
      evidence:risk,telegramDeliveryVerified:false,approvedStrategyMatchVerified:false,
      note:'This is an observed response, not an independent audit of every transaction, complete pool inventory, or proof of token safety.'};
    console.log(JSON.stringify(report,null,2));
    process.exitCode=['liquidityProtection','developerHolding','buyingCoordination'].some(f=>risk[f]?.state==='unknown')?2:0;
  } catch {
    console.error('Public risk observation unavailable; no strategy or saved data was changed.');process.exitCode=2;
  } finally {clearTimeout(deadline);}
}
