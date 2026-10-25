import { ThinkingLevel, type GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { mapResponses, thinkingFor, toContents } from './gemini.js';
import type { LlmChunk } from './types.js';

async function* gen(rs: unknown[]) { for (const r of rs) yield r as GenerateContentResponse; }
async function collect(rs: unknown[]) {
  const out: LlmChunk[] = [];
  for await (const c of mapResponses(gen(rs))) out.push(c);
  return out;
}

describe('thinkingFor', () => {
  it('picks per model family when unset', () => {
    expect(thinkingFor('gemini-2.5-flash', '')).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor('gemini-2.5-flash-lite', undefined)).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor('gemini-2.5-pro', '')).toEqual({ thinkingBudget: 128 });
    expect(thinkingFor('gemini-3.8-flash', '')).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(thinkingFor('gemini-3.5-flash-lite', undefined)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(thinkingFor('some-other-model', '')).toBeUndefined();
  });
  it('GEMINI_THINKING overrides', () => {
    expect(thinkingFor('gemini-3.8-flash', 'minimal')).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(thinkingFor('gemini-3.8-flash', 'off')).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor('gemini-2.5-flash', 'high')).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
    expect(thinkingFor('gemini-2.5-flash', '256')).toEqual({ thinkingBudget: 256 });
  });
});

describe('thought signatures', () => {
  it('are captured from functionCall parts and replayed unchanged', async () => {
    const out = await collect([
      { candidates: [{ content: { parts: [{ functionCall: { name: 'a', args: { x: 1 } }, thoughtSignature: 'SIG1' }, { functionCall: { name: 'b', args: {} } }] } }] },
    ]);
    const calls = (out[0] as Extract<LlmChunk, { type: 'tool_calls' }>).calls;
    expect(calls[0]).toMatchObject({ name: 'a', thoughtSignature: 'SIG1' });
    expect(calls[1]!.thoughtSignature).toBeUndefined();
    const contents = toContents([{ role: 'assistant', toolCalls: calls }]);
    expect(contents[0]!.parts![0]).toMatchObject({ functionCall: { name: 'a' }, thoughtSignature: 'SIG1' });
    expect(contents[0]!.parts![1]).not.toHaveProperty('thoughtSignature');
  });
});

describe('done chunk', () => {
  it('reports finishReason and usage; not blocked on STOP', async () => {
    const out = await collect([
      { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 3, candidatesTokenCount: 2 } },
    ]);
    expect(out.at(-1)).toEqual({ type: 'done', finishReason: 'STOP', usage: { inputTokens: 5, cachedTokens: 3, outputTokens: 2 } });
  });
  it('flags a SAFETY finish as blocked', async () => {
    const out = await collect([{ candidates: [{ finishReason: 'SAFETY' }] }]);
    expect(out).toEqual([{ type: 'done', finishReason: 'SAFETY', blocked: true }]);
  });
  it('flags a prompt block with no candidates', async () => {
    const out = await collect([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]);
    expect(out).toEqual([{ type: 'done', blocked: true }]);
  });
  it('an empty response is just done, not blocked', async () => {
    expect(await collect([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }])).toEqual([{ type: 'done', finishReason: 'MAX_TOKENS' }]);
  });
});
