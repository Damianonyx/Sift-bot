import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentStore } from '../src/agent-store.js';
import { createDescriptionInterpreter, readAiConfig } from '../src/description-ai.js';
import { parseDescription, validateInterpretation } from '../src/description-data.js';
import { createDescriptionCommands } from '../src/description-commands.js';
import { createResponder } from '../src/commands.js';
import { createDiscoveryRunner } from '../src/discovery.js';
import { normalisePairs } from '../src/market.js';
import { CA, POOL, NOW } from './fixtures/risk.js';
let sequence=90000;
const allowed=new Set([42]);
const message=(text,id=42)=>({update_id:++sequence,message:{text,from:{id,is_bot:false},chat:{id,type:'private'}}});
const callback=(data,id=42)=>({update_id:++sequence,callback_query:{id:'cb'+sequence,data,from:{id,is_bot:false},message:{chat:{id,type:'private'}}}});
const action=(r,label)=>r.reply_markup?.inline_keyboard.flat().find(b=>b.text.startsWith(label))?.callback_data;
const description='Find Solana coins with market cap between $30k and $50k; liquidity at least $20k; warn 1h volume at least $40k; pool age at most 20 minutes';
const store=t=>{const s=openAgentStore({memory:true});t.after(()=>s.close());return s;};
const noRequest=async()=>assert.fail('Unexpected network call');
const modelText='Find me coins with a market cap of 30k to 50k';
const extracted=()=>({rules:[{field:'marketCap',mode:'require',min:30000,max:50000,value:null,evidence:modelText}],unresolved:[]});
const completion=value=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('local description parsing preserves exact values, modes and unresolved risk requirements',()=>{
  const parsed=parseDescription(description);assert.equal(parsed.rules.length,4);assert.deepEqual(parsed.unresolved,[]);
  assert.deepEqual(parsed.rules[0],{field:'marketCap',mode:'require',min:30000,max:50000});assert.equal(parsed.rules[2].mode,'warn');
  for(const extra of ['100% protected for six months','dev still holding; flag partial sales','exclude bundles','no suspicious activity','pool age at most 2 hours','at least 30 holders']) {
    const text='market cap between 30k and 50k; '+extra;
    assert.ok(parseDescription(text).unresolved.length>0);
  }
  assert.ok(parseDescription('market cap between 50k and 30k').unresolved.length);
  assert.ok(parseDescription('liquidity at least 20k; liquidity at least 50k').unresolved.length);
});

test('AI proposals cannot invent thresholds, downgrade required rules or omit recognized risk instructions',()=>{
  for(const mutate of [r=>r.rules[0].min=20000,r=>r.rules[0].mode='warn',r=>r.rules[0].evidence='not in request',r=>r.rules[0].field='bundleFree',r=>r.rules.push({...r.rules[0]})]) {
    const value=extracted();mutate(value);assert.throws(()=>validateInterpretation(value,modelText));
  }
  const original=modelText+'; liquidity locked; dev still holds; exclude bundles';
  assert.deepEqual(validateInterpretation(extracted(),original).unresolved,[original]);
});

test('description review, rule approval and scan activation remain separate and survive duplicate updates',async t=>{
  const agents=store(t),interpreter=createDescriptionInterpreter({fetchImpl:noRequest});
  const respond=createResponder({agents,descriptionCommands:createDescriptionCommands({agents,interpreter}),feed:{status:()=>({state:'not_checked'})}});
  const request=message('/describe '+description),review=await respond(request,allowed);
  assert.deepEqual(await respond(request,allowed),review);assert.equal(agents.get(42).approved,null);
  assert.equal(agents.discoveryGet(42).state,'stopped');assert.ok(agents.get(42).draft.pendingRequirements.includes(description));
  assert.equal(action(review,'Approve'),undefined);
  assert.match((await respond(callback(action(review,'Use interpreted'),57),new Set([42,57]))).callbackNotice,/another/);
  await respond(callback(action(review,'Use interpreted')),allowed);
  const agent=await respond(message('/agent'),allowed);assert.match(agent.text,/Original description/);
  await respond(callback(action(agent,'Approve rules')),allowed);
  assert.equal(agents.get(42).approved.rules.length,4);assert.equal(agents.discoveryGet(42).state,'stopped');
});

test('unresolved descriptions cannot be approved and existing drafts are never overwritten',async t=>{
  const agents=store(t),interpreter=createDescriptionInterpreter();
  const respond=createResponder({agents,descriptionCommands:createDescriptionCommands({agents,interpreter})});
  const text='market cap between 30k and 50k; dev still holds; exclude bundles';
  const review=await respond(message('/describe '+text),allowed);
  await respond(callback(action(review,'Use interpreted')),allowed);
  const agent=await respond(message('/agent'),allowed);assert.equal(action(agent,'Approve'),undefined);
  const before=agents.get(42);await respond(message('/describe '+description),allowed);assert.deepEqual(agents.get(42),before);
});

