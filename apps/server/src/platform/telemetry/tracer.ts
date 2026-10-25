import type { Channel, SpanView, TurnTrace } from '@app/shared';
import type { CallEvent, CallObserver } from '../connectors/resilientClient.js';

type Attrs = Record<string, string | number | boolean>;

export class TurnTracer {
  private readonly t0: number;
  private readonly spans: SpanView[] = [];
  private readonly metrics: Record<string, number> = {};
  guard?: TurnTrace['guard'];

  constructor(
    readonly turnId: string,
    readonly channel: Channel,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.t0 = this.now();
  }

  private rel(): number {
    return Math.round((this.now() - this.t0) * 100) / 100;
  }

  span(name: string, attrs?: Attrs): (endAttrs?: Attrs) => void {
    const span: SpanView = { name, startMs: this.rel(), endMs: this.rel(), ...(attrs && { attrs: { ...attrs } }) };
    this.spans.push(span);
    let ended = false;
    return (endAttrs) => {
      if (ended) return;
      ended = true;
      span.endMs = this.rel();
      if (endAttrs) span.attrs = { ...span.attrs, ...endAttrs };
    };
  }

  mark(name: string): void {
    const t = this.rel();
    this.spans.push({ name, startMs: t, endMs: t });
  }

  setMetric(name: string, value: number): void {
    this.metrics[name] = value;
  }

  /** Each backend call becomes a `backend:<system>` span ending now and starting `ms` earlier. */
  readonly observer: CallObserver = {
    onCall: (e: CallEvent) => {
      const end = this.rel();
      this.spans.push({
        name: `backend:${e.system}`,
        startMs: Math.max(0, Math.round((end - e.ms) * 100) / 100),
        endMs: end,
        attrs: {
          key: e.key,
          attempt: e.attempt,
          hedged: e.hedged,
          outcome: e.outcome,
          ...(e.status !== undefined && { status: e.status }),
        },
      });
    },
  };

  toTrace(): TurnTrace {
    return {
      turnId: this.turnId,
      channel: this.channel,
      spans: this.spans.map((s) => ({ ...s })),
      metrics: { ...this.metrics },
      ...(this.guard && { guard: this.guard }),
    };
  }
}
