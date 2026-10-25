import { commandFor } from './bot.js';
import { RULE_FIELDS, describeRule, assertApprovable } from './rules.js';
import { TEST_RISK_RULES, RISK_FIELDS } from './risk.js';
import { descriptionReview } from './description-commands.js';
import { verificationLimitsButton, verificationLimitsView } from './risk-capabilities.js';
import { parseDescription, validDescription } from './description-data.js';
import { clarifyLiquidityScope } from './policy-description.js';

const QUESTIONS = [
  'Give your agent a name (1–32 characters).',
  'Market cap range in USD (provider estimate). Send require followed by your two amounts, minimum first.\nFormat example only: require 20k 60k\nUse warn instead of require for a warning-only check, or tap Skip.',
  'Minimum selected-pool liquidity in USD. Send require or warn followed by your amount, or tap Skip.\nFormat example only: require 10000\nLiquidity amount does not prove liquidity is locked.',
  'Minimum selected-pool volume over the last 1h in USD. Send require or warn followed by your amount, or tap Skip.\nFormat example only: warn 5000',
  'Maximum selected-pool age in minutes. Send require or warn followed by your number of minutes, or tap Skip.\nFormat example only: require 60\nPool creation is not token creation or the start of trading.',
  'Send risk to require 100% selected-pool LP protection, six calendar months remaining on locks (verified burns accepted), a developer who still holds, and exclusion of confirmed bundles/coordinated buys. Partial sales and suspicions are flagged. Unknown required evidence blocks matches. Or send other requirements (up to 800 characters), or none. Other free text stays unresolved. Earlier unresolved instructions are always retained.',
];
const LIMITATIONS = 'Solana · one selected pool. Provider update time is unknown. Risk checks have limited pool, locker, creator and transaction coverage. General bundle coverage is unknown and blocks a required check. No guarantee of safety.\n/describe prepares rules from a description; optional AI requires operator configuration. Approval saves rules only; it does not start a scan. Use /scan to review and activate separately.';
const nameOf = (value) => typeof value === 'string' && !/[\p{Cc}\p{Cf}]/u.test(value) &&
  value.trim().length >= 1 && value.trim().length <= 32 ? value.trim() : null;
const requirementText = (text) => text.length > 0 && text.length <= 800 &&
  !/[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f]/u.test(text);
const blankDraft = (pendingRequirements = []) => ({ name: '', rules: [], pendingRequirements, step: 0 });

function amount(text) {
  // Accept USD notation without reinterpreting malformed comma groups.
  const match = /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?)([km]?)$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', '')) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] ?? 1);
  return Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
}

function parseRule(step, text) {
  const parts = text.trim().split(/\s+/);
  const [mode, ...rawNumbers] = parts;
  // Labels are optional, but when present their order must be explicit.
  const numbers = step === 1 && rawNumbers.length === 4 &&
    rawNumbers[0].toLowerCase() === 'min' && rawNumbers[2].toLowerCase() === 'max'
    ? [rawNumbers[1], rawNumbers[3]] : rawNumbers;
  if (!['require', 'warn'].includes(mode.toLowerCase()) || numbers.length !== (step === 1 ? 2 : 1)) return null;
  const values = numbers.map(amount);
  if (values.some((v) => v === null) || step === 1 && values[0] > values[1]) return null;
  if (step === 4 && !/^\d+(?:\.\d+)?$/.test(numbers[0])) return null;
  return { field: RULE_FIELDS[step - 1], mode: mode.toLowerCase(),
    ...(step === 1 ? { min: values[0], max: values[1] } : { value: values[0] }) };
}

function button(text, action, id, revision) {
  return { text, callback_data: `agent:${id}:${action}:${revision}` };
}

function mappingProposal(state, scope = null) {
  if (!state.draft || state.draft.step !== QUESTIONS.length || state.draft.interpretation) return null;
  const originalText = state.draft.pendingRequirements.join('; ');
  if (!originalText || originalText.length > 800) return null;
  const interpretedText = scope === null ? originalText : clarifyLiquidityScope(originalText,scope);
  if (!validDescription(interpretedText)) return null;
  const parsed = parseDescription(interpretedText);
  const merged = [...state.draft.rules, ...parsed.rules];
  const conflict = new Set(merged.map(r => r.field)).size !== merged.length;
  return {originalText, interpretedText, liquidityScope:scope, parsed, merged, conflict};
}

