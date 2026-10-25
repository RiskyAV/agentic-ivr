import { GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig, type GenerateContentResponse, type Part } from '@google/genai';
import type { LlmChunk, LlmClient, LlmMessage, LlmRequest, ToolCall } from './types.js';

type Thinking = GenerateContentConfig['thinkingConfig'];

/**
 * Thinking config per model family. `GEMINI_THINKING` (minimal | low | medium | high | off | <token budget>) overrides;
 * unset means auto: 2.5 models get budget 0 (2.5-pro cannot disable thinking, so its minimum), 3.x models get level LOW,
 * anything else is left at the model default.
 */
export function thinkingFor(model: string, setting: string | undefined = process.env.GEMINI_THINKING): Thinking {
  const s = (setting ?? '').trim().toLowerCase();
  if (s === 'off' || s === '0') return { thinkingBudget: model.includes('2.5-pro') ? 128 : 0 };
  if (/^\d+$/.test(s)) return { thinkingBudget: Number(s) };
  const levels: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH,
  };
  if (levels[s]) return { thinkingLevel: levels[s]! };
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: model.includes('2.5-pro') ? 128 : 0 };
  if (/gemini-3/.test(model)) return { thinkingLevel: ThinkingLevel.LOW };
  return undefined;
}

/** Maps neutral messages to Gemini contents; consecutive same-role turns are merged. */
export function toContents(messages: LlmMessage[]): Content[] {
  const out: Content[] = [];
  const push = (role: 'user' | 'model', parts: Part[]) => {
    if (parts.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.parts!.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ text: m.text }]);
    else if (m.role === 'assistant') {
      const parts: Part[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) {
        parts.push({
          functionCall: { id: c.id, name: c.name, args: (c.args ?? {}) as Record<string, unknown> },
          ...(c.thoughtSignature && { thoughtSignature: c.thoughtSignature }),
        });
      }
      push('model', parts);
    } else {
      push('user', m.results.map((r) => ({
        functionResponse: { id: r.callId, name: r.name, response: toResponseObject(r.response) },
      })));
    }
  }
  return out;
}

function toResponseObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
}

export class GeminiClient implements LlmClient {
  readonly ai: GoogleGenAI;

  constructor(apiKey: string, private readonly defaultModel: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const model = req.model ?? this.defaultModel;
    const config: GenerateContentConfig = {
      systemInstruction: req.system,
      temperature: req.temperature ?? 0.2,
      abortSignal: signal,
      ...(req.tools.length > 0 && { tools: [{ functionDeclarations: req.tools as any }] }),
      ...(req.jsonSchema && { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema }),
    };
    const thinking = thinkingFor(model);
    if (thinking) config.thinkingConfig = thinking;
    const contents = toContents(req.messages);
    let stream;
    try {
      stream = await this.ai.models.generateContentStream({ model, contents, config });
    } catch (e) {
      // One-shot fallback, only for an HTTP 400 that complains about thinking.
      if (!thinking || (e as { status?: number }).status !== 400 || !/thinking/i.test(String((e as Error).message))) throw e;
      const fallback: Thinking = thinking.thinkingLevel === ThinkingLevel.MINIMAL ? { thinkingLevel: ThinkingLevel.LOW } : undefined;
      console.warn(`[gemini] ${model} rejected thinking config ${JSON.stringify(thinking)}; retrying with ${JSON.stringify(fallback ?? 'model default')}`);
      if (fallback) config.thinkingConfig = fallback; else delete config.thinkingConfig;
      stream = await this.ai.models.generateContentStream({ model, contents, config });
    }
    yield* mapResponses(stream);
  }

  /** Model ids the key can see, without the `models/` prefix. */
  async listModels(): Promise<string[]> {
    const names: string[] = [];
    const pager = await this.ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) if (m.name) names.push(m.name.replace(/^models\//, ''));
    return names;
  }
}

/** Returns the configured model names the API does not list. Call once at startup and log a warning. */
export async function checkModels(client: Pick<GeminiClient, 'listModels'>, names: string[]): Promise<string[]> {
  const have = new Set(await client.listModels());
  return names.filter((n) => !have.has(n));
}

const BLOCKING_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

/** Maps Gemini stream responses to neutral chunks. Pure over the response objects, so it is unit-testable. */
export async function* mapResponses(stream: AsyncIterable<GenerateContentResponse>): AsyncIterable<LlmChunk> {
  const calls: ToolCall[] = [];
  let usage: GenerateContentResponse['usageMetadata'];
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let n = 0;
  for await (const chunk of stream) {
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blockReason = String(chunk.promptFeedback.blockReason);
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) finishReason = String(cand.finishReason);
    for (const part of cand?.content?.parts ?? []) {
      if (part.thought) continue;
      if (part.functionCall?.name) {
        calls.push({
          id: part.functionCall.id ?? `call_${++n}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
        });
      } else if (part.text) {
        yield { type: 'text', text: part.text };
      }
    }
  }
  if (calls.length > 0) yield { type: 'tool_calls', calls };
  const blocked = blockReason != null || (finishReason != null && BLOCKING_FINISH.has(finishReason));
  yield {
    type: 'done',
    ...(finishReason && { finishReason }),
    ...(blocked && { blocked: true }),
    ...(usage && {
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        ...(usage.cachedContentTokenCount != null && { cachedTokens: usage.cachedContentTokenCount }),
        outputTokens: usage.candidatesTokenCount ?? 0,
      },
    }),
  };
}
