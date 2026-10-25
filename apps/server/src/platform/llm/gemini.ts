import { GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig, type GenerateContentResponse, type Part } from '@google/genai';
import type { LlmChunk, LlmClient, LlmMessage, LlmRequest, ToolCall } from './types.js';

/** `GEMINI_THINKING`: minimal | low | medium | high | off | <token budget>. Default minimal. */
export function thinkingConfig(setting: string | undefined = process.env.GEMINI_THINKING): GenerateContentConfig['thinkingConfig'] {
  const s = (setting ?? 'minimal').trim().toLowerCase();
  if (s === 'off' || s === '0') return { thinkingBudget: 0 };
  if (/^\d+$/.test(s)) return { thinkingBudget: Number(s) };
  const levels: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH,
  };
  return { thinkingLevel: levels[s] ?? ThinkingLevel.MINIMAL };
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
        parts.push({ functionCall: { id: c.id, name: c.name, args: (c.args ?? {}) as Record<string, unknown> } });
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
  private readonly noMinimal = new Set<string>();

  constructor(apiKey: string, private readonly defaultModel: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const config: GenerateContentConfig = {
      systemInstruction: req.system,
      temperature: req.temperature ?? 0.2,
      abortSignal: signal,
      thinkingConfig: thinkingConfig(),
      ...(req.tools.length > 0 && { tools: [{ functionDeclarations: req.tools as any }] }),
      ...(req.jsonSchema && { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema }),
    };
    const model = req.model ?? this.defaultModel;
    const contents = toContents(req.messages);
    // Some models reject ThinkingLevel.MINIMAL (e.g. gemini-3.8-flash); fall back to LOW and remember it per model.
    if (config.thinkingConfig?.thinkingLevel === ThinkingLevel.MINIMAL && this.noMinimal.has(model)) {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
    let stream;
    try {
      stream = await this.ai.models.generateContentStream({ model, contents, config });
    } catch (e) {
      if (config.thinkingConfig?.thinkingLevel !== ThinkingLevel.MINIMAL || !/thinking level/i.test(String((e as Error).message))) throw e;
      this.noMinimal.add(model);
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      stream = await this.ai.models.generateContentStream({ model, contents, config });
    }
    const calls: ToolCall[] = [];
    let usage: GenerateContentResponse['usageMetadata'];
    let n = 0;
    for await (const chunk of stream) {
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall?.name) {
          calls.push({ id: part.functionCall.id ?? `call_${++n}`, name: part.functionCall.name, args: part.functionCall.args ?? {} });
        } else if (part.text) {
          yield { type: 'text', text: part.text };
        }
      }
    }
    if (calls.length > 0) yield { type: 'tool_calls', calls };
    yield {
      type: 'done',
      ...(usage && {
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          ...(usage.cachedContentTokenCount != null && { cachedTokens: usage.cachedContentTokenCount }),
          outputTokens: usage.candidatesTokenCount ?? 0,
        },
      }),
    };
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
