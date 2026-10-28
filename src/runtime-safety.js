import { spawn } from 'node:child_process';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MESSAGES={
  INVALID_FREE_MODE:'SIFT_FREE_ONLY must be true or false.',
  INVALID_AI_MODE:'SIFT_AI_ENABLED must be true or false.',
  PAID_AI_BLOCKED:'Free-only mode blocks paid AI. Keep SIFT_AI_ENABLED=false while the ongoing-cost budget is $0.',
  INVALID_DATA_DIRECTORY:'SIFT_DATA_DIR must name a local directory.',
  LOCK_UNAVAILABLE:'A safe local runtime lock could not be acquired. Linux flock is required; no bot was started.',
  LOCK_HELD:'Another Sift process is using this data directory. Stop that process before starting another.',
  LOCK_LOST:'Sift lost its local runtime lock. Stop this process before restarting.',
};
export class RuntimeSafetyError extends Error {
  constructor(code){super(MESSAGES[code]??MESSAGES.LOCK_UNAVAILABLE);this.code=code;}
}

export function readRuntimeConfig(env={}) {
  const flag=(key,defaultValue,code)=>{
    if(env[key]===undefined || env[key]==='')return defaultValue;
    if(env[key]!=='true' && env[key]!=='false')throw new RuntimeSafetyError(code);
    return env[key]==='true';
  };
  const freeOnly=flag('SIFT_FREE_ONLY',true,'INVALID_FREE_MODE');
  const aiEnabled=flag('SIFT_AI_ENABLED',false,'INVALID_AI_MODE');
  if(freeOnly && aiEnabled)throw new RuntimeSafetyError('PAID_AI_BLOCKED');
  const raw=env.SIFT_DATA_DIR??'.sift';
  if(typeof raw!=='string'||!raw.trim()||raw.length>4096||/[\p{Cc}\p{Cf}]/u.test(raw))throw new RuntimeSafetyError('INVALID_DATA_DIRECTORY');
  return {freeOnly,directory:resolve(raw)};
}

// A helper holds an OS flock for the lifetime of the parent's stdin pipe. The
// OS releases it on helper death; parent death closes the pipe and ends the
// helper. No stale PID files, PID-reuse checks, or lock-file deletion are used.
// This protects one canonical local data directory, not separate hosts/disks.
export async function acquireRuntimeLock({directory='.sift',flockCommand='flock',timeoutMs=5000}={}) {
  let canonical,lockFile,descriptor;
  try {
    mkdirSync(directory,{recursive:true,mode:0o700});canonical=realpathSync(directory);
    if(!lstatSync(canonical).isDirectory())throw new Error();
    // Database symlink aliases could let different directories lock one DB.
    try {if(lstatSync(join(canonical,'agents.sqlite')).isSymbolicLink())throw new Error('symlink');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    lockFile=join(canonical,'.sift-bot.lock');
    descriptor=openSync(lockFile,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
    if(!lstatSync(lockFile).isFile())throw new Error();
  } catch {throw new RuntimeSafetyError('LOCK_UNAVAILABLE');}
  finally {if(descriptor!==undefined)closeSync(descriptor);}

  const helper=`process.stdout.write('SIFT_LOCK_READY\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));`;
  const controller=new AbortController();
  const child=spawn(flockCommand,['--exclusive','--nonblock','--no-fork','--conflict-exit-code','73',lockFile,process.execPath,'-e',helper],
    {stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
  let acquired=false,releasing=false,exited=false,releasePromise;
  const closed=new Promise(resolveClosed=>{
    child.once('close',()=>{exited=true;if(acquired&&!releasing)controller.abort(new RuntimeSafetyError('LOCK_LOST'));resolveClosed();});
    child.once('error',()=>{exited=true;if(acquired&&!releasing)controller.abort(new RuntimeSafetyError('LOCK_LOST'));resolveClosed();});
  });
  // An unavailable helper may close stdin before we terminate/release it.
  child.stdin.on('error',()=>{});
  await new Promise((resolveReady,rejectReady)=>{
    let done=false,output='';
    const finish=error=>{
      if(done)return;done=true;clearTimeout(timer);
      if(error){child.kill('SIGTERM');rejectReady(error);}else{acquired=true;resolveReady();}
    };
    const timer=setTimeout(()=>finish(new RuntimeSafetyError('LOCK_UNAVAILABLE')),timeoutMs);
    child.stdout.on('data',chunk=>{
      output+=chunk.toString('utf8');
      if(output==='SIFT_LOCK_READY\n')finish();
      else if(output.length>64)finish(new RuntimeSafetyError('LOCK_UNAVAILABLE'));
    });
    child.once('error',()=>finish(new RuntimeSafetyError('LOCK_UNAVAILABLE')));
    child.once('exit',code=>finish(new RuntimeSafetyError(code===73?'LOCK_HELD':'LOCK_UNAVAILABLE')));
  });
  return {directory:canonical,signal:controller.signal,
    release(){
      if(releasePromise)return releasePromise;
      releasing=true;
      releasePromise=(async()=>{
        if(exited)return;
        child.stdin.end();
        const force=setTimeout(()=>child.kill('SIGKILL'),1000);
        try{await closed;}finally{clearTimeout(force);}
      })();
      return releasePromise;
    },
  };
}
