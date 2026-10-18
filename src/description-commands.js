import { commandFor } from './bot.js';
import { describeRule } from './rules.js';
import { validDescription } from './description-data.js';

export function descriptionReview(state,id) {
  const draft=state.draft,proposal=draft?.interpretation;
  if(!proposal)return null;
  return {chat_id:id,text:[`${proposal.engine} · review your request`,
    `Your description:\n${draft.sourceDescription}`,
    'Proposed rules:\n'+(draft.rules.map(describeRule).join('\n')||'No measurable rules extracted.'),
    proposal.unresolved.length?'Still unresolved (blocks approval):\n'+proposal.unresolved.join('\n'):'No extra requirements identified. Check carefully that every condition you intended is included.',
    'Use interpreted draft accepts only the rules above and retains the listed unresolved instructions. It does not approve or start discovery. If anything was missed, discard this draft and clarify your request. AI interpretation does not verify any coin.',
  ].join('\n\n'),reply_markup:{inline_keyboard:[[
    {text:'Use interpreted draft',callback_data:`describe:${id}:${state.revision}:use`},
    {text:'Discard draft',callback_data:`agent:${id}:cancel:${state.revision}`},
  ]]}};
}

export function createDescriptionCommands({agents,interpreter}) {
  return async(update,allowed,signal)=>{
    const cb=update?.callback_query;
    if(typeof cb?.data==='string' && cb.data.startsWith('describe:')) {
      const id=cb.from?.id,ack=text=>({callbackQueryId:cb.id,callbackNotice:text});
      if(typeof cb.id!=='string' || cb.from?.is_bot || cb.message?.chat?.type!=='private' || cb.message.chat.id!==id || !allowed.has(id))return ack('Private tester controls only.');
      const match=/^describe:([1-9]\d*):(\d+):use$/.exec(cb.data);
      if(!match || Number(match[1])!==id)return ack('This draft belongs to another tester.');
      return agents.process(update.update_id,()=>{
        const state=agents.get(id),proposal=state.draft?.interpretation;
        if(state.revision!==Number(match[2]) || !proposal)return ack('Out of date. Use /agent.');
        state.draft.pendingRequirements=proposal.unresolved;
        delete state.draft.interpretation;state.revision++;agents.put(id,state);
        return {chat_id:id,text:'Interpreted draft saved. Use /agent to review and approve it. Unresolved requirements still block approval. Your active scan has not changed.',...ack('Draft updated; not approved.')};
      });
    }
    const context=commandFor(update);
    if(!context || !allowed.has(context.userId) || !(context.command==='describe' || context.command==='setup' && context.args))return null;
    const id=context.userId,reply=text=>({chat_id:id,text});
    const receipt=agents.receipt(update.update_id);if(receipt)return receipt;
    const previous=agents.get(id);
    if(previous.draft)return descriptionReview(previous,id)??reply('You already have a draft. Use /agent to review it or /cancel to discard it before describing a new strategy.');
    if(!validDescription(context.args))return reply('Send /describe followed by up to 800 characters. Example: market cap between $30k and $50k; liquidity at least $20k; pool age at most 20 minutes.');
    const parsed=await interpreter.interpret(context.args,{signal,updateId:update.update_id});
    if(signal?.aborted)return null;
    return agents.process(update.update_id,()=>{
      if(!allowed.has(id))return reply('Private tester access changed. Nothing was saved.');
      const state=agents.get(id);
      if(state.revision!==previous.revision || state.draft)return reply('Your draft changed while interpreting. Use /agent; the current settings were preserved.');
      state.draft={name:'Sift scout',step:6,rules:parsed.rules,pendingRequirements:[context.args],sourceDescription:context.args,
        interpretation:{engine:parsed.engine,unresolved:parsed.unresolved}};
      state.revision++;agents.put(id,state);
      const review=descriptionReview(state,id);if(parsed.notice)review.text=parsed.notice+'\n\n'+review.text;
      return review;
    });
  };
}
