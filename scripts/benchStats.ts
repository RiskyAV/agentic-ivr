import { median, percentile, type TurnResult } from './eval/runner.js';

/** Every observation of one bench run, in ms. */
export interface Samples {
  llm_first_token: number[];
  first_delta: number[];
  turn_total: number[];
  turn_wall: number[];
  guard: number[];
  confirm: number[];
  tool: Record<string, number[]>;
  backend: Record<string, number[]>;
  /** Per journey: turn_total of each turn. */
  journey: Record<string, number[]>;
  /** Backend call outcomes per system: ok, error, timeout, breaker_open, stale. */
  outcomes: Record<string, Record<string, number>>;
  llmShare: number[];
  toolShare: number[];
  otherShare: number[];
  backendCalls: number;
  hedged: number;
  stale: number;
  failedCalls: number;
  turns: number;
  degraded: number;
  guardTimeouts: number;
  /** Journeys started, and journeys where the confirm step had a proposal to confirm, by journey id. */
  journeyRuns: Record<string, number>;
  confirmed: Record<string, number>;
  errors: string[];
}

export const emptySamples = (): Samples => ({
  llm_first_token: [], first_delta: [], turn_total: [], turn_wall: [], guard: [], confirm: [], tool: {}, backend: {}, journey: {}, outcomes: {},
  llmShare: [], toolShare: [], otherShare: [], backendCalls: 0, hedged: 0, stale: 0, failedCalls: 0, turns: 0, degraded: 0, guardTimeouts: 0,
  journeyRuns: {}, confirmed: {}, errors: [],
});
const push = (m: Record<string, number[]>, k: string, v: number) => { (m[k] ??= []).push(v); };

/** Union length of [start,end] intervals. */
function unionMs(iv: Array<[number, number]>): number {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curEnd = -Infinity;
  for (const [a, b] of s) {
    if (b <= curEnd) continue;
    total += b - Math.max(a, curEnd);
    curEnd = b;
  }
  return total;
}

export function addTurn(s: Samples, journey: string, t: TurnResult): void {
  const tr = t.trace;
  if (!tr) return;
  s.turns++;
  const m = tr.metrics;
  if (m.llm_first_token !== undefined) s.llm_first_token.push(m.llm_first_token);
  if (m.first_delta !== undefined) s.first_delta.push(m.first_delta);
  if (m.turn_total !== undefined) { s.turn_total.push(m.turn_total); push(s.journey, journey, m.turn_total); }
  s.turn_wall.push(t.ms);
  if (tr.guard) { s.guard.push(tr.guard.ms); if (tr.guard.verdict === 'timeout') s.guardTimeouts++; }
  const llm: Array<[number, number]> = [];
  const tools: Array<[number, number]> = [];
  for (const sp of tr.spans) {
    const d = sp.endMs - sp.startMs;
    if (sp.name === 'llm') llm.push([sp.startMs, sp.endMs]);
    else if (sp.name.startsWith('tool:')) { push(s.tool, sp.name, d); tools.push([sp.startMs, sp.endMs]); }
    else if (sp.name.startsWith('backend:')) {
      push(s.backend, sp.name, d);
      s.backendCalls++;
      const outcome = String(sp.attrs?.outcome ?? 'unknown');
      const o = (s.outcomes[sp.name.slice(8)] ??= {});
      o[outcome] = (o[outcome] ?? 0) + 1;
      if (sp.attrs?.hedged === true) s.hedged++;
      if (outcome === 'stale') s.stale++;
      if (outcome !== 'ok' && outcome !== 'stale') s.failedCalls++;
    }
  }
  const total = m.turn_total ?? 0;
  if (total > 0) {
    const l = unionMs(llm);
    const tl = unionMs(tools);
    s.llmShare.push(l / total);
    s.toolShare.push(tl / total);
    s.otherShare.push(Math.max(0, total - l - tl) / total);
  }
  if (t.text.includes("I'm still checking") || t.text.includes('something went wrong') || t.text.includes('very high demand')) s.degraded++;
}

export const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a');
const maxOf = (v: number[]) => (v.length ? Math.max(...v) : NaN);
const row = (name: string, v: number[]) => `| ${name} | ${v.length} | ${fmt(percentile(v, 0.5))} | ${fmt(percentile(v, 0.95))} | ${fmt(maxOf(v))} |`;
const pctText = (x: number, d: number) => (d ? `${(100 * x / d).toFixed(1)}%` : 'n/a');

/** Median shares of a turn spent in LLM rounds, tool spans and everything else. */
export function shares(s: Samples): { llm: number; tool: number; other: number } {
  return { llm: median(s.llmShare), tool: median(s.toolShare), other: median(s.otherShare) };
}

export function renderStats(s: Samples, runs: number): string {
  const lines: string[] = ['| Metric | n | p50 | p95 | max |\n|---|---|---|---|---|'];
  lines.push(row('llm_first_token (round 1)', s.llm_first_token));
  lines.push(row('first_delta (first text out)', s.first_delta));
  lines.push(row('turn_total (server)', s.turn_total));
  lines.push(row('turn, client-measured send to trace', s.turn_wall));
  lines.push(row('guard verdict', s.guard));
  if (s.confirm.length) lines.push(row('confirm_action round trip', s.confirm));
  for (const k of Object.keys(s.tool).sort()) lines.push(row(k, s.tool[k]!));
  for (const k of Object.keys(s.backend).sort()) lines.push(row(k, s.backend[k]!));
  const j = Object.keys(s.journey).sort().map((k) => `| ${k} | ${s.journey[k]!.length} | ${fmt(percentile(s.journey[k]!, 0.5))} | ${fmt(percentile(s.journey[k]!, 0.95))} | ${fmt(maxOf(s.journey[k]!))} | ${s.confirmed[k] === undefined ? 'n/a' : `${s.confirmed[k]} of ${s.journeyRuns[k]}`} |`);
  const outcomes = Object.keys(s.outcomes).sort().map((sys) => `| ${sys} | ${Object.entries(s.outcomes[sys]!).sort().map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  return [
    `${runs} runs of each journey (${s.turns} traced turns).`, '', lines.join('\n'), '',
    '**Resilience counters**', '',
    `- Backend calls: ${s.backendCalls}; hedged attempts that completed: ${s.hedged} (${pctText(s.hedged, s.backendCalls)}); failed, timed out or short-circuited by an open breaker: ${s.failedCalls}; served stale: ${s.stale}.`,
    `- Guard timeouts (no verdict within the wait): ${s.guardTimeouts}; turns that ended degraded: ${s.degraded} of ${s.turns}.`, '',
    '**Backend call outcomes by system**', '', '| System | Outcomes |\n|---|---|', ...outcomes, '',
    '**By journey (server turn_total per turn; last column = runs in which the confirm step had a proposal to confirm)**', '',
    '| Journey | turns | p50 | p95 | max | proposal reached |\n|---|---|---|---|---|---|', ...j,
    ...(s.errors.length ? ['', `Runner notes (${s.errors.length}): ${[...new Set(s.errors)].slice(0, 5).join('; ')}`] : []),
  ].join('\n');
}
