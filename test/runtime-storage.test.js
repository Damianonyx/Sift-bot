import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openAgentStore } from '../src/agent-store.js';
import { readRuntimeConfig, acquireRuntimeLock } from '../src/runtime-safety.js';
import { inspectDatabase, backupDatabase, restoreDatabase } from '../src/storage-maintenance.js';

function directory(t){const d=mkdtempSync(join(tmpdir(),'sift-runtime-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('free-only startup rejects paid AI and malformed flags without exposing configuration',()=>{
  assert.equal(readRuntimeConfig({}).freeOnly,true);
  for(const value of ['TRUE','yes','1'])assert.throws(()=>readRuntimeConfig({SIFT_FREE_ONLY:value}),/must be true or false/);
  assert.throws(()=>readRuntimeConfig({SIFT_AI_ENABLED:'true',OPENAI_API_KEY:'PRIVATE_VALUE'}),error=>/Free-only mode/.test(error.message)&&!error.message.includes('PRIVATE_VALUE'));
  assert.equal(readRuntimeConfig({SIFT_FREE_ONLY:'false',SIFT_AI_ENABLED:'true'}).freeOnly,false);
  const r=spawnSync(process.execPath,['src/index.js'],{encoding:'utf8',timeout:5000,env:{...process.env,SIFT_FREE_ONLY:'true',SIFT_AI_ENABLED:'true'}});
  assert.equal(r.status,1);assert.match(r.stderr,/Free-only mode blocks paid AI/);
});

test('OS lock refuses a second runtime and can be reacquired after release',async t=>{
  const d=directory(t),lock=await acquireRuntimeLock({directory:d});t.after(()=>lock.release());
  await assert.rejects(acquireRuntimeLock({directory:d}),e=>e.code==='LOCK_HELD');
  assert.equal(lock.signal.aborted,false);await lock.release();await lock.release();
  const again=await acquireRuntimeLock({directory:d});await again.release();
  await assert.rejects(acquireRuntimeLock({directory:d,flockCommand:'sift-missing-lock-program'}),e=>e.code==='LOCK_UNAVAILABLE');
});

test('a killed process releases its lock without deleting a potentially live PID file',async t=>{
  const d=directory(t),module=new URL('../src/runtime-safety.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireRuntimeLock} from ${JSON.stringify(module)};await acquireRuntimeLock({directory:${JSON.stringify(d)}});console.log('ready');`],{stdio:['ignore','pipe','ignore']});
  t.after(()=>child.kill('SIGKILL'));
  await Promise.race([once(child.stdout,'data'),delay(5000).then(()=>{throw Error('Lock holder did not start');})]);
  await assert.rejects(acquireRuntimeLock({directory:d}),e=>e.code==='LOCK_HELD');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  let replacement;
  for(let attempt=0;attempt<20&&!replacement;attempt++) {
    try{replacement=await acquireRuntimeLock({directory:d});}catch(error){if(error.code!=='LOCK_HELD')throw error;await delay(20);}
  }
  assert.ok(replacement,'kernel lock must become free after process death');await replacement.release();
});

test('online backup includes committed WAL state and restores without altering source or existing destinations',async t=>{
  const d=directory(t),source=join(d,'source'),file=join(d,'snapshot.sqlite'),restored=join(d,'restored');
  const s=openAgentStore({directory:source});t.after(()=>s.close());
  const state={revision:7,approved:null,draft:{name:'Private',step:6,rules:[{field:'marketCap',mode:'require',min:20000,max:60000}],pendingRequirements:['Original strict risk requirements']}};
  s.put(42,state);s.process(123,()=>({chat_id:42,text:'Saved mutation receipt'}));s.acknowledge(100);
  assert.equal(inspectDatabase(source).integrity,'ok');
  assert.equal((await backupDatabase(source,file)).consistentSnapshot,true);assert.equal(statSync(file).mode&0o777,0o600);
  const snapshotBytes=readFileSync(file);
  await assert.rejects(backupDatabase(source,file),e=>e.code==='DESTINATION_EXISTS');assert.deepEqual(readFileSync(file),snapshotBytes);
  assert.equal((await restoreDatabase(file,restored)).scanStatePreserved,true);
  const copy=openAgentStore({directory:restored});t.after(()=>copy.close());
  assert.deepEqual(copy.get(42),state);assert.equal(copy.offset(),101);assert.deepEqual(copy.receipt(123),{chat_id:42,text:'Saved mutation receipt'});
  await assert.rejects(restoreDatabase(file,source),e=>e.code==='DESTINATION_EXISTS');assert.deepEqual(s.get(42),state);
  const broken=join(d,'bad.sqlite'),newDir=join(d,'bad-restore');writeFileSync(broken,'not SQLite');
  await assert.rejects(restoreDatabase(broken,newDir));assert.equal(existsSync(newDir),false);
});