function mappingView(state, id, scope = null) {
  const proposal = mappingProposal(state,scope);
  if (!proposal) return {chat_id:id,text:'Finish the current draft first. /mapextras needs a completed draft with up to 800 characters of extras. Use /agent.'};
  const canApply = !proposal.parsed.unresolved.length && !proposal.conflict;
  const scopes = scope === null && proposal.parsed.unresolved.length && ['selected','all'].every(s => {
    const option = mappingProposal(state,s);
    return option && !option.parsed.unresolved.length && !option.conflict;
  });
  const text = [
    'Review mapping of saved extras',
    `Original:\n${proposal.originalText}`,
    scope === 'selected' ? 'Scope choice: selected pool only. Other pools may be unprotected. This is a narrower scope than all-pools protection; apply only if this is what you intend.' :
      scope === 'all' ? 'Scope choice: all pools belonging to the coin. Complete coverage is not established, so this required check remains UNKNOWN.' : '',
    proposal.parsed.rules.map(describeRule).join('\n'),
    proposal.conflict ? 'A saved rule conflicts with these extras. Review the conflict in /agent; nothing changed.' :
      scopes ? 'Choose the scope of your 100% liquidity requirement below. Each choice opens a preview; it does not change your draft.' :
      proposal.parsed.unresolved.length ? 'Still unresolved. Unsupported or conflicting wording needs clarification. Saved instructions are unchanged.' :
      'Apply mapping saves these explicit rules in your draft only. Approval and /scan activation stay separate. All-pools and complete bundle coverage remain UNKNOWN; saving a rule cannot make it pass.',
    'Saved rules and scan state are unchanged by this preview.',
  ].filter(Boolean).join('\n\n');
  const rows = canApply ? [[button('Apply mapping to draft',scope==='selected'?'applysel':scope==='all'?'applyall':'mapextras',id,state.revision)]] :
    scopes ? [[button('Selected pool — preview','mapsel',id,state.revision)], [button('All pools — preview','mapall',id,state.revision)]] : [];
  if (scope !== null) rows.push([button('Back to scope choices','mapview',id,state.revision)]);
  return {chat_id:id,text,...(rows.length?{reply_markup:{inline_keyboard:rows}}:{})};
}

