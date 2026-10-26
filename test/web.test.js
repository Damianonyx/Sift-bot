import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fixture,input,CA } from './web-fixture.js';
import { readWebConfig } from '../src/web-server.js';
import { withWebReceipt } from '../src/agent-store.js';

async function setup(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'sift-web-'));
  await writeFile(join(root,'index.html'),'<!doctype html><title>Sift</title>');
  const f=await fixture({root,...options});
  t.after(async()=>{await f.close();await rm(root,{recursive:true,force:true});});
  async function request(path,{body,cookie,csrf,origin=f.origin,headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const req=httpRequest(f.url+path,{method:body?'POST':'GET',headers:{host:new URL(f.origin).host,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin}:{}),...(csrf?{'x-sift-csrf':csrf}:{}),...headers}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data,headers:new Headers(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))});});
      });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  function code(id=42){const r=f.server.telegram(input('/web',id),f.allowedUserIds);return new URL(r.reply_markup.inline_keyboard[0][0].url).hash.slice(7);}
  async function login(id=42){const r=await request('/api/login',{body:{code:code(id)}});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.data.csrf};}
  const command=async(auth,text,requestId=randomUUID())=>request('/api/command',{...auth,body:{requestId,text}});
  const click=async(auth,report,label)=>{const b=report.data.buttons.find(b=>b.label.includes(label));assert.ok(b,`missing button ${label}: ${JSON.stringify(report.data)}`);return request('/api/command',{...auth,body:{requestId:randomUUID(),action:b.action}});};
  return {...f,root,request,code,login,command,click};
}
test('web config is opt-in, requires an app root and HTTPS except loopback',()=>{
  assert.equal(readWebConfig({}),null);
  assert.throws(()=>readWebConfig({SIFT_WEB_ENABLED:'true',SIFT_WEB_ROOT:'.',SIFT_WEB_ORIGIN:'http://example.com'}));
  assert.throws(()=>readWebConfig({SIFT_WEB_ENABLED:'true',SIFT_WEB_ROOT:'.',SIFT_WEB_ORIGIN:'https://user:pass@example.com'}));
  assert.equal(readWebConfig({SIFT_WEB_ENABLED:'true',SIFT_WEB_ROOT:'.',SIFT_WEB_ORIGIN:'http://localhost:3000'}).secure,false);
  assert.equal(readWebConfig({SIFT_WEB_ENABLED:'true',SIFT_WEB_ROOT:'.',SIFT_WEB_ORIGIN:'https://app.example.com'}).secure,true);
});
test('web auth binds a one-use link to an allowed Telegram user; no client user IDs',async t=>{
  const f=await setup(t);assert.equal((await f.request('/api/workspace')).status,401);
  assert.equal(f.server.telegram(input('/web',99),f.allowedUserIds).reply_markup,undefined);
  const code=f.code(),r=await f.request('/api/login',{body:{code,userId:57}});
  assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/login',{body:{code}})).status,401);
  f.agents.put(57,{revision:1,draft:{name:'OTHER_PRIVATE_USER',step:6,rules:[],pendingRequirements:['private']},approved:null});
  assert.doesNotMatch(JSON.stringify((await f.request('/api/workspace',{cookie})).data),/OTHER_PRIVATE_USER/);
  f.allowedUserIds.delete(42);assert.equal((await f.request('/api/workspace',{cookie})).status,401);
});
test('expired and replaced links fail; Telegram logout revokes sessions',async t=>{
  let now=Date.now();const f=await setup(t,{now:()=>now});const old=f.code();f.code();
  assert.equal((await f.request('/api/login',{body:{code:old}})).status,401);
  const code=f.code();now+=300001;assert.equal((await f.request('/api/login',{body:{code}})).status,401);
  const auth=await f.login();f.server.telegram(input('/web logout'),f.allowedUserIds);
  assert.equal((await f.request('/api/workspace',auth)).status,401);
});
test('origin, CSRF, forged callbacks, body size and private file reads are rejected',async t=>{
  const f=await setup(t),auth=await f.login();
  assert.equal((await f.request('/api/command',{...auth,origin:'https://evil.invalid',body:{text:'/setup',requestId:randomUUID()}})).status,403);
  assert.equal((await f.request('/api/command',{cookie:auth.cookie,body:{text:'/setup',requestId:randomUUID()}})).status,403);
  assert.equal((await f.request('/api/command',{...auth,body:{action:'agent:42:approve:1',requestId:randomUUID()}})).status,409);
  assert.equal((await f.command(auth,'/unknown')).status,400);
  assert.equal((await f.request('/api/command',{...auth,body:{text:'x'.repeat(20000),requestId:randomUUID()}})).status,413);
  await writeFile(join(f.root,'.env'),'PRIVATE_SECRET');
  await symlink('/etc/passwd',join(f.root,'outside.js'));
  assert.equal((await f.request('/app/.env')).status,404);
  assert.equal((await f.request('/app/outside.js')).status,404);
  assert.equal((await f.request('/app/',{headers:{host:'evil.invalid'}})).status,403);
  const page=await f.request('/app/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('web description, approval and activation share Telegram state and a real discovery runner',async t=>{
  const f=await setup(t),auth=await f.login();
  const described=await f.command(auth,'/describe market cap between $20k and $60k');
  assert.equal(described.status,200);assert.ok(f.agents.get(42).draft);assert.equal(f.agents.get(42).approved,null);
  await f.click(auth,described,'Use interpreted draft');
  const review=await f.command(auth,'/agent');
  const approved=await f.click(auth,review,'Approve');assert.equal(approved.status,200);
  assert.ok(f.agents.get(42).approved);assert.equal(f.agents.discoveryGet(42).state,'stopped');
  const tg=await f.respond(input('/agent'),f.allowedUserIds);assert.match(tg.text,/20,000/);
  const scan=await f.command(auth,'/scan');await f.click(auth,scan,'Start discovery');
  assert.equal(f.agents.discoveryGet(42).state,'active');
  await f.discovery.cycle();
  assert.equal(f.sent.length,1);
  const state=(await f.request('/api/workspace',auth)).data;
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].token,CA);assert.equal(state.calls[0].delivery,'sent');
  assert.equal(state.candidateChecks[0].result.matches,true);
  await f.command(auth,'/pause');assert.equal(f.agents.discoveryGet(42).state,'paused');
});
test('unresolved requirements survive web review; a second user cannot replay the buttons',async t=>{
  const f=await setup(t),auth=await f.login(),other=await f.login(57);
  f.agents.put(42,{revision:1,draft:{name:'Strict agent',step:6,rules:[{field:'marketCap',mode:'require',min:20000,max:60000}],pendingRequirements:['100% liquidity protection across all pools and no bundles']},approved:null});
  const report=await f.command(auth,'/agent');assert.match(report.data.text,/Approval blocked/);
  assert.ok(!report.data.buttons.some(b=>/Approve/.test(b.label)));
  const foreign=report.data.buttons.find(b=>b.action);
  assert.equal((await f.request('/api/command',{...other,body:{requestId:randomUUID(),action:foreign.action}})).status,409);
  const scan=await f.command(auth,'/scan');assert.ok(!scan.data.buttons.some(b=>/Start discovery/.test(b.label)));
  assert.equal(f.agents.get(42).draft.pendingRequirements.length,1);
});
test('browser retries do not advance setup twice or alter Telegram polling offsets',async t=>{
  const f=await setup(t),auth=await f.login(),requestId=randomUUID();
  await f.command(auth,'/setup');
  const first=await f.command(auth,'My scout',requestId);const again=await f.command(auth,'My scout',requestId);
  assert.equal(first.status,200);assert.deepEqual(first.data,again.data);assert.equal(f.agents.get(42).draft.step,1);
  assert.equal((await f.command(auth,'Different request',requestId)).status,409);
  assert.equal(f.agents.offset(),0);
  const key='isolated-test';withWebReceipt(key,()=>f.agents.process(44,()=>({text:'web reply'})));
  f.agents.process(44,()=>({text:'telegram reply'}));f.agents.acknowledge(44);
  assert.equal(withWebReceipt(key,()=>f.agents.receipt(44)).text,'web reply');assert.equal(f.agents.receipt(44),null);
});
test('web preserves existing drafts and stale approval controls cannot approve newer rules',async t=>{
  const f=await setup(t),auth=await f.login();
  let r=await f.command(auth,'/describe market cap between $20k and $60k');await f.click(auth,r,'Use interpreted draft');
  const before=f.agents.get(42);r=await f.command(auth,'/agent');
  await f.command(auth,'/describe market cap between $1k and $2k');assert.deepEqual(f.agents.get(42),before);
  f.agents.put(42,{...before,revision:before.revision+1});
  const stale=await f.click(auth,r,'Approve');assert.match(stale.data.text,/out of date/i);assert.equal(f.agents.get(42).approved,null);
});
