export const SYSTEMS = ['crm', 'lms', 'payments', 'policy', 'ops'] as const;
export type SystemName = (typeof SYSTEMS)[number];

export interface SystemProfile {
  /** Base latency, uniform in [minMs, maxMs]. */
  minMs: number;
  maxMs: number;
  failRate: number;
}
export type ChaosOptions = Partial<Record<SystemName, Partial<SystemProfile>>>;
export interface ChaosOverride { extraLatencyMs?: number; failRate?: number; hang?: boolean }
export interface EffectiveChaos extends SystemProfile { extraLatencyMs: number; hang: boolean }

export const BASE_PROFILES: Record<SystemName, SystemProfile> = {
  crm: { minMs: 80, maxMs: 200, failRate: 0 },
  lms: { minMs: 150, maxMs: 400, failRate: 0 },
  payments: { minMs: 300, maxMs: 900, failRate: 0.05 },
  policy: { minMs: 30, maxMs: 80, failRate: 0 },
  ops: { minMs: 400, maxMs: 1200, failRate: 0.03 },
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaosDecision { latencyMs: number; fail: boolean; hang: boolean }

/** Base profiles plus runtime overrides. Deterministic when seeded. */
export class Chaos {
  private overrides: Partial<Record<SystemName, ChaosOverride>> = {};
  private readonly rng: () => number;

  constructor(private readonly base: ChaosOptions = {}, seed?: number) {
    this.rng = seed === undefined ? Math.random : mulberry32(seed);
  }

  effective(system: SystemName): EffectiveChaos {
    const p = { ...BASE_PROFILES[system], ...this.base[system] };
    const o = this.overrides[system] ?? {};
    return { ...p, failRate: o.failRate ?? p.failRate, extraLatencyMs: o.extraLatencyMs ?? 0, hang: o.hang ?? false };
  }

  all(): Record<SystemName, EffectiveChaos> {
    return Object.fromEntries(SYSTEMS.map((s) => [s, this.effective(s)])) as Record<SystemName, EffectiveChaos>;
  }

  set(system: SystemName, o: ChaosOverride): void {
    this.overrides[system] = { ...this.overrides[system], ...o };
  }

  reset(): void { this.overrides = {}; }

  /** Draws are always taken in the same order so a seed reproduces the sequence. */
  decide(system: SystemName): ChaosDecision {
    const e = this.effective(system);
    const latencyMs = Math.round(e.minMs + this.rng() * (e.maxMs - e.minMs)) + e.extraLatencyMs;
    const fail = this.rng() < e.failRate;
    return { latencyMs, fail, hang: e.hang };
  }
}