function view(state, id) {
  if (state.draft?.interpretation) {
    const review = descriptionReview(state,id);
    return { ...review, reply_markup:{ inline_keyboard:[...(review.reply_markup?.inline_keyboard ?? []), ...verificationLimitsButton(state,id)] } };
  }
  const reply = (text, buttons = []) => ({ chat_id: id, text,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  if (state.draft && state.draft.step < QUESTIONS.length) {
    const step = state.draft.step;
    return reply([
      `Set up your agent · ${step + 1}/${QUESTIONS.length}`,
      QUESTIONS[step],
      step === 0 ? 'Choose your own thresholds. For description-based setup, cancel this draft and use /describe instead.' :
        step < 5 ? 'require = must pass; warn = warning only. USD amounts accept $, commas and k/m suffixes. Examples show the format only; no values are preselected.' : '',
      state.draft.pendingRequirements.length ? 'Your earlier description is retained as unresolved. It cannot be approved by this guided setup.' : '',
      state.approved ? 'Your previously approved rules remain saved while you edit.' : '',
    ].filter(Boolean).join('\n\n'), [[
      ...(step > 0 && step < 5 ? [button('Skip this condition', 'skip', id, state.revision)] : []),
      button('Cancel setup', 'cancel', id, state.revision),
    ]]);
  }
  const agent = state.draft ?? state.approved;
  if (!agent) return reply('No saved agent yet. Use /setup to choose a name and measurable criteria.\n\n' + LIMITATIONS);
  let approvalError = '';
  try { assertApprovable(agent); } catch (error) { approvalError = error.message; }
  const text = [
    `${state.draft ? 'Review draft' : 'Approved rules'} · ${agent.name}`,
    agent.sourceDescription ? 'Original description:\n'+agent.sourceDescription : '',
    agent.mappedExtras ? 'Mapped extras (original instructions retained):\n'+agent.mappedExtras.originalText+
      (agent.mappedExtras.liquidityScope ? '\nExplicit scope choice: '+(agent.mappedExtras.liquidityScope==='all'?'all pools':'selected pool only')+'.' : '') : '',
    agent.rules.length ? agent.rules.map(describeRule).join('\n') : 'No conditions selected.',
    agent.pendingRequirements.length ? 'Unresolved instructions (not yet interpreted or checked):\n' + agent.pendingRequirements.join('\n\n') : '',
    'Unknown required results fail. Warning-only failures or unknowns remain visible.',
    LIMITATIONS, approvalError,
  ].filter(Boolean).join('\n\n');
  return reply(text, [[
    ...(state.draft && !approvalError ? [button('Approve rules', 'approve', id, state.revision)] : []),
    button('Edit rules', 'edit', id, state.revision),
    ...(state.draft ? [button('Discard draft', 'cancel', id, state.revision)] : []),
  ], ...verificationLimitsButton(state,id)]);
}

export function createAgentSetup(store) {
  return (update, allowedUserIds) => {
    const callback = update?.callback_query;
    if (callback) {
      const id = callback.from?.id;
      if (callback.message?.chat?.type !== 'private' || callback.from?.is_bot ||
          !Number.isSafeInteger(id) || callback.message.chat.id !== id ||
          typeof callback.id !== 'string' || typeof callback.data !== 'string') return null;
      const acknowledge = (notice) => ({ callbackQueryId: callback.id, callbackNotice: notice });
      if (!allowedUserIds.has(id)) return acknowledge('Sift is in private testing.');
      const match = /^agent:([1-9]\d*):(skip|cancel|approve|edit|risk|limits|mapextras|mapsel|mapall|applysel|applyall|mapview):(\d+)$/.exec(callback.data);
      if (!match || Number(match[1]) !== id) return acknowledge('This button does not belong to your agent.');
      return store.process(update.update_id, () => {
        const state = store.get(id);
        if (state.revision !== Number(match[3])) return acknowledge('This button is out of date. Use /agent for the current rules.');
        const action = match[2];
        if (action === 'limits') return { ...verificationLimitsView(state,id), ...acknowledge('Saved rules unchanged.') };
        if (['mapsel','mapall','mapview'].includes(action)) {
          return {...mappingView(state,id,action==='mapsel'?'selected':action==='mapall'?'all':null),...acknowledge('Preview only. Saved rules unchanged.')};
        }
        if(['mapextras','applysel','applyall'].includes(action)) {
          const proposal=mappingProposal(state,action==='applysel'?'selected':action==='applyall'?'all':null);
          if(!proposal)return acknowledge('Finish or clarify the saved draft first. Nothing changed.');
          if(proposal.parsed.unresolved.length)return acknowledge('Scope or policy remains unresolved; your saved instructions are unchanged.');
          if(proposal.conflict)return acknowledge('A saved rule conflicts with these extras. Nothing changed.');
          state.draft.rules=proposal.merged;state.draft.pendingRequirements=[];
          state.draft.mappedExtras={originalText:proposal.originalText,interpretedText:proposal.interpretedText,liquidityScope:proposal.liquidityScope};
        } else if (action === 'risk') {
          const previous = state.draft ?? state.approved;
          if (!previous || (state.draft && state.draft.step !== QUESTIONS.length)) return acknowledge('Complete the current setup first.');
          state.draft = { name:previous.name, step:QUESTIONS.length, pendingRequirements:[],
            rules:[...previous.rules.filter((r) => !RISK_FIELDS.includes(r.field)), ...TEST_RISK_RULES] };
        } else if (action === 'edit') {
          const mappedExtras=(state.draft??state.approved)?.mappedExtras;
          state.draft = { ...blankDraft(state.draft?.pendingRequirements ?? []),
            rules:(state.draft ?? state.approved)?.rules.filter((r) => RISK_FIELDS.includes(r.field)) ?? [],
            ...(mappedExtras?{mappedExtras}: {}) };
        }
        else if (action === 'cancel') state.draft = null;
        else if (action === 'skip') {
          if (!state.draft || state.draft.step < 1 || state.draft.step >= 5) return acknowledge('Use /agent to review your current setup.');
          state.draft.step++;
        } else {
          if (!state.draft || state.draft.step !== QUESTIONS.length) return acknowledge('Complete setup and review the rules first.');
          try { assertApprovable(state.draft); } catch (error) { return acknowledge(error.message); }
          state.approved = { name: state.draft.name, rules: state.draft.rules, pendingRequirements: [],
            ...(state.draft.sourceDescription ? {sourceDescription:state.draft.sourceDescription} : {}),
            ...(state.draft.mappedExtras ? {mappedExtras:state.draft.mappedExtras} : {}) };
          state.draft = null;
        }
        state.revision++;
        store.put(id, state);
        return { ...view(state, id), callbackQueryId: callback.id,
          callbackNotice: action === 'approve' ? 'Rules saved. Use /scan to review before starting discovery.' : 'Updated.' };
      });
    }

    const context = commandFor(update);
    if (!context || !allowedUserIds.has(context.userId)) return null;
    const { userId: id, command } = context;
    const state = store.get(id);
    const text = update.message.text.trim();
    if (command === 'agent') return view(state, id);
    if(command==='mapextras') {
      return mappingView(state,id);
    }
    if (command === 'riskrules') {
      const previous = state.draft ?? state.approved;
      if (!previous || (state.draft && state.draft.step !== QUESTIONS.length)) return { chat_id:id, text:'Finish /setup first, then use /riskrules to review the explicit risk policy.' };
      return { chat_id:id, text:[
        'Review replacement of extra instructions',
        'This replaces ALL unresolved extra instructions below with the three risk rules shown. Your market rules and name are retained. Only continue if this exactly covers your intended extras; otherwise keep the current draft.',
        'Instructions to replace:\n' + (previous.pendingRequirements.join('\n') || '(none)'),
        ...TEST_RISK_RULES.map(describeRule),
        'General bundle coverage remains UNKNOWN, so this full policy cannot currently produce a qualifying match. This button prepares a draft only. Review and Approve rules afterwards; /scan activation stays separate.',
      ].join('\n\n'), reply_markup:{ inline_keyboard:[[button('Use this risk policy in draft','risk',id,state.revision)]] } };
    }
    if (!['setup', 'cancel'].includes(command) && (command || !state.draft || text.startsWith('/'))) return null;
    return store.process(update.update_id, () => {
      // Read within the transaction so a retry returns the recorded response.
      const current = store.get(id);
      if (command === 'setup') {
        if (current.draft) return { ...view(current, id), text: 'You already have a draft. Continue it, or use /cancel to discard it before starting again.\n\n' + view(current, id).text };
        if (context.args && !requirementText(context.args)) return { chat_id: id, text: 'Keep the description to 800 characters or fewer, without hidden formatting characters. Nothing was saved.' };
        current.draft = context.args
          ? { name: 'Draft agent', rules: [], pendingRequirements: [context.args], step: QUESTIONS.length }
          : blankDraft();
      }
      else if (command === 'cancel') current.draft = null;
      else if (current.draft && current.draft.step < QUESTIONS.length) {
        const { step } = current.draft;
        const value = step === 0 ? nameOf(text) : step === 5 ? (requirementText(text) ? text : null) : parseRule(step, text);
        if (!value && !(step > 0 && step < 5 && text.toLowerCase() === 'skip')) {
          const hint = step === 1 ? 'Start with require or warn, then enter two valid USD amounts, minimum first. For example: require 20k 60k. Nothing changed.' :
            'I could not use that answer. Nothing changed.';
          return { ...view(current, id), text: hint + '\n\n' + view(current, id).text };
        }
        if (step === 0) current.draft.name = value;
        else if (step === 5) {
          if (text.toLowerCase() === 'risk') {
            current.draft.rules = [...current.draft.rules.filter((r) => !RISK_FIELDS.includes(r.field)), ...TEST_RISK_RULES];
          } else if (text.toLowerCase() !== 'none') {
            if (current.draft.pendingRequirements.length >= 2) return { chat_id: id, text: 'Two unresolved descriptions are already retained. Use /agent to review, or /cancel to discard the draft and combine your instructions in a new one.' };
            current.draft.pendingRequirements.push(text);
          }
        }
        else if (value) current.draft.rules.push(value);
        current.draft.step++;
      } else return view(current, id);
      current.revision++;
      store.put(id, current);
      return view(current, id);
    });
  };
}

