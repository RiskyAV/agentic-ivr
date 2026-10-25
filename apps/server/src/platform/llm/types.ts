import type { FunctionDeclaration } from '../tools/types.js';

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: { callId: string; name: string; response: unknown }[] };

export type LlmChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; usage?: { inputTokens: number; cachedTokens?: number; outputTokens: number } };

export interface LlmRequest {
  model?: string;
  system: string;
  tools: FunctionDeclaration[];
  messages: LlmMessage[];
  temperature?: number;
  /** When set, the model must answer with JSON matching this schema (guard classifier). */
  jsonSchema?: object;
}

export interface LlmClient {
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk>;
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
