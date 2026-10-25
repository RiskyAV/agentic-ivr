import type { RefusalFn } from './types.js';

const BY_CATEGORY: Record<string, string> = {
  cross_customer: 'I can only help with your own accounts.',
  injection: "I can't change how I work, but I'm happy to help with your loan.",
  prompt_extraction: "I can't share details about my internal setup, but I'm happy to help with your loan.",
  impersonation: "I can't act on claims of special authority, but I can help with your own account.",
  coercion: "I can't override our policies, but I can raise a request for review if you'd like.",
  abuse: "I'd like to keep this conversation respectful so I can help you properly.",
};
const GENERIC = "I'm sorry, I can't help with that request.";
const HANDOFF = " If you'd like, I can connect you with a member of our team.";

/** Category-specific polite refusal; `strikes` already includes the blocked turn. From 2 strikes it also offers a human. */
export const refusalFor: RefusalFn = (category, strikes) =>
  (category && BY_CATEGORY[category] ? BY_CATEGORY[category]! : GENERIC) + (strikes >= 2 ? HANDOFF : '');