test('AI is disabled by default and only receives the description when explicitly configured',async t=>{
  assert.deepEqual(readAiConfig({OPENAI_API_KEY:'fake'}),{enabled:false});assert.throws(()=>readAiConfig({SIFT_AI_ENABLED:'true'}));
  await createDescriptionInterpreter({fetchImpl:noRequest}).interpret(modelText);
  const agents=store(t);let requests=0;
  const ai=createDescriptionInterpreter({enabled:true,apiKey:'fake-key',model:'configured-test-model',agents,now:()=>NOW,
    fetchImpl:async(url,options)=>{
      requests++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');
      const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.input,modelText);assert.equal(body.max_output_tokens,1200);
      assert.equal(body.text.format.strict,true);assert.equal(body.tools,undefined);return completion(extracted());
    }});
  const result=await ai.interpret(modelText,{updateId:1});assert.equal(result.engine,'AI interpretation');assert.equal(result.rules[0].min,30000);
  await ai.interpret(modelText,{updateId:2});assert.equal(requests,1);
  const restarted=createDescriptionInterpreter({enabled:true,apiKey:'fake-key',model:'test',agents,fetchImpl:noRequest});
  await restarted.interpret(modelText,{updateId:1});
});

test('refusal, truncation, malformed/oversized responses and failed API calls preserve the request',async t=>{
  const agents=store(t);let updateId=500;
  for(const fetchImpl of [
    async()=>{throw Error('fake-key PRIVATE ERROR');},async()=>new Response('',{status:429}),
    async()=>new Response('{'),async()=>new Response('x'.repeat(65537)),
    async()=>Response.json({status:'incomplete',output:[]}),
    async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}),
    async()=>completion({...extracted(),rules:[{...extracted().rules[0],min:1}]}),
  ]) {
    const ai=createDescriptionInterpreter({enabled:true,apiKey:'fake-key',model:'test',agents,fetchImpl});
    const result=await ai.interpret(modelText,{updateId:++updateId});assert.ok(result.unresolved.includes(modelText));
    assert.doesNotMatch(JSON.stringify(result),/fake-key|PRIVATE ERROR/);
  }
});

test('AI quota is global and persistent in the store; no automatic retries are charged',t=>{
  const agents=store(t);
  for(let n=1;n<=20;n++)assert.equal(agents.aiReserve(n,'2026-10-15'),true);
  assert.equal(agents.aiReserve(21,'2026-10-15'),false);assert.equal(agents.aiReserve(1,'2026-10-16'),false);
  assert.equal(agents.aiReserve(21,'2026-10-16'),true);
});

test('description commands authorize first and preserve changes made while AI is pending',async t=>{
  const agents=store(t),blocked=createDescriptionCommands({agents,interpreter:{interpret:noRequest}});
  assert.equal(await blocked(message('/describe '+modelText,99),allowed),null);
  const group=message('/describe '+modelText);group.message.chat.type='group';assert.equal(await blocked(group,allowed),null);
  const pending=createDescriptionCommands({agents,interpreter:{interpret:async()=>{agents.put(42,{revision:1,draft:{name:'Keep me',step:0,rules:[],pendingRequirements:[]},approved:null});return parseDescription(description);}}});
  await pending(message('/describe '+description),allowed);assert.equal(agents.get(42).draft.name,'Keep me');
});

test('description to approved rules to scan to CA alert works without an AI API call',async t=>{
  const agents=store(t),interpreter=createDescriptionInterpreter({fetchImpl:noRequest}),sends=[];
  const feed={read:async()=>({candidates:[{address:CA}],sourceUrl:'https://example.invalid',fetchedAt:NOW})};
  const respond=createResponder({agents,feed,descriptionCommands:createDescriptionCommands({agents,interpreter})});
  const review=await respond(message('/describe market cap between 30k and 50k'),allowed);
  await respond(callback(action(review,'Use interpreted')),allowed);
  await respond(callback(action(await respond(message('/agent'),allowed),'Approve rules')),allowed);
  const scan=await respond(message('/scan'),allowed);
  await respond(callback(action(scan,'Start')),allowed);
  assert.equal(agents.discoveryGet(42).state,'active');
  const market={check:async()=>normalisePairs([{chainId:'solana',pairAddress:POOL,baseToken:{address:CA},marketCap:40000}],CA,NOW)};
  await createDiscoveryRunner({agents,feed,market,allowedUserIds:allowed,now:()=>NOW,call:async(method,body)=>sends.push(body)}).cycle();
  assert.equal(sends.length,1);assert.ok(sends[0].text.includes(CA));assert.match(sends[0].text,/passes all required rules/);
});
