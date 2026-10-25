import { describe, expect, it } from 'vitest';
import type { LlmChunk, LlmMessage } from './types.js';
import { StubLlm } from './stub.js';

async function collect(it: AsyncIterable<LlmChunk>) {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const sig = new AbortController().signal;
const req = (messages: LlmMessage[]) => ({ system: '', tools: [], messages });

describe('StubLlm', () => {
  const llm = new StubLlm([
    {
      match: /emi/i,
      script: [
        [{ type: 'tool_calls', calls: [{ id: 'c1', name: 'explain_emi_change', args: {} }] }],
        [{ type: 'text', text: 'Your EMI is {{emi_change.new_emi}}.' }],
      ],
    },
  ]);

  it('advances steps per LLM call and resets on a new user message', async () => {
    const u1: LlmMessage = { role: 'user', text: 'why did my EMI go up' };
    const first = await collect(llm.stream(req([u1]), sig));
    expect(first[0]).toMatchObject({ type: 'tool_calls' });
    const second = await collect(llm.stream(req([u1, { role: 'assistant', toolCalls: [] }, { role: 'tool', results: [] }]), sig));
    expect(second[0]).toMatchObject({ type: 'text' });
    const again = await collect(llm.stream(req([u1, { role: 'assistant', text: 'x' }, { role: 'user', text: 'EMI again' }]), sig));
    expect(again[0]).toMatchObject({ type: 'tool_calls' });
    expect(first.at(-1)).toMatchObject({ type: 'done' });
  });

  it('unmatched text gets the fixed reply', async () => {
    const out = await collect(llm.stream(req([{ role: 'user', text: 'hello there' }]), sig));
    expect(out[0]).toEqual({ type: 'text', text: 'I can help with your loan account.' });
  });

  it('delays per chunk and honours abort', async () => {
    const slow = new StubLlm([], { chunkDelayMs: 30 });
    const t0 = Date.now();
    await collect(slow.stream(req([{ role: 'user', text: 'hi' }]), sig));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const ac = new AbortController();
    const p = collect(slow.stream(req([{ role: 'user', text: 'hi' }]), ac.signal));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
