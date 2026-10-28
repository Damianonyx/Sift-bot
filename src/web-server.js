import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { commandFor } from './bot.js';
import { withWebReceipt } from './agent-store.js';
import { criteriaKey } from './discovery-store.js';
import { describeRule } from './rules.js';
import { performanceSummary } from './intelligence-commands.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const COMMANDS = new Set('agent describe setup cancel mapextras scan pause resume stop why check risk liquidity verify poolcoverage sources watch watchlist watchalerts alerts calls performance preferences groups groupstrategy groupconfig grouppause audit feedback followstop unmute holders size bundle status help'.split(' '));
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff':'font/woff', '.webmanifest':'application/manifest+json; charset=utf-8' };

export function readWebConfig(env) {
  if (env.SIFT_WEB_ENABLED !== 'true') return null;
  let origin;
  try { origin = new URL(env.SIFT_WEB_ORIGIN); } catch { throw Error('Set SIFT_WEB_ORIGIN to the public web app origin.'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) throw Error('SIFT_WEB_ORIGIN requires HTTPS, except on localhost.');
  const port = Number(env.SIFT_WEB_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !env.SIFT_WEB_ROOT) throw Error('Set SIFT_WEB_ROOT to the app directory and SIFT_WEB_PORT to 1024–65535.');
  const codespaceHost = `${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`;
  const codespace = env.CODESPACES === 'true' && /^[a-z0-9-]+$/.test(env.CODESPACE_NAME || '') &&
    origin.protocol === 'https:' && origin.host === codespaceHost;
  return { origin:origin.origin, port, host:env.SIFT_WEB_HOST || '127.0.0.1', root:resolve(env.SIFT_WEB_ROOT), secure:origin.protocol === 'https:',
    codespaceLocalHosts:codespace ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : [] };
}

function isCodespaceLoopbackRequest(req, config) {
  // Codespaces can rewrite Host on its local tunnel connection. Never derive
  // the public origin or trust a peer from client-supplied forwarding headers.
  const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return localPeer && Boolean(config.codespaceLocalHosts?.includes(req.headers.host));
}

export function isWebRequestHostAllowed(req, config) {
  return req.headers.host === new URL(config.origin).host || isCodespaceLoopbackRequest(req, config);
}

export function isWebRequestOriginAllowed(req, config) {
  if (req.headers.origin === config.origin) return true;
  // The tunnel also rewrites Origin for same-origin browser requests. A local
  // origin alone is insufficient: require the known local tunnel and browser
  // Fetch Metadata. JavaScript cannot set Sec-Fetch-* headers across origins.
  if (!isCodespaceLoopbackRequest(req, config) || req.headers['sec-fetch-site'] !== 'same-origin') return false;
  return req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
}

export function createWebServer({ config, agents, respond, allowedUserIds, now = Date.now, signal }) {
  const sessions = new Map(), codes = new Map(), busy = new Set();
  let failedLogins = [], server, root;
  const cookieName = config.secure ? '__Host-sift' : 'sift-local';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
  function prune() {
    for (const [k,v] of codes) if (v.expires <= now() || !allowedUserIds.has(v.userId)) codes.delete(k);
    for (const [k,v] of sessions) if (v.expires <= now() || !allowedUserIds.has(v.userId)) {v.stop.abort();sessions.delete(k);}
  }
  function issue(userId, name) {
    prune();
    if (!allowedUserIds.has(userId)) throw fail(403, 'Private tester access required.');
    for (const [k,v] of codes) if (v.userId === userId) codes.delete(k);
    if (codes.size >= 200) throw fail(429, 'Sign-in is busy. Try again later.');
    const code = secret();
    codes.set(hash(code), {userId, name:typeof name === 'string' ? name.slice(0,64) : 'Scout', expires:now()+300_000});
    return `${config.origin}/app/#login=${code}`;
  }
  function telegram(update, allowed) {
    const c = commandFor(update);
    if (!c || !(c.command === 'web' || c.command === 'start' && c.args === 'web')) return null;
    if (!allowed.has(c.userId)) return {chat_id:c.chatId,text:'Sift web access is for configured private testers only.'};
    if (c.args === 'logout') {
      for (const [k,v] of sessions) if (v.userId === c.userId) {v.stop.abort();sessions.delete(k);}
      for (const [k,v] of codes) if (v.userId === c.userId) codes.delete(k);
      return {chat_id:c.chatId,text:'All your web sessions and unused sign-in links were revoked. Your rules and scans are unchanged.'};
    }
    return {chat_id:c.chatId,text:'Open your private Sift workspace. This link signs in as you: do not forward it. It expires in five minutes and works once. Use /web logout to revoke web sessions.',
      link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Open Sift workspace',url:issue(c.userId,update.message.from.first_name)}]]}};
  }
  const identify = req => {
    prune();
    const value = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session = value && sessions.get(hash(value));
    if (!session) throw fail(401, 'Sign in through Telegram to open your workspace.');
    return session;
  };
  function report(session, reply) {
    const buttons = [];
    for (const row of reply?.reply_markup?.inline_keyboard ?? []) for (const button of row) {
      if (button.callback_data) {
        if (session.actions.size >= 200) session.actions.delete(session.actions.keys().next().value);
        const id = secret();
        session.actions.set(id,{data:button.callback_data,expires:now()+600_000});
        buttons.push({label:button.text,action:id});
      } else if (button.copy_text) buttons.push({label:button.text,copy:button.copy_text.text});
      else if (typeof button.url === 'string' && /^https:\/\//.test(button.url)) buttons.push({label:button.text,url:button.url});
    }
    return {text:reply?.text ?? reply?.callbackNotice ?? 'No changes made.',notice:reply?.callbackNotice ?? null,buttons};
  }
  function state(session) {
    const id = session.userId, saved = agents.get(id), scan = agents.discoveryGet(id);
    const candidateChecks = saved.approved ? agents.discoveryDiagnostics(id,criteriaKey(saved.approved)) : [];
    const calls = agents.signalList(id,20).map(c=>({id:c.id,token:c.token,pool:c.pool,at:c.at,delivery:c.delivery,
      snapshot:c.snapshot,outcomes:agents.signalOutcomes(c.id)}));
    return {user:{name:session.name},serverTime:now(),agent:saved,
      ruleDescriptions:(saved.draft ?? saved.approved)?.rules.map(describeRule) ?? [],
      scan, candidateChecks, calls, monitors:agents.watchList(id),
      groups:agents.groupList(id).map(g=>({...g,settings:agents.groupSettings(g.chat_id)})),
      preferences:agents.preferences(id),performance:performanceSummary(agents,id),
      monitoringAlerts:agents.watchHistory(id),
      coverage:'Saved observations, not a fresh assessment. Unknown required evidence blocks qualification. Complete bundle and all-pools coverage are not established.'};
  }
  async function body(req) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415,'Use JSON requests.');
    if (Number(req.headers['content-length']) > 16_384) throw fail(413,'Request too large.');
    let size=0, chunks=[];
    for await (const chunk of req) { size+=chunk.length; if(size>16_384)throw fail(413,'Request too large.'); chunks.push(chunk); }
    try { const data=JSON.parse(Buffer.concat(chunks)); if(!data || Array.isArray(data) || typeof data!=='object')throw Error(); return data; }
    catch { throw fail(400,'Invalid request.'); }
  }
  async function handle(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      if (!isWebRequestHostAllowed(req, config)) throw fail(403,'Unrecognized app origin.');
      const url = new URL(req.url,config.origin), path=url.pathname;
      if (path.startsWith('/api/')) {
        if (!['GET','POST'].includes(req.method)) throw fail(405,'Method not supported.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403,'Open the app directly.');
        if (req.method === 'POST' && !isWebRequestOriginAllowed(req, config)) throw fail(403,'Request origin rejected.');
        if (req.method === 'POST' && path === '/api/login') {
          const data = await body(req);
          prune();
          failedLogins=failedLogins.filter(t=>now()-t<60_000);
          if(failedLogins.length>=30)throw fail(429,'Sign-in is temporarily limited. Try again in a minute.');
          const code=typeof data.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.code) ? hash(data.code) : '';
          const found=codes.get(code);
          if(!found) {failedLogins.push(now());throw fail(401,'This link expired or was used. Send /web to Sift for a new link.');}
          if(sessions.size>=200)throw fail(429,'Too many active sessions. Try /web logout.');
          codes.delete(code);
          const token=secret(), session={...found,expires:now()+28_800_000,csrf:secret(),actions:new Map(),requests:new Map(),times:[],stop:new AbortController()};
          // At most three simultaneous sessions per tester.
          const own=[...sessions].filter(([,v])=>v.userId===found.userId);
          while(own.length>=3){const [k,v]=own.shift();v.stop.abort();sessions.delete(k);}
          sessions.set(hash(token),session);
          res.setHeader('Set-Cookie',cookie(token,28_800));
          return send(200,{csrf:session.csrf,user:{name:session.name}});
        }
        const session=identify(req);
        if(req.method==='GET' && path==='/api/session')return send(200,{csrf:session.csrf,user:{name:session.name}});
        if(req.method==='GET' && path==='/api/workspace')return send(200,state(session));
        if(req.method!=='POST')throw fail(404,'Not found.');
        if(req.headers['x-sift-csrf']!==session.csrf)throw fail(403,'Refresh your session before making changes.');
        if(path==='/api/logout') {
          session.stop.abort();for(const [k,v] of sessions)if(v===session)sessions.delete(k);
          res.setHeader('Set-Cookie',cookie('',0));return send(200,{ok:true});
        }
        if(path!=='/api/command')throw fail(404,'Not found.');
        const data=await body(req);
        if(typeof data.requestId!=='string' || !/^[a-f0-9-]{36}$/.test(data.requestId))throw fail(400,'A unique request ID is required.');
        const text=typeof data.text==='string'?data.text.trim():null;
        const action=typeof data.action==='string'?session.actions.get(data.action):null;
        if(data.action && (!action || action.expires<=now()))throw fail(409,'This review expired. Open it again.');
        if((text!==null) === Boolean(action))throw fail(400,'Choose one command or review action.');
        if(text!==null && (!text.length || text.length>900 || text.startsWith('/') && !COMMANDS.has(/^\/(\w+)(?:\s|$)/.exec(text)?.[1])))throw fail(400,'Unsupported command.');
        const fingerprint=hash(JSON.stringify({text,action:action?.data}));
        const prior=session.requests.get(data.requestId);
        if(prior) {if(prior.fingerprint!==fingerprint)throw fail(409,'Request ID already used.');return send(200,prior.reply);}
        session.times=session.times.filter(t=>now()-t<60_000);
        if(session.times.length>=20 || busy.has(session.userId))throw fail(429,'A check is running or the request limit was reached. Please wait.');
        if(session.requests.size>=1000)throw fail(429,'Session request limit reached. Sign in again.');
        session.times.push(now());busy.add(session.userId);
        const user={id:session.userId,is_bot:false},chat={id:session.userId,type:'private'};
        const update={update_id:randomBytes(6).readUIntBE(0,6),...(action
          ? {callback_query:{id:secret(),from:user,message:{chat},data:action.data}}
          : {message:{from:user,chat,text}})};
        const disconnected=new AbortController();
        const close=()=>{if(!res.writableEnded)disconnected.abort();};res.once('close',close);
        try {
          const bound=AbortSignal.any([disconnected.signal,session.stop.signal,AbortSignal.timeout(55_000),...(signal?[signal]:[])]);
          const reply=await withWebReceipt(`${session.userId}:${session.csrf}:${data.requestId}`,()=>respond(update,allowedUserIds,bound));
          if(!allowedUserIds.has(session.userId) || ![...sessions.values()].includes(session))throw fail(401,'Session revoked.');
          const output=report(session,reply);
          session.requests.set(data.requestId,{fingerprint,reply:output});
          return send(200,output);
        } finally {busy.delete(session.userId);res.removeListener('close',close);}
      }
      if(!['GET','HEAD'].includes(req.method))throw fail(405,'Method not supported.');
      if(path==='/' || path==='/app'){res.writeHead(302,{Location:'/app/'});return res.end();}
      if(!path.startsWith('/app/'))throw fail(404,'Not found.');
      const relative=decodeURIComponent(path.slice(5)) || 'index.html';
      if(relative.split('/').some(p=>p.startsWith('.')) || !TYPES[extname(relative)])throw fail(404,'Not found.');
      let file;
      try {file=await realpath(resolve(root,relative));}catch{throw fail(404,'Not found.');}
      if(!file.startsWith(root+sep))throw fail(404,'Not found.');
      const data=await readFile(file);
      res.writeHead(200,{'Content-Type':TYPES[extname(file)]});res.end(req.method==='HEAD'?undefined:data);
    } catch(error) {if(!res.headersSent && !res.destroyed)send(error.status??500,{error:error.status?error.message:'Sift could not complete this request. Refresh to check the saved state.'});}
  }
  return {
    telegram,
    async listen() {
      root=await realpath(config.root);
      if(!(await stat(resolve(root,'index.html'))).isFile())throw Error('Sift web app index.html is missing.');
      server=createServer(handle);server.requestTimeout=60_000;server.headersTimeout=10_000;
      await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});
      return server.address();
    },
    async close() {codes.clear();for(const v of sessions.values())v.stop.abort();sessions.clear();if(server)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});},
  };
}
