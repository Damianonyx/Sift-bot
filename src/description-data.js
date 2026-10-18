import { validateRules } from './rules.js';

export const validDescription = text => typeof text==='string' && text.trim().length>0 && text.length<=800 && !/[\p{Cf}\u0000-\u0008\u000b-\u001f\u007f]/u.test(text);
const riskWords = /\b(dev(?:eloper)?|lock(?:ed|s)?|burn(?:ed|t)?|protect\w*|bundl\w*|coordinat\w*|wallet\w*|holder\w*|mint(?:ing)?|freez\w*|authorit\w*|honeypot\w*|rug\w*|safe\w*|suspicious|profit\w*|guarantee\w*|tax\w*|social\w*|twitter|telegram|renounc\w*|snip\w*|insider\w*|ethereum|bsc|polygon|sui|bnb)\b/i;
const numberText='\\$?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,6})?[km]?';
const amount=text=>{const suffix=text.at(-1)?.toLowerCase();return Number(text.replace(/[$,km]/gi,''))*({k:1000,m:1e6}[suffix]??1);};
const requiredKeys = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');

export function validateInterpretation(value, text) {
  if (!validDescription(text) || !requiredKeys(value,['rules','unresolved']) || !Array.isArray(value.rules) || value.rules.length>4 ||
      !Array.isArray(value.unresolved) || value.unresolved.length>20 || value.unresolved.some(s=>!validDescription(s)||!text.includes(s))) throw Error('Invalid interpretation');
  const rules=value.rules.map(item=>{
    if(!requiredKeys(item,['field','mode','min','max','value','evidence']) || !validDescription(item.evidence) || !text.includes(item.evidence) || riskWords.test(item.evidence)) throw Error('Unsupported interpretation');
    const warning=/\b(warn(?:ing)?|flag|optional)\b/i.test(item.evidence);
    if ((item.mode==='warn')!==warning) throw Error('Changed requirement strength');
    const numbers=[...item.evidence.matchAll(new RegExp(numberText,'gi'))].map(m=>amount(m[0]));
    const numeric=n=>Number.isFinite(n)&&n>=0&&n<=1e12&&numbers.includes(n);
    if(item.field==='marketCap') {
      if(!/\b(market\s*cap|mc)\b/i.test(item.evidence) || item.value!==null || !numeric(item.min)||!numeric(item.max)) throw Error('Invented threshold');
      return {field:item.field,mode:item.mode,min:item.min,max:item.max};
    }
    if(!['liquidityUsd','volume1h','poolAgeMinutes'].includes(item.field) || item.min!==null || item.max!==null || !numeric(item.value)) throw Error('Unsupported rule');
    if(item.field==='liquidityUsd' && !/\bliquidity\b/i.test(item.evidence) ||
       item.field==='volume1h' && (!/\bvolume\b/i.test(item.evidence) || !/\b(1h|1 hour|one.hour)\b/i.test(item.evidence)) ||
       item.field==='poolAgeMinutes' && (!/\bpool\b/i.test(item.evidence) || !/\b(?:minutes?|mins?)\b/i.test(item.evidence))) throw Error('Unsupported measurement');
    if(item.field!=='poolAgeMinutes' && /\b(at most|below|less than|under|max(?:imum)?)\b|<=/i.test(item.evidence) ||
       item.field==='poolAgeMinutes' && /\b(at least|above|more than|over|min(?:imum)?)\b|>=/i.test(item.evidence)) throw Error('Unsupported direction');
    return {field:item.field,mode:item.mode,value:item.value};
  });
  validateRules(rules,{requireStrict:false});
  // Market interpretation never claims to resolve chain evidence or safety.
  // Keep the complete original wording if any risk requirement was mentioned.
  const unresolved = riskWords.test(text) ? [text] : value.unresolved;
  return {rules,unresolved:unresolved.length?[unresolved.join('\n').length<=800?unresolved.join('\n'):text]:[]};
}

export function parseDescription(text) {
  if(!validDescription(text))throw Error('Invalid description');
  const rules=[],unresolved=[];
  for(const original of text.split(/[;\n]+/).filter(s=>s.trim())) {
    let clause=original.trim().replace(/[.]$/,'').replace(/^(?:find(?: me)?|show me)\s+(?:solana\s+)?(?:a coin|coins|tokens)\s+(?:with\s+)?/i,'');
    const mode=/^(?:warn|flag)\b/i.test(clause)?'warn':'require';
    clause=clause.replace(/^(?:require|warn|flag)\s+/i,'');
    let rule=null;
    const cap=new RegExp(`^(?:market cap|marketcap|mc)\\s*(?:between|from)?\\s*(${numberText})\\s*(?:to|and|[-–—])\\s*(${numberText})(?:\\s+USD)?$`,'i').exec(clause);
    if(cap)rule={field:'marketCap',mode,min:amount(cap[1]),max:amount(cap[2]),value:null};
    const minimum=new RegExp(`^(liquidity|(?:1h|one.hour) volume|volume (?:over the last |over |in )?1h)\\s*(?:at least|minimum|min|>=)\\s*(${numberText})(?:\\s+USD)?$`,'i').exec(clause);
    if(minimum)rule={field:minimum[1].toLowerCase()==='liquidity'?'liquidityUsd':'volume1h',mode,min:null,max:null,value:amount(minimum[2])};
    const age=/^pool age\s*(?:at most|maximum|max|<=)\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)$/i.exec(clause);
    if(age)rule={field:'poolAgeMinutes',mode,min:null,max:null,value:Number(age[1])};
    if(rule && !rules.some(r=>r.field===rule.field))rules.push({...rule,evidence:original});else unresolved.push(original);
  }
  try {return {...validateInterpretation({rules,unresolved},text),engine:'Local parser'};}
  catch {return {rules:[],unresolved:[text],engine:'Local parser'};}
}

export const INTERPRETATION_SCHEMA={type:'object',additionalProperties:false,required:['rules','unresolved'],properties:{
  rules:{type:'array',items:{type:'object',additionalProperties:false,required:['field','mode','min','max','value','evidence'],properties:{
    field:{type:'string',enum:['marketCap','liquidityUsd','volume1h','poolAgeMinutes']},mode:{type:'string',enum:['require','warn']},
    min:{type:['number','null']},max:{type:['number','null']},value:{type:['number','null']},evidence:{type:'string'},
  }}},unresolved:{type:'array',items:{type:'string'}},
}};
