import { createPublicJson } from './public-json.js';
import { isSolanaAddress } from './market.js';
import { rawAmount } from './evidence-utils.js';

export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const QUOTE_ORIGIN='https://transaction-v1.raydium.io';
function validateQuote(raw,input,output,amount,bps) {
  const q=raw?.data;
  if(raw?.success!==true||q?.swapType!=='BaseIn'||q.inputMint!==input||q.outputMint!==output||
    q.inputAmount!==amount||q.slippageBps!==bps||!rawAmount(q.outputAmount)||BigInt(q.outputAmount)<=0n||
    !rawAmount(q.otherAmountThreshold)||BigInt(q.otherAmountThreshold)>BigInt(q.outputAmount)||
    !Array.isArray(q.routePlan)||!q.routePlan.length||q.routePlan.length>8) throw Error('Unusable quote');
  let previous=input;
  for(const leg of q.routePlan) {
    if(![leg.poolId,leg.inputMint,leg.outputMint,leg.feeMint].every(isSolanaAddress)||leg.inputMint!==previous||!rawAmount(leg.feeAmount))throw Error('Unusable route');
    previous=leg.outputMint;
  }
  if(previous!==output)throw Error('Unusable route');
  return q;
}
// Quotes only. No wallet, transaction-building endpoint, signing or submission.
export function createPositionQuotes({fetchImpl=fetch,now=Date.now}={}) {
  const read=createPublicJson({origin:QUOTE_ORIGIN,fetchImpl,now,intervalMs:0});
  let busy=false,nextAt=0;
  const quote=async(input,output,amount,bps,signal)=>validateQuote(await read('/compute/swap-base-in?'+new URLSearchParams({inputMint:input,outputMint:output,amount,slippageBps:String(bps),txVersion:'V0'}),{signal}),input,output,amount,bps);
  return {async check(token,usd,{signal,slippageBps=100}={}) {
    if(!isSolanaAddress(token)||token===USDC||!Number.isFinite(usd)||usd<1||usd>10000||!Number.isSafeInteger(Math.round(usd*1e6))||
      !Number.isInteger(slippageBps)||slippageBps<0||slippageBps>1000)throw Error('Invalid size');
    if(busy||now()<nextAt||signal?.aborted)return {state:'unavailable',reason:'Quote requests are limited or stopped.'};
    busy=true;nextAt=now()+10000;
    try {
      const amount=String(Math.round(usd*1e6)),startedAt=now();
      const entry=await quote(USDC,token,amount,slippageBps,signal);
      const exit=await quote(token,USDC,entry.outputAmount,slippageBps,signal);
      if(signal?.aborted||now()-startedAt>30000)throw Error('Stale quote');
      return {state:'quoted',token,usd:Number(amount)/1e6,entry,exit,fetchedAt:now(),
        roundTripUsdc:Number(exit.outputAmount)/1e6,roundTripLossPct:(1-Number(exit.outputAmount)/Number(amount))*100};
    } catch {return {state:'unavailable',reason:'No validated two-way Raydium quote is available for this token and size. This is not proof of an unsellable token.'};}
    finally {busy=false;}
  }};
}
export function formatPosition(result,token,usd) {
  if(result.state!=='quoted')return `Sift · Position-size check\nCA: ${token}\nRequested size: ${usd} USDC\n\nUNKNOWN · ${result.reason}`;
  return [`Sift · Position-size quote\nCA: ${token}\nInput: ${result.usd} USDC`,
    `Quoted token amount: ${result.entry.outputAmount} raw units\nQuoted exit: ${result.roundTripUsdc.toFixed(6)} USDC\nIndicative round-trip difference: ${result.roundTripLossPct.toFixed(2)}%`,
    `Slippage tolerance: ${result.entry.slippageBps/100}% per quote; this is a limit, not measured slippage.\nPools: ${[...new Set([...result.entry.routePlan,...result.exit.routePlan].map(r=>r.poolId))].join(', ')}`,
    `Fetched: ${new Date(result.fetchedAt).toISOString()}\nSource: ${QUOTE_ORIGIN}`,
    'Independent quotes at current pool states; the exit does not simulate the entry’s effect on reserves. Raydium routes may differ from the screening pool. Pool fees are reflected in quotes; network fees, priority fees, MEV, failed transactions and future price changes are not included. No guarantee of execution or future sellability. USDC is treated as one USD only for sizing. No trade was placed.',
  ].join('\n\n');
}
