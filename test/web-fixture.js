// Isolated test runtime. Never loaded by src/index.js and never contacts providers.
import { openAgentStore } from '../src/agent-store.js';
import { createResponder } from '../src/commands.js';
import { createWebServer } from '../src/web-server.js';
import { createDescriptionCommands } from '../src/description-commands.js';
import { createDescriptionInterpreter } from '../src/description-ai.js';
import { createDiscoveryRunner } from '../src/discovery.js';
import { normalisePairs } from '../src/market.js';

export const CA='11111111111111111111111111111112';
export const input=(text,id=42)=>({update_id:777,message:{text,from:{id,is_bot:false,first_name:'Test scout'},chat:{id,type:'private'}}});
export async function fixture({root,origin='http://localhost:3000',port=0,now=Date.now}={}) {
  const agents=openAgentStore({memory:true}),allowedUserIds=new Set([42,57]),sent=[];
  const market={status:()=>({state:'not_checked',checkedAt:null}),check:async address=>normalisePairs([{chainId:'solana',pairAddress:'11111111111111111111111111111113',dexId:'test',baseToken:{address,name:'Synthetic fixture',symbol:'TEST'},marketCap:40000,priceUsd:'0.01',liquidity:{usd:35000},volume:{h1:60000},pairCreatedAt:now()-60000}],address,now())};
  const feed={status:()=>({state:'not_checked'}),read:async()=>({candidates:[{address:CA}],fetchedAt:now(),sourceUrl:'https://example.invalid/fixture',returnedPools:1,invalidPools:0,deferred:0})};
  const unavailable={status:()=>({state:'not_checked',checkedAt:null}),check:async()=>{throw Error('No live evidence in fixtures');}};
  const descriptionCommands=createDescriptionCommands({agents,interpreter:createDescriptionInterpreter({agents})});
  const respond=createResponder({agents,market,feed,descriptionCommands,liquidity:unavailable,risk:unavailable,bundles:unavailable,audit:unavailable,now});
  const server=createWebServer({config:{root,origin,port,host:'127.0.0.1',secure:false},agents,respond,allowedUserIds,now});
  const address=await server.listen();
  const discovery=createDiscoveryRunner({agents,market,feed,allowedUserIds,now,call:async(method,payload)=>{sent.push({method,payload});return {message_id:1};}});
  return {server,agents,allowedUserIds,respond,discovery,sent,origin,url:`http://127.0.0.1:${address.port}`,
    close:async()=>{await server.close();agents.close();}};
}
