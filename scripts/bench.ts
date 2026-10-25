/**
 * Latency bench: the four text journeys over WebSocket against a running server, collecting the per-turn `trace` messages.
 *
 *   npm run bench -- --runs 20 [--chaos payments:2500:0.3] [--model <label>] [--section Default|Chaos|model]
 *                    [--base http://127.0.0.1:4000] [--voice-runs 5]
 *
 * --section model     stores the run as the model-comparison entry for --model (and re-renders that section)
 * --voice-runs N      instead of the text journeys, runs scripts/voice-smoke.ts N times and writes the Voice section
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRootEnv } from '../apps/server/src/config.js';
import { TODAY, addDays, dateAlts } from './eval/cases/facts.js';
import { arg, median, percentile, resetChaos, runConversationFull, setChaos, type ChaosSettings, type Step, type TurnResult } from './eval/runner.js';
import { ROOT, upsertSection } from './docSections.js';

interface Journey { id: string; title: string; customerId: string; workflowId?: string; steps: Step[] }

export const journeys = (): Journey[] => [
  { id: 'J1', title: 'Why did my EMI go up?', customerId: 'C1001', steps: ['Why did my EMI go up?'] },
  {
    id: 'J2', title: 'Prepay ₹50,000: simulate, choose, confirm', customerId: 'C1001',
    steps: ['If I prepay ₹50,000 today how much interest do I save?', 'Do the reduce-tenure one.', { confirm: true }],
  },
  {
    id: 'J3', title: 'Failed payments, then dispute and confirm', customerId: 'C1002',
    steps: ['Show my failed payments in the last six months and explain.', 'Please dispute the wrongly charged bounce fee.', { confirm: true }],
  },
  {
    id: 'J4', title: 'Collections: opener, amount owed, promise to pay, confirm', customerId: 'C1003', workflowId: 'collections',
    steps: ['Yes, I can talk. How much do I owe exactly?', `I will be able to pay on ${dateAlts(addDays(TODAY, 5))[1]}.`, { confirm: true }],
  },
];

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
  llmShare: number[];
  toolShare: number[];
  otherShare: number[];
  backendCalls: number;
  hedged: number;
  stale: number;
  retried: number;
  failedCalls: number;
  turns: number;
  degraded: number;
  guardTimeouts: number;
  errors: string[];
}

const empty = (): Samples => ({
  llm_first_token: [], first_delta: [], turn_total: [], turn_wall: [], guard: [], confirm: [], tool: {}, backend: {}, journey: {},
  llmShare: [], toolShare: [], otherShare: [], backendCalls: 0, hedged: 0, stale: 0, retried: 0, failedCalls: 0, turns: 0, degraded: 0, guardTimeouts: 0, errors: [],
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
      if (sp.attrs?.hedged === true) s.hedged++;
      if (sp.attrs?.outcome === 'stale') s.stale++;
      if (typeof sp.attrs?.attempt === 'number' && sp.attrs.attempt > 0) s.retried++;
      if (sp.attrs?.outcome && sp.attrs.outcome !== 'ok' && sp.attrs.outcome !== 'stale') s.failedCalls++;
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

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a');
const row = (name: string, v: number[]) => `| ${name} | ${v.length} | ${fmt(percentile(v, 0.5))} | ${fmt(percentile(v, 0.95))} | ${fmt(Math.max(...v, NaN))} |`;
const head = '| Metric | n | p50 | p95 | max |\n|---|---|---|---|---|';
const pctText = (x: number, d: number) => (d ? `${(100 * x / d).toFixed(1)}%` : 'n/a');

export function renderStats(s: Samples, runs: number): string {
  const lines: string[] = [head];
  lines.push(row('llm_first_token (round 1)', s.llm_first_token));
  lines.push(row('first_delta (first text out)', s.first_delta));
  lines.push(row('turn_total (server)', s.turn_total));
  lines.push(row('turn, client-measured send to trace', s.turn_wall));
  lines.push(row('guard verdict', s.guard));
  if (s.confirm.length) lines.push(row('confirm_action round trip', s.confirm));
  for (const k of Object.keys(s.tool).sort()) lines.push(row(k, s.tool[k]!));
  for (const k of Object.keys(s.backend).sort()) lines.push(row(k, s.backend[k]!));
  const j = Object.keys(s.journey).sort().map((k) => `| ${k} | ${s.journey[k]!.length} | ${fmt(percentile(s.journey[k]!, 0.5))} | ${fmt(percentile(s.journey[k]!, 0.95))} |`);
  return [
    `${runs} runs of each journey (${s.turns} turns).`, '', lines.join('\n'), '',
    '**Resilience counters**', '',
    `- Backend calls: ${s.backendCalls}; hedged: ${s.hedged} (${pctText(s.hedged, s.backendCalls)}); retried (attempt > 0): ${s.retried}; failed or timed out: ${s.failedCalls}; stale-served: ${s.stale}.`,
    `- Guard timeouts (no verdict within the wait): ${s.guardTimeouts}; turns that ended degraded: ${s.degraded} of ${s.turns}.`, '',
    '**turn_total by journey (server, per turn)**', '', '| Journey | turns | p50 | p95 |\n|---|---|---|---|', ...j,
    ...(s.errors.length ? ['', `Runner errors (${s.errors.length}): ${[...new Set(s.errors)].slice(0, 5).join('; ')}`] : []),
  ].join('\n');
}

export function parseChaos(spec?: string): ChaosSettings | undefined {
  if (!spec) return undefined;
  const [sys, ms, rate] = spec.split(':');
  if (!sys) throw new Error('--chaos system:extraLatencyMs:failRate');
  return { [sys]: { extraLatencyMs: Number(ms ?? 0), failRate: Number(rate ?? 0) } };
}

export async function runBench(base: string, runs: number, chaos?: ChaosSettings): Promise<Samples> {
  const s = empty();
  for (let r = 0; r < runs; r++) {
    for (const j of journeys()) {
      try {
        // Fresh data each run (a confirmed dispute or promise would block the next run), then the chaos settings.
        await resetChaos(base);
        if (chaos) await setChaos(base, chaos);
        const conv = await runConversationFull(base, j.customerId, j.steps, j.workflowId ? { workflowId: j.workflowId } : {});
        conv.results.forEach((t, i) => {
          if (t.trace) addTurn(s, j.id, t);
          else if (t.actionResults.length) s.confirm.push(t.ms);
          else s.errors.push(`${j.id} step ${i + 1}: ${t.errors.join(',') || 'no trace'}`);
        });
      } catch (e) {
        s.errors.push(`${j.id}: ${(e as Error).message}`);
      }
    }
    process.stdout.write(`run ${r + 1}/${runs}\r`);
  }
  await resetChaos(base);
  return s;
}

// --------------------------------------------------------------------------- model comparison

const BENCH_DIR = join(ROOT, '.data/bench');

function renderModelComparison(): string {
  const files = (() => { try { return readdirSync(BENCH_DIR).filter((f) => f.startsWith('model-') && f.endsWith('.json')); } catch { return []; } })();
  const benches = files.map((f) => JSON.parse(readFileSync(join(BENCH_DIR, f), 'utf8')) as { model: string; runs: number; samples: Samples });
  const evalDir = join(ROOT, '.data/eval');
  const evals: Record<string, { golden?: Array<{ pass: boolean }>; redteam?: Array<{ pass: boolean; extra?: boolean }> }> = {};
  try { for (const f of readdirSync(evalDir)) { const d = JSON.parse(readFileSync(join(evalDir, f), 'utf8')) as { model: string }; evals[d.model] = d as never; } } catch { /* none yet */ }
  const lines = [
    `Same four journeys (${benches[0]?.runs ?? 5} runs each, real Gemini, default backend latencies); the guard model is gemini-3.5-flash-lite for all rows. Accuracy is from the final iteration of the golden and red-team evals (docs/eval-report.md).`, '',
    '| Model | Golden | Red team | llm_first_token p50 / p95 | turn_total p50 / p95 | J1 p50 / p95 | J2 p50 / p95 | J3 p50 / p95 | J4 p50 / p95 | degraded turns |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const b of benches.sort((a, c) => a.model.localeCompare(c.model))) {
    const e = evals[b.model];
    const g = e?.golden ? `${e.golden.filter((x) => x.pass).length}/${e.golden.length}` : 'n/a';
    const rt = e?.redteam ? `${e.redteam.filter((x) => x.pass && !x.extra).length}/${e.redteam.filter((x) => !x.extra).length}` : 'n/a';
    const pp = (v: number[]) => `${fmt(percentile(v, 0.5))} / ${fmt(percentile(v, 0.95))}`;
    const j = (id: string) => pp(b.samples.journey[id] ?? []);
    lines.push(`| ${b.model} | ${g} | ${rt} | ${pp(b.samples.llm_first_token)} | ${pp(b.samples.turn_total)} | ${j('J1')} | ${j('J2')} | ${j('J3')} | ${j('J4')} | ${b.samples.degraded}/${b.samples.turns} |`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------- voice

const num = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => Number(m[1]));

function voiceSection(runs: number): string {
  const stt: number[] = [], llm: number[] = [], firstAudioClient: number[] = [], firstAudioServer: number[] = [], barge: number[] = [], total: number[] = [];
  const failures: string[] = [];
  for (let i = 0; i < runs; i++) {
    const r = spawnSync('npx', ['tsx', 'scripts/voice-smoke.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) { failures.push(`run ${i + 1}: exit ${r.status}`); continue; }
    const sc1 = out.split('-- Scenario 2')[0]!;
    stt.push(...num(/stt committed transcript\s*:\s*(\d+) ms/g, sc1));
    llm.push(...num(/llm first token\s*:\s*(\d+) ms/g, sc1));
    firstAudioClient.push(...num(/first TTS audio at client:\s*(\d+) ms/g, sc1));
    firstAudioServer.push(...num(/server commit->first audio: (\d+) ms/g, sc1));
    total.push(...num(/turn_total \(engine\)\s*:\s*(\d+) ms/g, sc1));
    barge.push(...num(/barge_in fired (\d+) ms after/g, out));
    process.stdout.write(`voice run ${i + 1}/${runs}\r`);
  }
  const rows = [
    `| STT commit (end of speech to final transcript) | ${stt.length} | ${fmt(percentile(stt, 0.5))} | ${fmt(percentile(stt, 0.95))} |`,
    `| LLM first token (engine, after turn start) | ${llm.length} | ${fmt(percentile(llm, 0.5))} | ${fmt(percentile(llm, 0.95))} |`,
    `| First TTS audio, server (commit to first audio frame sent) | ${firstAudioServer.length} | ${fmt(percentile(firstAudioServer, 0.5))} | ${fmt(percentile(firstAudioServer, 0.95))} |`,
    `| First TTS audio at the test client (end of speech to first audio frame) | ${firstAudioClient.length} | ${fmt(percentile(firstAudioClient, 0.5))} | ${fmt(percentile(firstAudioClient, 0.95))} |`,
    `| turn_total (engine) | ${total.length} | ${fmt(percentile(total, 0.5))} | ${fmt(percentile(total, 0.95))} |`,
    `| Barge-in (interruption begins to barge_in event) | ${barge.length} | ${fmt(percentile(barge, 0.5))} | ${fmt(percentile(barge, 0.95))} |`,
  ];
  return [
    `\`npx tsx scripts/voice-smoke.ts\` run ${runs} times (real Gemini, real ElevenLabs STT and TTS, in-process mocks; macOS \`say\` fixtures of "What's my next EMI?" and "Actually, check my last payment first."). Scenario 1 gives the first four rows; the barge-in row comes from scenario 2.`, '',
    '| Stage | n | p50 | p95 |\n|---|---|---|---|', ...rows,
    ...(failures.length ? ['', `Failed runs: ${failures.join('; ')}`] : []),
  ].join('\n');
}

// --------------------------------------------------------------------------- main

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRootEnv();
  const base = arg('base', `http://127.0.0.1:${process.env.PORT ?? 4000}`)!;
  const voiceRuns = Number(arg('voice-runs', '0'));
  if (voiceRuns > 0) {
    const body = voiceSection(voiceRuns);
    mkdirSync(BENCH_DIR, { recursive: true });
    writeFileSync(join(BENCH_DIR, 'voice.md'), body);
    upsertSection('Voice', body);
    console.log(body);
  } else {
    const runs = Number(arg('runs', '20'));
    const chaosSpec = arg('chaos');
    const chaos = parseChaos(chaosSpec);
    const model = arg('model', process.env.GEMINI_MODEL ?? 'unknown')!;
    const section = arg('section', chaos ? 'Chaos' : 'Default')!;
    const samples = await runBench(base, runs, chaos);
    mkdirSync(BENCH_DIR, { recursive: true });
    if (section === 'model') {
      writeFileSync(join(BENCH_DIR, `model-${model}.json`), JSON.stringify({ model, runs, samples }));
      upsertSection('Model comparison', renderModelComparison());
    } else {
      const cond = chaos ? `Chaos \`--chaos ${chaosSpec}\` (${Object.entries(chaos).map(([k, v]) => `${k} +${v.extraLatencyMs} ms, ${Math.round((v.failRate ?? 0) * 100)}% failures`).join(', ')}).` : 'Default mock latencies, no chaos.';
      const body = [`Model \`${model}\` (guard \`gemini-3.5-flash-lite\`). ${cond} Command: \`npm run bench -- --runs ${runs}${chaosSpec ? ` --chaos ${chaosSpec}` : ''}\`.`, '', renderStats(samples, runs)].join('\n');
      writeFileSync(join(BENCH_DIR, `${section}.json`), JSON.stringify({ model, runs, chaos, samples }));
      upsertSection(section, body);
      console.log(body);
    }
  }
}
export { median };
