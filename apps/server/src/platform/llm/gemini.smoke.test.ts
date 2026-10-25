import { describe, expect, it } from 'vitest';
import { checkModels, GeminiClient } from './gemini.js';
import type { LlmChunk } from './types.js';

try {
  if (!process.env.GEMINI_API_KEY) process.loadEnvFile(new URL('../../../../../.env', import.meta.url).pathname);
} catch { /* no .env: smoke test is skipped */ }

async function collect(it: AsyncIterable<LlmChunk>) {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe.skipIf(!process.env.GEMINI_API_KEY)('Gemini smoke (real API)', () => {
  const model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const client = new GeminiClient(process.env.GEMINI_API_KEY!, model);

  it('streams text', async () => {
    const t0 = Date.now();
    let first = -1;
    const chunks: LlmChunk[] = [];
    for await (const c of client.stream({ system: 'Be brief.', tools: [], messages: [{ role: 'user', text: 'Say hi in three words.' }] }, new AbortController().signal)) {
      if (first < 0) first = Date.now() - t0;
      chunks.push(c);
    }
    console.log(`gemini smoke: first chunk ${first}ms, total ${Date.now() - t0}ms, model ${model}`);
    expect(chunks.some((c) => c.type === 'text' && c.text.length > 0)).toBe(true);
    expect(chunks.at(-1)?.type).toBe('done');
  }, 30_000);

  it('returns tool_calls when told to call a tool', async () => {
    const chunks = await collect(client.stream({
      system: 'Always call the get_loan_details tool to answer.',
      tools: [{ name: 'get_loan_details', description: 'Get loan details', parameters: { type: 'object', properties: { loanId: { type: 'string' } } } }],
      messages: [{ role: 'user', text: 'Show my loan details for loan HL-1.' }],
    }, new AbortController().signal));
    const calls = chunks.find((c) => c.type === 'tool_calls');
    expect(calls && calls.type === 'tool_calls' && calls.calls[0]?.name).toBe('get_loan_details');
  }, 30_000);

  it('round-trips a function response back to a text answer (thought signatures replayed)', async () => {
    const tools = [{ name: 'get_code', description: 'Returns the secret code', parameters: { type: 'object' as const, properties: {} } }];
    const system = 'Call get_code, then tell the user the code it returned.';
    const user = { role: 'user' as const, text: 'What is the secret code?' };
    const first = await collect(client.stream({ system, tools, messages: [user] }, new AbortController().signal));
    const tc = first.find((c) => c.type === 'tool_calls');
    if (!tc || tc.type !== 'tool_calls') throw new Error('no tool call');
    const second = await collect(client.stream({
      system, tools,
      messages: [user, { role: 'assistant', toolCalls: tc.calls }, { role: 'tool', results: tc.calls.map((c) => ({ callId: c.id, name: c.name, response: { code: 'ZEBRA-42' } })) }],
    }, new AbortController().signal));
    const text = second.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
    expect(text).toMatch(/ZEBRA-42/);
  }, 30_000);

  it('checkModels reports missing names', async () => {
    const missing = await checkModels(client, [model, 'definitely-not-a-model-xyz']);
    expect(missing).toContain('definitely-not-a-model-xyz');
  }, 30_000);
});
