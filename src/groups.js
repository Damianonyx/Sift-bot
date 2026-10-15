import { BOT_USERNAME, commandFor } from './bot.js';
import { criteriaKey } from './discovery-store.js';
import { assertApprovable, describeRule } from './rules.js';
import { TelegramError } from './telegram.js';
import { AgentStoreError } from './agent-store.js';

const admin = member => ['creator', 'administrator'].includes(member?.status);
const reply = (id, text, buttons = []) => ({chat_id:id, text, link_preview_options:{is_disabled:true},
  ...(buttons.length ? {reply_markup:{inline_keyboard:buttons}} : {})});
const button = (text, owner, row, action) => ({text, callback_data:`group:${owner}:${row.chat_id}:${action}:${row.revision}`});

export function createGroups({ agents, call, botId, allowedUserIds, now = Date.now }) {
  let nextDeliveryAt = 0;
  const sent = new Map();
  async function authorized(chat, user, signal) {
    if (!Number.isSafeInteger(botId) || botId <= 0) return false;
    try {
      const bot = await call('getChatMember', {chat_id:chat, user_id:botId}, signal);
      if (bot?.user?.id !== botId || !admin(bot)) return false;
      const member = await call('getChatMember', {chat_id:chat, user_id:user}, signal);
      return member?.user?.id === user && member.user.is_bot === false && admin(member);
    } catch { return false; }
  }
  function current(owner, key) {
    if (!allowedUserIds.has(owner)) return null;
    const approved = agents.get(owner).approved;
    try { assertApprovable(approved); } catch { return null; }
    return criteriaKey(approved) === key ? approved : null;
  }
  function list(owner) {
    const rows = agents.groupList(owner);
    return reply(owner, ['Group destinations',
      ...rows.map(row => `${row.chat_id}: ${row.state}${row.issue ? ' · '+row.issue : ''}; ${agents.groupIssues(row.chat_id)} pending/failed/uncertain sends`),
      'To connect a group, add Sift as an admin and send /group@SiftAgentbot connect there. Then review and enable it here. Maximum three destinations. Only future matches are shared. A paused or stopped private scan sends nothing.',
    ].join('\n\n'), rows.filter(r=>r.state!=='stopped').map(row=>[
      button('Review '+row.chat_id,owner,row,'review'), button('Stop',owner,row,'stop'),
    ]));
  }
  function review(owner, row) {
    const approved = current(owner,row.criteria_key);
    if (!approved) return reply(owner,'Approved rules changed or are unavailable. Run /group@SiftAgentbot connect in the group again.');
    return reply(owner,[`Share future discovery matches with group ${row.chat_id}?`,
      ...approved.rules.map(describeRule),
      'This shares matching CAs, your agent name, these rules, reasons, source links and warnings with everyone in that group. Private monitoring, drafts and history are not shared.',
      'Up to three new alerts per scan cycle. Unknown required checks still block matches; complete bundle coverage is unavailable. Your private scan must be active. Rule changes require reconnection. This review expires ten minutes after connecting.',
    ].join('\n\n'),[[button('Enable group alerts',owner,row,'enable'),button('Stop',owner,row,'stop')]]);
  }
  async function respond(update, signal) {
    const cb=update?.callback_query;
    if (typeof cb?.data==='string' && cb.data.startsWith('group:')) {
      const ack=text=>({callbackQueryId:cb.id,callbackNotice:text});
      const owner=cb.from?.id;
      if (typeof cb.id!=='string' || cb.from?.is_bot || cb.message?.chat?.type!=='private' || cb.message.chat.id!==owner || !allowedUserIds.has(owner)) return ack('Private tester controls only.');
      const match=/^group:([1-9]\d*):(-[1-9]\d*):(review|enable|stop):(\d+)$/.exec(cb.data);
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
        if (action==='enable' && (!allowedUserIds.has(owner) || !current(owner,latest.criteria_key) || now()>latest.expires_at)) return ack('Rules or access changed. Reconnect first.');
        agents.groupState(chat,action==='enable'?'active':'stopped');
        return {...list(owner),...ack(action==='enable'?'Group enabled for future matches.':'Group alerts stopped.')};
      });
    }
    const privateContext=commandFor(update);
    if (privateContext?.command==='groups' && allowedUserIds.has(privateContext.userId)) return list(privateContext.userId);
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
  async function deliver(owner,key,token,text,{signal}={}) {
    for (const row of agents.groupList(owner).filter(r=>r.state==='active' && r.criteria_key===key)) {
      if (signal?.aborted || now()<nextDeliveryAt || (sent.get(row.chat_id)??0)>=3) continue;
      const permitted = current(owner,key) && await authorized(row.chat_id,owner,signal);
      if (signal?.aborted) return;
      if (!permitted) {
        agents.groupState(row.chat_id,'paused','ADMIN_OR_ACCESS_UNAVAILABLE');continue;
      }
      const latest=agents.groupGet(row.chat_id), scan=agents.discoveryGet(owner);
      if (signal?.aborted || !current(owner,key) || latest?.state!=='active' || latest.owner_id!==owner || latest.criteria_key!==key || latest.revision!==row.revision || scan.state!=='active' || scan.criteria_key!==key) continue;
      const groupText=text.replace('Use /risk <CA> for detailed risk evidence. Monitor sets up market monitoring.','Open @SiftAgentbot privately for /risk evidence and monitoring.');
      if (groupText.length>4096) {agents.groupState(row.chat_id,'paused','REPORT_TOO_LONG');continue;}
      const event=agents.groupReserve(row.chat_id,owner,key,token,now());if(event===null)continue;
      sent.set(row.chat_id,(sent.get(row.chat_id)??0)+1);
      try {
        await call('sendMessage',reply(row.chat_id,groupText),signal);
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
  return {respond,deliver,beginCycle:()=>sent.clear()};
}
