/**
 * Small, deterministic text rules for the voice channel: confirmations, refusals, barge-in triggers and the
 * self-echo guard. No model is involved, so a spoken "yes" can never be talked into something else (D-048).
 */

/** Lowercase, drop punctuation (keeping letters, digits and spaces), collapse whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (text: string): string[] => (normalise(text) ? normalise(text).split(' ') : []);

const AFFIRMATIONS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'confirm', 'confirmed', 'please do',
  'haan', 'haan ji', 'han', 'han ji', 'ha ji', 'theek hai', 'thik hai', 'yes please', 'yes go ahead', 'yes do it',
  'yes confirm', 'yes please go ahead', 'ok go ahead', 'okay go ahead', 'sure go ahead', 'yes sure', 'please go ahead',
  'yes thats right', 'thats right', 'correct', 'yes correct',
]);

const NEGATIONS = new Set([
  'no', 'nope', 'nah', 'no thanks', 'no thank you', 'cancel', 'cancel it', 'cancel that', 'cancel this', 'dont',
  'dont do it', 'do not', 'no dont', 'no cancel', 'no cancel it', 'no dont do it', 'never mind', 'nevermind',
  'nahi', 'nahin', 'mat karo', 'no no', 'please cancel', 'not now', 'no not now',
]);

/** True only when the whole utterance is a plain yes ("yes but…" is not). */
export function isAffirmation(text: string): boolean {
  return AFFIRMATIONS.has(normalise(text));
}

/** True only when the whole utterance is a plain no/cancel. */
export function isNegation(text: string): boolean {
  return NEGATIONS.has(normalise(text));
}

/** Words that carry no intent on their own: they never count towards barge-in and never start a turn. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'ok', 'okay', 'ah', 'er', 'erm', 'oh']);
const KEYWORDS = /(?:^| )(?:stop|wait|hold on|ruko|one second|actually)(?: |$)/;

export function isFillerOnly(text: string): boolean {
  return tokens(text).every((t) => FILLERS.has(t));
}

/** Words that count towards a barge-in (fillers excluded). */
export const realWords = (text: string): number => tokens(text).filter((t) => !FILLERS.has(t)).length;

/** Why a partial transcript should interrupt the assistant, or null. */
export function bargeInTrigger(text: string, minWords: number): 'keyword' | 'words' | null {
  if (KEYWORDS.test(normalise(text))) return 'keyword';
  return realWords(text) >= minWords ? 'words' : null;
}

/**
 * Cheap self-echo guard: a transcript is treated as the assistant's own voice leaking into the mic when at least
 * 70% of its words appear in what was recently sent to TTS (the caller passes the last ~200 characters).
 */
export function isEcho(heard: string, spokenTail: string, threshold = 0.7): boolean {
  const h = tokens(heard);
  if (h.length === 0 || !spokenTail) return false;
  const said = new Set(tokens(spokenTail));
  const hit = h.filter((t) => said.has(t)).length;
  return hit / h.length >= threshold;
}

/** "SR-482100" -> "SR 4 8 2 1 0 0": letters stay together, digits are read one by one. */
export function spellReference(ref: string): string {
  return ref
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.replace(/\d/g, (d) => ` ${d} `).replace(/\s+/g, ' ').trim())
    .join(' ');
}
