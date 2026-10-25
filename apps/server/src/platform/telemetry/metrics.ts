import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const WINDOW = 500;

function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export class Metrics {
  private readonly samples = new Map<string, number[]>();
  private loop?: IntervalHistogram;

  record(name: string, ms: number): void {
    let a = this.samples.get(name);
    if (!a) this.samples.set(name, (a = []));
    a.push(ms);
    if (a.length > WINDOW) a.shift();
  }

  snapshot(): Record<string, { p50: number; p95: number; n: number }> {
    const out: Record<string, { p50: number; p95: number; n: number }> = {};
    for (const [k, a] of this.samples) {
      const s = [...a].sort((x, y) => x - y);
      out[k] = { p50: nearestRank(s, 0.5), p95: nearestRank(s, 0.95), n: s.length };
    }
    return out;
  }

  /** p99 event-loop delay in ms (histogram starts on first call, so the first read is ~0). */
  eventLoopLagP99(): number {
    if (!this.loop) {
      this.loop = monitorEventLoopDelay({ resolution: 20 });
      this.loop.enable();
    }
    const v = this.loop.percentile(99);
    return Number.isFinite(v) ? v / 1e6 : 0;
  }

  dispose(): void {
    this.loop?.disable();
  }
}
