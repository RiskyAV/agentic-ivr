/** A reply must not claim a request was submitted or done before the customer confirmed. */
export const NOT_DONE = [
  'has been submitted', 'been submitted', 'submitted for processing', 'confirmation has been received', 'has been executed',
  'has been placed', 'successfully processed', 'is now complete', 'request has been raised', 'i have submitted', 'i have processed',
];
/** On the text channel the customer taps Confirm: never "say yes". */
export const NO_SAY_YES = ['by saying yes', 'saying yes', 'say yes', 'reply yes', 'type yes', 'type confirm', 'say confirm', 'say "yes"'];
export const PROPOSAL_TEXT_GUARD = [...NO_SAY_YES, ...NOT_DONE];
