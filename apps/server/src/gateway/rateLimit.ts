/** Sliding-window counter: at most `max` hits per `windowMs` per key. Idle keys are dropped lazily. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastGc = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records a hit and returns true when allowed; a rejected hit is not recorded. */
  take(key: string): boolean {
    const t = this.now();
    this.gc(t);
    const cutoff = t - this.windowMs;
    const a = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (a.length >= this.max) {
      this.hits.set(key, a);
      return false;
    }
    a.push(t);
    this.hits.set(key, a);
    return true;
  }

  private gc(t: number) {
    if (t - this.lastGc < this.windowMs) return;
    this.lastGc = t;
    for (const [k, a] of this.hits) if (a.length === 0 || a[a.length - 1]! <= t - this.windowMs) this.hits.delete(k);
  }
}
