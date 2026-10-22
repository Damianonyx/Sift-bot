import { rpcFailureReason } from './solana-rpc.js';
export function createHolderData({rpc,now=Date.now}) {
  let nextAt=0;
  return {async check(token,{signal}={}) {
    if(now()<nextAt)return {state:'unknown',reason:'Holder checks are temporarily limited.'};
    nextAt=now()+60000;
    try {
      const supply=await rpc.supply(token,{signal}),largest=await rpc.largest(token,{signal});
      const time=await rpc.blockTime(largest.slot,{signal});
      if(!time||now()-time>120000||time>now()+30000||largest.slot<supply.slot||largest.slot-supply.slot>300||BigInt(supply.amount)===0n)throw Error('Inconsistent snapshot');
      const sum=largest.accounts.reduce((s,a)=>s+BigInt(a.amount),0n);
      if(sum>BigInt(supply.amount)||largest.accounts.some(a=>a.decimals!==supply.decimals))throw Error('Inconsistent supply');
      return {state:'observed',token,observedAt:time,fetchedAt:now(),supplySlot:supply.slot,slot:largest.slot,
        topAccountPercent:Number(sum*1000000n/BigInt(supply.amount))/10000,accounts:largest.accounts,supply:supply.amount};
    } catch(error){return {state:'unknown',reason:rpcFailureReason(error)};}
  }};
}
export function formatHolders(value,token) {
  return [`Sift · Holder-account sample\nCA: ${token}`,value.state==='observed'?
    `${value.accounts.length} largest token accounts hold ${value.topAccountPercent}% of returned supply.\nSupply slot ${value.supplySlot}; account slot ${value.slot}.\nObserved: ${new Date(value.observedAt).toISOString()}`:`UNKNOWN · ${value.reason}`,
    'Token accounts are not unique people or wallets. Pool vaults, lockers and exchange accounts are not excluded. This sample is not an insider or bundle verdict; transfers alone do not prove common control. Supply and accounts are separate finalized reads.',
  ].join('\n\n');
}
