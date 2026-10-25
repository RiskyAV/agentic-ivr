import { abortError, type LlmChunk, type LlmClient, type LlmMessage, type LlmRequest } from './types.js';

export interface StubRule {
  match: RegExp;
  script: LlmChunk[][];
}

export const STUB_FALLBACK = 'I can help with your loan account.';

/**
 * Deterministic LLM for tests, load runs and e2e. The script step is the number of LLM calls made
 * since the last user message, so a tool round-trip advances the script and a new question restarts it.
 */
export class StubLlm implements LlmClient {
  constructor(private readonly rules: StubRule[], private readonly opts: { chunkDelayMs?: number } = {}) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
    const lastUser = lastUserIndex(req.messages);
    const text = lastUser >= 0 ? (req.messages[lastUser] as { text: string }).text : '';
    const step = req.messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
    const rule = this.rules.find((r) => r.match.test(text));
    const chunks: LlmChunk[] = rule
      ? rule.script[Math.min(step, rule.script.length - 1)] ?? []
      : [{ type: 'text', text: STUB_FALLBACK }];
    for (const c of chunks) {
      await this.delay(signal);
      yield c;
    }
    if (!chunks.some((c) => c.type === 'done')) yield { type: 'done', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  private async delay(signal: AbortSignal) {
    if (signal.aborted) throw abortError();
    const ms = this.opts.chunkDelayMs ?? 0;
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); reject(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function lastUserIndex(ms: LlmMessage[]): number {
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i]!.role === 'user') return i;
  return -1;
}
