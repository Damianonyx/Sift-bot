import { RISK_FIELDS } from './risk.js';

export function verificationLimitsButton(state, id) {
  const agent = state.draft ?? state.approved;
  if (!agent || (!agent.pendingRequirements?.length && !agent.rules?.some(r => RISK_FIELDS.includes(r.field)))) return [];
  return [[{ text:'Verification limits', callback_data:`agent:${id}:limits:${state.revision}` }]];
}

export function verificationLimitsView(state, id) {
  const agent = state.draft ?? state.approved;
  return { chat_id:id, text:[
    'Sift · Verification limits',
    agent?.pendingRequirements?.length ?
      'Your extra instructions are saved but have not been mapped to supported checks. They still block approval. Repeating them will not connect missing evidence.' :
      'Saving a risk rule does not mean Sift can verify it for every coin.',
    'Liquidity: limited selected-pool LP burns and fixed-cliff locks can be checked. At least six UTC calendar months must remain on a lock. This does not establish 100% protection across all pools; Meteora positions and unsupported lockers remain unknown.',
    'Developer: supported signed Pump create/create_v2 transactions can identify a signing creator. Current holdings and sampled direct PumpSwap sales/transfers can be checked. Delegated creation, bonding-curve sales and older/missing history remain unverified. Partial sales are flagged; transfers are separate. No claim of “never sold”.',
    'Bundles/coordinated buying: observed atomic multi-wallet buys or a verified supplied Jito bundle can establish an exclusion. Suspicions are flagged. Sift cannot establish complete bundle coverage or return a verified pass for this requirement. The full risk policy therefore cannot currently produce qualifying alerts.',
    'Unknown required evidence continues to block matches. /risk <CA> shows a manual evidence report, including which transaction samples were available.',
    '/riskrules only previews an explicit replacement of ALL extra instructions with a selected-pool policy. It does not fix missing coverage or preserve a wider all-pools requirement. Keep your current draft if the scope differs.',
    'Read-only review. Your saved instructions, approval and scan state are unchanged.',
  ].join('\n\n') };
}
