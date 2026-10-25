import type { SystemName } from '@app/shared';
import type { Transport } from './transport.js';

export type Fetched<T> =
  | { ok: true; data: T; stale?: { asOf: string } }
  | { ok: false; error: 'unavailable' | 'not_found' | 'timeout' };

export interface ClientConfig {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  breaker: { failures: number; cooldownMs: number };
  hedge: { enabled: boolean; maxRatio: number };
  staleTtlMs: number;
}

export interface CallEvent {
  system: SystemName;
  key: string;
  method?: 'GET' | 'POST';
  path?: string;
  attempt: number;
  hedged: boolean;
  ms: number;
  outcome: 'ok' | 'error' | 'timeout' | 'breaker_open' | 'stale';
  status?: number;
  body?: unknown;
}
export interface CallObserver {
  onCall(e: CallEvent): void;
}

const base = (timeoutMs: number): ClientConfig => ({
  timeoutMs,
  retries: 2,
  backoffMs: 100,
  breaker: { failures: 5, cooldownMs: 10_000 },
  hedge: { enabled: true, maxRatio: 0.1 },
  staleTtlMs: 10 * 60_000,
});

export const DEFAULT_CLIENT_CONFIG: Record<SystemName, ClientConfig> = {
  crm: base(800),
  lms: base(1200),
  payments: base(1500),
  policy: base(500),
  ops: base(2500),
};

export interface ClientOptions {
  now?: () => number;
  random?: () => number;
}
type Ctx = { signal: AbortSignal; observer?: CallObserver; cacheKey?: string };

type Raw =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'not_found'; status: number; body: unknown }
  | { kind: 'client_error'; status: number; body: unknown }
  | { kind: 'fail'; timeout: boolean; status?: number; body?: unknown }
  | { kind: 'aborted' };

const SAMPLE_WINDOW = 50;
const MIN_SAMPLES = 20;
const DEFAULT_HEDGE_MS = 400;

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

export class ResilientClient {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cache = new Map<string, { data: unknown; at: number }>();
  private readonly samples: number[] = [];
  private consecutiveFailures = 0;
  private openedAt: number | null = null; // non-null = open or half-open
  private trialInFlight = false;
  // Hedge budget uses lifetime counters: hedges / GET requests (see D-035).
  private getRequests = 0;
  private hedgesFired = 0;

  constructor(
    private readonly system: SystemName,
    private readonly transport: Transport,
    private readonly cfg: ClientConfig,
    opts: ClientOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  get<T>(path: string, ctx: Ctx): Promise<Fetched<T>> {
    return this.call<T>('GET', path, undefined, ctx, undefined);
  }

  post<T>(path: string, body: unknown, ctx: Ctx & { idempotencyKey: string }): Promise<Fetched<T>> {
    return this.call<T>('POST', path, body, ctx, ctx.idempotencyKey);
  }

  invalidate(prefix: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  /** Rolling p95 of the last 50 successful attempts; 400 ms until 20 samples exist. */
  p95(): number {
    if (this.samples.length < MIN_SAMPLES) return DEFAULT_HEDGE_MS;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.ceil(0.95 * s.length) - 1]!;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    ctx: Ctx,
    idempotencyKey: string | undefined,
  ): Promise<Fetched<T>> {
    if (ctx.signal.aborted) throw abortError();
    const key = ctx.cacheKey ?? path;
    const isGet = method === 'GET';
    const started = this.now();
    const emit = (e: Omit<CallEvent, 'system' | 'key'>) => ctx.observer?.onCall({ system: this.system, key, method, path, ...e });

    const admit = this.admit();
    if (admit === 'open') {
      const stale = isGet ? this.staleFor<T>(key) : undefined;
      emit({ attempt: 0, hedged: false, ms: 0, outcome: stale ? 'stale' : 'breaker_open' });
      return stale ?? { ok: false, error: 'unavailable' };
    }
    const trial = admit === 'trial';
    if (isGet) this.getRequests++;

    const retriable = isGet || (idempotencyKey !== undefined && idempotencyKey !== '');
    const maxAttempts = trial || !retriable ? 1 : this.cfg.retries + 1;
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;

    try {
      let last: Raw = { kind: 'fail', timeout: false };
      let attempt = 0;
      for (; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          if (this.openedAt !== null) break; // breaker tripped meanwhile
          await this.sleep(this.cfg.backoffMs * 2 ** (attempt - 1) + this.random() * this.cfg.backoffMs, ctx.signal);
        }
        const raw = await this.runGroup({ method, path, body, headers }, ctx, key, attempt + 1, isGet && !trial);
        if (ctx.signal.aborted || raw.kind === 'aborted') throw abortError();
        last = raw;
        if (raw.kind === 'ok') {
          if (isGet) this.cache.set(key, { data: raw.body, at: this.now() });
          return { ok: true, data: raw.body as T };
        }
        if (raw.kind === 'not_found') return { ok: false, error: 'not_found' };
        if (raw.kind === 'client_error') return { ok: false, error: 'unavailable' };
      }
      // exhausted
      const stale = isGet ? this.staleFor<T>(key) : undefined;
      if (stale) {
        emit({ attempt: Math.max(attempt, 1), hedged: false, ms: this.now() - started, outcome: 'stale' });
        return stale;
      }
      return { ok: false, error: last.kind === 'fail' && last.timeout ? 'timeout' : 'unavailable' };
    } finally {
      if (trial) this.trialInFlight = false; // never leave half-open stuck (e.g. caller abort)
    }
  }

