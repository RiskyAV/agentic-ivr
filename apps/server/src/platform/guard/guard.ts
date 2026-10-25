import type { LlmClient } from '../llm/types.js';
import { classify } from './classifier.js';
import { rules } from './rules.js';
import type { Guard as GuardContract, GuardContext, GuardVerdict } from './types.js';

export { refusalFor } from './refusal.js';

/** Malicious-input guard (D-026): sync rules first, then a small-model classifier. Never throws; failures allow. */
export class Guard implements GuardContract {
  constructor(
    private readonly llm: LlmClient,
    private readonly model: string,
    private readonly log: (msg: string, err?: unknown) => void = (m, e) => console.warn(`[guard] ${m}`, e ?? ''),
  ) {}

  async check(text: string, ctx: GuardContext, signal: AbortSignal): Promise<GuardVerdict> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);

    const hit = rules(text, ctx);
    if (hit) return { verdict: 'block', category: hit.category, by: 'rules', ms: ms() };
    if (signal.aborted) return { verdict: 'allow', by: 'timeout', ms: ms() };

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    try {
      const r = await Promise.race([classify(this.llm, this.model, text, ctl.signal), aborted]);
      if (r === 'aborted') return { verdict: 'allow', by: 'timeout', ms: ms() };
      if (!r) {
        this.log('classifier output unparseable; allowing');
        return { verdict: 'allow', by: 'model', ms: ms() };
      }
      return { verdict: r.verdict, ...(r.category && { category: r.category }), by: 'model', ms: ms() };
    } catch (err) {
      if (signal.aborted) return { verdict: 'allow', by: 'timeout', ms: ms() };
      this.log('classifier failed; allowing', err);
      return { verdict: 'allow', by: 'timeout', ms: ms() };
    } finally {
      signal.removeEventListener('abort', onAbort);
      ctl.abort();
    }
  }
}
