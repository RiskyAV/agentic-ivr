import { abortError } from './types.js';

export class LimiterTimeout extends Error {
  constructor(readonly waitedMs: number) {
    super(`LLM queue timeout after ${waitedMs}ms`);
    this.name = 'LimiterTimeout';
  }
}

interface Waiter {
  grant: () => void;
  cleanup: () => void;
}

/** Bounded concurrency with a FIFO wait queue; waiting is bounded by `queueTimeoutMs` and the caller's signal. */
export class Limiter {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly max: number, private readonly queueTimeoutMs: number) {}

  stats() {
    return { active: this.active, queued: this.queue.length };
  }

  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.max && this.queue.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const remove = () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) this.queue.splice(i, 1);
        w.cleanup();
      };
      const timer = setTimeout(() => { remove(); reject(new LimiterTimeout(Date.now() - t0)); }, this.queueTimeoutMs);
      const onAbort = () => { remove(); reject(abortError()); };
      const w: Waiter = {
        grant: () => { w.cleanup(); resolve(); },
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(w);
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next.grant(); // the slot transfers to the waiter; active stays the same
    else this.active--;
  }
}