  private admit(): 'ok' | 'trial' | 'open' {
    if (this.openedAt === null) return 'ok';
    if (this.now() - this.openedAt < this.cfg.breaker.cooldownMs) return 'open';
    if (this.trialInFlight) return 'open';
    this.trialInFlight = true;
    return 'trial';
  }

  private staleFor<T>(key: string): Fetched<T> | undefined {
    const hit = this.cache.get(key);
    if (!hit || this.now() - hit.at > this.cfg.staleTtlMs) return undefined;
    return { ok: true, data: hit.data as T, stale: { asOf: new Date(hit.at).toISOString() } };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private hedgeAllowed(): boolean {
    // Hedge n is allowed once n <= maxRatio * requests; the very first hedge is always allowed
    // so a cold client can still hedge. Lifetime counters, so the ratio never exceeds the cap.
    return this.cfg.hedge.enabled && this.hedgesFired + 1 <= Math.max(1, this.cfg.hedge.maxRatio * this.getRequests);
  }

  /** One logical attempt: the primary request, plus at most one hedge after p95. First terminal result wins. */
  private runGroup(
    req: { method: 'GET' | 'POST'; path: string; body: unknown; headers?: Record<string, string> },
    ctx: Ctx,
    key: string,
    attempt: number,
    canHedge: boolean,
  ): Promise<Raw> {
    return new Promise<Raw>((resolve) => {
      const running: Array<{ cancel(): void }> = [];
      let pending = 0;
      let done = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (r: Raw) => {
        if (done) return;
        done = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        for (const a of running) a.cancel();
        resolve(r);
      };
      const launch = (hedged: boolean) => {
        pending++;
        const a = this.startAttempt(req, ctx, key, attempt, hedged);
        running.push(a);
        void a.promise.then((r) => {
          pending--;
          if (done) return;
          if (r.kind !== 'fail') return finish(r);
          if (pending === 0) finish(r);
        });
      };

      launch(false);
      if (canHedge) {
        hedgeTimer = setTimeout(() => {
          hedgeTimer = undefined;
          if (done || !this.hedgeAllowed()) return;
          this.hedgesFired++;
          launch(true);
        }, this.p95());
      }
    });
  }

  private startAttempt(
    req: { method: 'GET' | 'POST'; path: string; body: unknown; headers?: Record<string, string> },
    ctx: Ctx,
    key: string,
    attempt: number,
    hedged: boolean,
  ): { promise: Promise<Raw>; cancel(): void } {
    const ctl = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onCaller = () => ctl.abort();
    ctx.signal.addEventListener('abort', onCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.cfg.timeoutMs);
    const t0 = this.now();

    const promise = new Promise<Raw>((resolve) => {
      const onAbort = () => resolve(timedOut ? { kind: 'fail', timeout: true } : { kind: 'aborted' });
      if (ctl.signal.aborted) onAbort();
      else ctl.signal.addEventListener('abort', onAbort, { once: true });
      this.transport({ method: req.method, url: req.path, body: req.body, headers: req.headers, signal: ctl.signal }).then(
        (res) => resolve(this.classify(res.status, res.body)),
        () => resolve({ kind: 'fail', timeout: false }),
      );
    }).then((raw) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onCaller);
      if (raw.kind === 'aborted' || cancelled) return raw;
      const ms = this.now() - t0;
      const ev = { method: req.method, path: req.path, attempt, hedged, ms };
      switch (raw.kind) {
        case 'ok':
          this.samples.push(ms);
          if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();
          this.recordHealthy();
          ctx.observer?.onCall({ system: this.system, key, ...ev, outcome: 'ok', status: raw.status, body: raw.body });
          break;
        case 'not_found':
        case 'client_error':
          this.recordHealthy(); // the system answered; this is not an availability failure
          ctx.observer?.onCall({ system: this.system, key, ...ev, outcome: 'error', status: raw.status, body: raw.body });
          break;
        case 'fail':
          this.recordFailure();
          ctx.observer?.onCall({
            system: this.system,
            key,
            ...ev,
            outcome: raw.timeout ? 'timeout' : 'error',
            status: raw.status,
            body: raw.body,
          });
          break;
      }
      return raw;
    });

    return {
      promise,
      cancel: () => {
        cancelled = true;
        ctl.abort();
      },
    };
  }

  private classify(status: number, body: unknown): Raw {
    if (status >= 200 && status < 300) return { kind: 'ok', status, body };
    if (status === 404) return { kind: 'not_found', status, body };
    if (status === 408 || status === 429 || status >= 500) return { kind: 'fail', timeout: false, status, body };
    return { kind: 'client_error', status, body };
  }

  private recordHealthy(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.trialInFlight || this.consecutiveFailures >= this.cfg.breaker.failures) {
      this.openedAt = this.now();
      this.trialInFlight = false;
    }
  }
}
