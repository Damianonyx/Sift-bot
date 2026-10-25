import { BOT_USERNAME, commandFor } from './bot.js';
import { criteriaKey } from './discovery-store.js';
import { assertApprovable, describeRule } from './rules.js';
import { TelegramError } from './telegram.js';
import { withCopyableCAs } from './telegram-format.js';
import { AgentStoreError } from './agent-store.js';
import { evaluateAgent } from './rules.js';
import { signalCard, evidencePages } from './signal-report.js';
import { quietNow } from './intelligence-store.js';
import { isSolanaAddress } from './market.js';

const admin = member => ['creator', 'administrator'].includes(member?.status);
const reply = (id, text, buttons = []) => ({chat_id:id, text, link_preview_options:{is_disabled:true},
  ...(buttons.length ? {reply_markup:{inline_keyboard:buttons}} : {})});
const button = (text, owner, row, action) => ({text, callback_data:`group:${owner}:${row.chat_id}:${action}:${row.revision}`});

export function createGroups({ agents, call, botId, allowedUserIds, now = Date.now }) {
  let nextDeliveryAt = 0;
  const sent = new Map();
  const usable = (snapshot, token) => snapshot?.address === token && isSolanaAddress(snapshot.selected?.address) &&
    Number.isFinite(snapshot.fetchedAt) && snapshot.fetchedAt <= now() && now() - snapshot.fetchedAt <= 120_000;
  async function authorized(chat, user, signal) {
    if (!Number.isSafeInteger(botId) || botId <= 0) return false;
    try {
      const bot = await call('getChatMember', {chat_id:chat, user_id:botId}, signal);
      if (bot?.user?.id !== botId || !admin(bot)) return false;
      const member = await call('getChatMember', {chat_id:chat, user_id:user}, signal);
      return member?.user?.id === user && member.user.is_bot === false && admin(member);
    } catch { return false; }
  }
  function current(owner, key, chat=null) {
    if (!allowedUserIds.has(owner)) return null;
    const approved = chat?agents.groupSettings(chat).strategy??agents.get(owner).approved:agents.get(owner).approved;
    try { assertApprovable(approved); } catch { return null; }
    return criteriaKey(approved) === key ? approved : null;
  }
  function list(owner) {
    const rows = agents.groupList(owner);
    return reply(owner, ['Group destinations',
      ...rows.map(row => {const config=agents.groupSettings(row.chat_id);return `${row.chat_id}: ${row.state}${row.issue ? ' · '+row.issue : ''}; ${agents.groupIssues(row.chat_id)} pending/failed/uncertain sends\n${config.strategy?'Independent saved group strategy':'Follows private strategy'}; ${config.max_per_cycle}/cycle, minimum ${config.interval_minutes} minutes between attempts.\nLast cycle: ${config.last_check?new Date(config.last_check).toISOString():'none'}; checked ${config.checked??0}, matched ${config.matched??0}; ${config.issue??'no issue recorded'}`;}),
      'To connect a group, add Sift as an admin and send /group@SiftAgentbot connect there. Then review and enable it here. Maximum three destinations. Only future matches are shared. Inherited strategies follow the private scan; independent group strategies have their own enabled state.',
    ].join('\n\n'), rows.filter(r=>r.state!=='stopped').map(row=>[
      button('Review '+row.chat_id,owner,row,'review'), button('Stop',owner,row,'stop'),
    ]));
  }
  function review(owner, row) {
    const config=agents.groupSettings(row.chat_id),approved = current(owner,row.criteria_key,row.chat_id);
    if (!approved) return reply(owner,'Approved rules changed or are unavailable. Run /group@SiftAgentbot connect in the group again.');
    return reply(owner,[`Share future discovery matches with group ${row.chat_id}?`,
      ...approved.rules.map(describeRule),
      'This shares matching CAs, your agent name, these rules, reasons, source links and warnings with everyone in that group. Private monitoring, drafts and history are not shared.',
      `${config.max_per_cycle} new alerts per cycle; at least ${config.interval_minutes} minutes between attempts. Unknown required checks still block matches. ${config.strategy?'This group uses its saved independent strategy, including when your private scan is stopped. Private rule edits do not change it.':'Your private scan must be active. Private rule changes require reconnection.'} This review expires ten minutes after configuration.`,
      'Privately: /groupstrategy CHAT_ID snapshots your currently approved rules for this group; /groupconfig CHAT_ID MINUTES MAX_PER_CYCLE changes cadence. Both require another Enable review. /grouppause CHAT_ID pauses posting.',
    ].join('\n\n'),[[button('Enable group alerts',owner,row,'enable'),button('Pause',owner,row,'pause'),button('Stop',owner,row,'stop')]]);
  }
  async function respond(update, signal) {
    const cb=update?.callback_query;
    if(typeof cb?.data==='string'&&cb.data.startsWith('groupdata:')) {
      const ack=callbackNotice=>({callbackQueryId:cb.id,callbackNotice});
      const m=/^groupdata:(-[1-9]\d*):(\d+):(\d+)$/.exec(cb.data);
      if(!m||cb.from?.is_bot||!['group','supergroup'].includes(cb.message?.chat?.type)||cb.message.chat.id!==Number(m[1]))return ack('Evidence is available only in its original group.');
      const pages=agents.groupEvidence(Number(m[1]),Number(m[2])),page=Number(m[3]);
      if(!pages||page>=pages.length)return ack('Evidence unavailable.');
      return {...reply(Number(m[1]),`Saved group evidence · ${page+1}/${pages.length}\nNot a fresh check.\n\n${pages[page]}`,[page+1<pages.length?[{text:'Next',callback_data:`groupdata:${m[1]}:${m[2]}:${page+1}`}]:[]].filter(r=>r.length)),...ack('Saved group evidence.')};
    }
    if (typeof cb?.data==='string' && cb.data.startsWith('group:')) {
      const ack=text=>({callbackQueryId:cb.id,callbackNotice:text});
      const owner=cb.from?.id;
      if (typeof cb.id!=='string' || cb.from?.is_bot || cb.message?.chat?.type!=='private' || cb.message.chat.id!==owner || !allowedUserIds.has(owner)) return ack('Private tester controls only.');
      const match=/^group:([1-9]\d*):(-[1-9]\d*):(review|enable|pause|stop):(\d+)$/.exec(cb.data);
      if (!match || Number(match[1])!==owner) return ack('This destination belongs to another tester.');
      const chat=Number(match[2]), action=match[3], revision=Number(match[4]);
      const saved=agents.receipt(update.update_id); if(saved) return saved;
      const row=agents.groupGet(chat);
      if (!row || row.owner_id!==owner || row.revision!==revision) return ack('Out of date. Use /groups.');
      if (action==='enable' && (row.state!=='review' || now()>row.expires_at || !await authorized(chat,owner,signal))) return ack('Reconnect in the group; review expired or admin access unavailable.');
      if (signal?.aborted) return null;
      return agents.process(update.update_id,()=>{
        const latest=agents.groupGet(chat);
        if (!latest || latest.owner_id!==owner || latest.revision!==revision) return ack('Out of date. Use /groups.');
        if (action==='review') return {...review(owner,latest),...ack('Review before sharing.')};
        if (action==='enable' && (!allowedUserIds.has(owner) || !current(owner,latest.criteria_key,chat) || now()>latest.expires_at)) return ack('Rules or access changed. Reconnect first.');
        agents.groupState(chat,action==='enable'?'active':action==='pause'?'paused':'stopped');
        return {...list(owner),...ack(action==='enable'?'Group enabled for future matches.':action==='pause'?'Group alerts paused.':'Group alerts stopped.')};
      });
    }
    const privateContext=commandFor(update);
    if (privateContext?.command==='groups' && allowedUserIds.has(privateContext.userId)) return list(privateContext.userId);
    if(privateContext&&allowedUserIds.has(privateContext.userId)&&['groupstrategy','groupconfig','grouppause'].includes(privateContext.command)) {
      const {userId:owner,command,args}=privateContext,parts=args.split(/\s+/),chat=Number(parts[0]),row=agents.groupGet(chat);
      if(!/^-[1-9]\d*$/.test(parts[0])||!row||row.owner_id!==owner)return reply(owner,'Use a connected group ID from /groups. This group is unavailable for your account.');
      const config=agents.groupSettings(chat);
      if(command==='grouppause')return agents.process(update.update_id,()=>{agents.groupState(chat,'paused');return list(owner);});
      const saved=agents.get(owner),strategy=command==='groupstrategy'?saved.approved:config.strategy;
      if(command==='groupstrategy'&&(parts.length!==1||saved.draft||!strategy))return reply(owner,'Finish approving your private rules first. Then /groupstrategy CHAT_ID copies them into a separate group strategy for review.');
      const interval=command==='groupconfig'?Number(parts[1]):config.interval_minutes,max=command==='groupconfig'?Number(parts[2]):config.max_per_cycle;
      if(!Number.isInteger(interval)||interval<0||interval>1440||!Number.isInteger(max)||max<1||max>3||command==='groupconfig'&&parts.length!==3)return reply(owner,'Use /groupconfig CHAT_ID MINUTES MAX_PER_CYCLE. Minutes: 0–1440. Maximum: 1–3.');
      if(!await authorized(chat,owner,signal))return reply(owner,'Admin access could not be verified. Nothing changed.');
      if(signal?.aborted)return null;
      return agents.process(update.update_id,()=>{
        if(!allowedUserIds.has(owner)||agents.groupGet(chat)?.revision!==row.revision||agents.get(owner).revision!==saved.revision)return reply(owner,'Configuration changed. Use /groups to review again.');
        const publicStrategy=strategy?{name:'Group scout',rules:strategy.rules,pendingRequirements:[]}:null;
        agents.groupConfigure(chat,owner,{strategy:publicStrategy,interval,max},now());return review(owner,agents.groupGet(chat));
      });
    }
    const m=update?.message;
    if (!['group','supergroup'].includes(m?.chat?.type) || !Number.isSafeInteger(m.chat.id) || m.chat.id>=0 ||
        m.from?.is_bot || m.sender_chat || !Number.isSafeInteger(m.from?.id) || m.from.id<=0 || typeof m.text!=='string') return null;
    const command=/^\/group(?:@([a-zA-Z0-9_]+))?(?:\s+(connect|stop|status))?\s*$/i.exec(m.text);
    if (!command || command[1] && command[1].toLowerCase()!==BOT_USERNAME.toLowerCase()) return null;
    const action=command[2]?.toLowerCase(), owner=m.from.id, chat=m.chat.id;
    if (action!=='stop' && !allowedUserIds.has(owner)) return null;
    if (!await authorized(chat,owner,signal)) return reply(chat,'Group controls require a verified admin. Sift must also be a group admin so it can verify permissions.');
    if (signal?.aborted) return null;
    return agents.process(update.update_id,()=>{
      if(action!=='stop' && !allowedUserIds.has(owner)) return null;
      if(action==='stop') {agents.groupState(chat,'stopped');return reply(chat,'Sift group alerts stopped.');}
      if(action==='connect') {
        const state=agents.get(owner);
        if(state.draft || !state.approved) return reply(chat,'Finish reviewing your criteria privately with Sift first. No group settings changed.');
        if(!agents.groupStage(chat,owner,criteriaKey(state.approved),now())) return reply(chat,'This group already has a different controller, or your three-group limit is reached. Stop the existing connection before replacing it.');
        return reply(chat,'Connection prepared. Open Sift privately and send /groups to review what will be shared and enable alerts. Nothing is posting yet.');
      }
      return reply(chat,`Sift group alerts: ${agents.groupGet(chat)?.state ?? 'not connected'}.\nUse /group@SiftAgentbot connect to prepare a connection, then /groups privately. Any verified group admin can use /group@SiftAgentbot stop.`);
    });
  }
  async function deliver(owner,key,token,text,{signal,chatId=null,snapshot,strategy,pages}={}) {
    for (const row of agents.groupList(owner).filter(r=>r.state==='active' && r.criteria_key===key && (chatId?r.chat_id===chatId:!agents.groupSettings(r.chat_id).strategy))) {
      const config=agents.groupSettings(row.chat_id);
      if (signal?.aborted || agents.groupSeen(row.chat_id,key,token) || now()<nextDeliveryAt || (sent.get(row.chat_id)??0)>=config.max_per_cycle ||
        config.last_attempt!==null&&now()-config.last_attempt<config.interval_minutes*60000 || quietNow(agents.preferences(owner),now())) continue;
      const permitted = current(owner,key,row.chat_id) && await authorized(row.chat_id,owner,signal);
      if (signal?.aborted) return;
      if (!permitted) {
        agents.groupState(row.chat_id,'paused','ADMIN_OR_ACCESS_UNAVAILABLE');continue;
      }
      const latest=agents.groupGet(row.chat_id), scan=agents.discoveryGet(owner), approved=current(owner,key,row.chat_id);
      if (signal?.aborted || !approved || latest?.state!=='active' || latest.owner_id!==owner || latest.criteria_key!==key || latest.revision!==row.revision || !config.strategy&&(scan.state!=='active' || scan.criteria_key!==key || agents.discoveryMuted(owner,token))) continue;
      // Permissions can take multiple network requests. Recheck both evidence
      // freshness and explicit notification controls after those awaits.
      if (quietNow(agents.preferences(owner),now()) || snapshot && (!usable(snapshot,token) || !evaluateAgent(approved,snapshot,{now:now()}).matches)) continue;
      const groupText=text.replace('Use /risk <CA> for detailed risk evidence. Monitor sets up market monitoring.','Open @SiftAgentbot privately for /risk evidence and monitoring.');
      if (groupText.length>4096) {agents.groupState(row.chat_id,'paused','REPORT_TOO_LONG');continue;}
      const event=agents.groupReserve(row.chat_id,owner,key,token,now(),snapshot&&strategy?{snapshot,strategy,pages}:null);if(event===null)continue;
      sent.set(row.chat_id,(sent.get(row.chat_id)??0)+1);
      try {
        await call('sendMessage',withCopyableCAs(reply(row.chat_id,groupText,pages?[[{text:'View evidence',callback_data:`groupdata:${row.chat_id}:${event}:0`}]]:[]),[token]),signal);
        agents.groupDelivery(event,'sent');
      } catch(error) {
        if (error instanceof AgentStoreError) throw error;
        agents.groupDelivery(event,error instanceof TelegramError && Number.isInteger(error.code)?'failed':'uncertain');
        if (error instanceof TelegramError && [401,404].includes(error.code)) throw error;
        if (error instanceof TelegramError && error.code===429) nextDeliveryAt=now()+error.retryAfter*1000;
        if (error instanceof TelegramError && [400,403].includes(error.code)) agents.groupState(row.chat_id,'paused','CHAT_UNAVAILABLE');
      }
    }
  }
  const targets=()=>agents.groupTargets().filter(r=>current(r.owner_id,r.criteria_key,r.chat_id)).map(r=>({...r,strategy:agents.groupSettings(r.chat_id).strategy}));
  return {respond,deliver,targets,beginCycle:()=>sent.clear(),
    async match(target,snapshot,batch,candidate,{signal}={}) {
      const live=agents.groupGet(target.chat_id),strategy=current(target.owner_id,target.criteria_key,target.chat_id);
      if(!strategy||live?.state!=='active'||live.revision!==target.revision)return null;
      const result=evaluateAgent(strategy,usable(snapshot,candidate.address)?snapshot:{...snapshot,selected:null,risk:null},{now:now()});
      if(result.matches)await deliver(target.owner_id,target.criteria_key,candidate.address,signalCard(strategy,snapshot,{now:now(),batch,candidate}),
        {signal,chatId:target.chat_id,snapshot,strategy,pages:evidencePages(strategy,snapshot,batch,candidate)});
      return result;
    },
  };
}
