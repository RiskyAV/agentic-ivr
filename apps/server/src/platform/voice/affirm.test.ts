import { describe, expect, it } from 'vitest';
import { bargeInTrigger, isAffirmation, isEcho, isFillerOnly, isNegation, spellReference } from './affirm.js';

describe('isAffirmation', () => {
  it('accepts whole-utterance affirmations only', () => {
    expect(isAffirmation('Yes, go ahead.')).toBe(true);
    expect(isAffirmation('haan ji')).toBe(true);
    expect(isAffirmation('Okay.')).toBe(true);
    expect(isAffirmation('Theek hai')).toBe(true);
    expect(isAffirmation('yes please')).toBe(true);
    expect(isAffirmation('yes but 30k')).toBe(false);
    expect(isAffirmation('yes but make it 30k')).toBe(false);
    expect(isAffirmation('no')).toBe(false);
    expect(isAffirmation('')).toBe(false);
  });
});

describe('isNegation', () => {
  it('accepts whole-utterance refusals only', () => {
    for (const t of ['No.', 'Cancel', "Don't", 'no thanks', 'cancel that', 'Nahi']) expect(isNegation(t)).toBe(true);
    for (const t of ['no wait, make it 30k', 'yes', 'cancel my other request too']) expect(isNegation(t)).toBe(false);
  });
});

describe('bargeInTrigger', () => {
  it('needs two real words, or a keyword; fillers never count', () => {
    expect(bargeInTrigger('um', 2)).toBeNull();
    expect(bargeInTrigger('uh hmm', 2)).toBeNull();
    expect(bargeInTrigger('ok', 2)).toBeNull();
    expect(bargeInTrigger('yes', 2)).toBeNull();
    expect(bargeInTrigger('stop', 2)).toBe('keyword');
    expect(bargeInTrigger('Hold on', 2)).toBe('keyword');
    expect(bargeInTrigger('ruko', 2)).toBe('keyword');
    expect(bargeInTrigger('actually check my', 2)).toBe('keyword');
    expect(bargeInTrigger('check my', 2)).toBe('words');
    expect(bargeInTrigger('um check', 2)).toBeNull();
  });
});

describe('isEcho', () => {
  it('flags transcripts that mostly repeat what the assistant is saying', () => {
    const tail = 'Prepay fifty thousand rupees on loan HL-88231 to reduce your tenure. Shall I go ahead?';
    expect(isEcho('go ahead', tail)).toBe(true);
    expect(isEcho('reduce your tenure', tail)).toBe(true);
    expect(isEcho('yes', tail)).toBe(false);
    expect(isEcho('actually check my last payment', tail)).toBe(false);
    expect(isEcho('', tail)).toBe(false);
  });
});

describe('isFillerOnly / spellReference', () => {
  it('works', () => {
    expect(isFillerOnly('Um, hmm.')).toBe(true);
    expect(isFillerOnly('um what')).toBe(false);
    expect(spellReference('SR-482100')).toBe('SR 4 8 2 1 0 0');
  });
});
