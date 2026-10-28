import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd=fileURLToPath(new URL('..',import.meta.url));
test('risk, rule, store and responder modules load independently in fresh processes',()=>{
  for(const name of ['risk','rules','agent-store','commands']) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import('./src/${name}.js')`],
      {cwd,encoding:'utf8',timeout:5000,maxBuffer:16384});
    assert.equal(result.status,0,`${name} must load without import-order dependency: ${result.stderr}`);
  }
});

test('startup with a missing token fails before network clients or database creation',()=>{
  const result=spawnSync(process.execPath,['src/index.js'],{cwd,encoding:'utf8',timeout:5000,maxBuffer:16384,
    env:{...process.env,TELEGRAM_BOT_TOKEN:'',SIFT_AI_ENABLED:'false'}});
  assert.equal(result.status,1);assert.match(result.stderr,/Set a valid TELEGRAM_BOT_TOKEN/);
  assert.doesNotMatch(result.stderr,/ReferenceError|before initialization/);
});
