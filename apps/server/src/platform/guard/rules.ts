import type { GuardCategory, GuardContext } from './types.js';

export interface RuleHit {
  category: GuardCategory;
  rule: string;
}

const I = 'i';
const AUTH = '(?:authori[sz]ed|approved|sanctioned|cleared)';

const PATTERNS: { category: GuardCategory; rule: string; re: RegExp }[] = [
  { category: 'injection', rule: 'ignore_instructions', re: new RegExp(String.raw`\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous\s+|prior\s+|above\s+|earlier\s+|system\s+)*(?:instructions?|rules|guidelines|directives|prompts?)\b`, I) },
  { category: 'injection', rule: 'you_are_now', re: new RegExp(String.raw`\byou\s+are\s+now\b`, I) },
  { category: 'injection', rule: 'developer_mode', re: new RegExp(String.raw`\b(?:developer|debug|jailbreak|dan)\s+mode\b`, I) },
  { category: 'prompt_extraction', rule: 'system_prompt', re: new RegExp(String.raw`\bsystem\s+(?:prompt|instructions?)\b`, I) },
  // A reveal-type verb, or a hidden/system qualifier; plain "your rules/guidelines" questions are left to the classifier.
  { category: 'prompt_extraction', rule: 'reveal_instructions', re: new RegExp(String.raw`\b(?:reveal|print|repeat|leak|dump|output)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?your\s+(?:(?:system|hidden|initial|internal|secret|original)\s+)?(?:instructions?|prompt|rules|guidelines)\b`, I) },
  { category: 'prompt_extraction', rule: 'hidden_instructions', re: new RegExp(String.raw`\byour\s+(?:system|hidden|initial|internal|secret)\s+(?:prompt|instructions?)\b`, I) },
  { category: 'impersonation', rule: 'act_as', re: new RegExp(String.raw`\bact\s+as\s+(?:an?\s+|the\s+)?(?:admin|administrator|bank|manager)\b`, I) },
  { category: 'impersonation', rule: 'i_am_from_bank', re: new RegExp(String.raw`\bi(?:\s+am|'m)\s+(?:from|with)\s+(?:the\s+)?(?:bank|northstar|rbi|reserve\s+bank)\b`, I) },
  { category: 'impersonation', rule: 'i_am_staff', re: new RegExp(String.raw`\bi(?:\s+am|'m)\s+(?:the|a|an|your)\s+(?:\w+\s+){0,2}?(?:bank\s+(?:officer|employee|staff|manager)|(?:manager|admin|administrator|officer|employee|staff)\s+(?:of|at|from)\s+(?:the\s+)?(?:\w+\s+)?(?:bank|northstar|rbi)|rbi\s+(?:officer|official|inspector))\b`, I) },
];

const WAIVE = /\bwaiv(?:e|es|ed|ing|er)\b/i;
/** A claim of authority: "I'm authorised", "the manager approved", "authorised by head office". */
const AUTHORITY_CLAIMS: RegExp[] = [
  new RegExp(String.raw`\bi(?:\s+am|'m)\s+(?:fully\s+|already\s+)?${AUTH}`, I),
  new RegExp(String.raw`\bi\s+have\s+(?:the\s+)?(?:authori[sz]ation|approval)\b`, I),
  new RegExp(String.raw`\b(?:manager|supervisor|officer|admin|administrator|head|director|rbi|ceo)\s+(?:has\s+|have\s+|already\s+)*${AUTH}`, I),
];
const IMPERSONATION_CLAIM = new RegExp(String.raw`\bi(?:\s+am|'m)\s+(?:fully\s+|already\s+)?authori[sz]ed`, I);

const LOAN_ID = /\b(?:HL|PL|TW)[-\s]?\d{5}\b/gi;
const ACCOUNT_NUMBER = /\b(?:account|acct|a\/c)[\s:#=-]*(?:(?:number|no\.?|num)[\s:#=-]*)?(?:is\b[\s:#=-]*)?(\d(?:[\d -]*\d)?)/gi;
/** Rules only look at this many chars (bounds regex work); the classifier still sees the whole message. */
export const RULES_MAX_CHARS = 2000;
const normId = (id: string) => id.replace(/[^a-z0-9]/gi, '').toUpperCase();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nameRegex(name: string): RegExp | null {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null; // a single token (first name only) is too ambiguous to block on
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${parts.map(esc).join(String.raw`\s+`)}(?![\p{L}\p{N}])`, 'iu');
}

/** Synchronous, case-insensitive fast rules. Returns the first hit, or null when nothing matched. */
export function rules(text: string, ctx?: Partial<GuardContext>): RuleHit | null {
  const t = text.slice(0, RULES_MAX_CHARS).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');

  for (const p of PATTERNS) if (p.re.test(t)) return { category: p.category, rule: p.rule };

  if (WAIVE.test(t) && AUTHORITY_CLAIMS.some((re) => re.test(t))) {
    return { category: IMPERSONATION_CLAIM.test(t) ? 'impersonation' : 'coercion', rule: 'waive_with_authority' };
  }

  if (ctx?.ownedLoanIds) {
    const owned = new Set(ctx.ownedLoanIds.map(normId));
    for (const m of t.matchAll(LOAN_ID)) if (!owned.has(normId(m[0]))) return { category: 'cross_customer', rule: 'foreign_loan_id' };
  }

  for (const m of t.matchAll(ACCOUNT_NUMBER)) {
    const digits = (m[1] ?? '').replace(/\D/g, '').length;
    if (digits >= 9 && digits <= 18) return { category: 'cross_customer', rule: 'account_number' };
  }

  for (const name of ctx?.otherCustomerNames ?? []) {
    const re = nameRegex(name);
    if (re && re.test(t)) return { category: 'cross_customer', rule: 'other_customer_name' };
  }
  return null;
}
