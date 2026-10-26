/**
 * Latency bench: the four text journeys over WebSocket against a running server, collecting the per-turn `trace` messages.
 *
 *   npm run bench -- --runs 20 [--chaos payments:2500:0.3] [--model <label>] [--section Default|Chaos|Hedging|model]
 *                    [--base http://127.0.0.1:4000] [--voice-runs 5]
 *
 * Raw results go to .data/bench/*.json and docs/latency-report.md is regenerated from all of them.
 * --section model     stores the run as the model-comparison entry for --model
 * --voice-runs N      instead of the text journeys, runs scripts/voice-smoke.ts N times
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRootEnv } from '../apps/server/src/config.js';
import { TODAY, addDays, dateAlts } from './eval/cases/facts.js';
import { arg, percentile, resetChaos, runConversationFull, setChaos, type ChaosSettings, type Step } from './eval/runner.js';
import { ROOT } from './docSections.js';
import { addTurn, emptySamples, type Samples } from './benchStats.js';
import { writeLatencyReport } from './latencyReport.js';

export const BENCH_DIR = join(ROOT, '.data/bench');

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

export function parseChaos(spec?: string): ChaosSettings | undefined {
  if (!spec) return undefined;
  const [sys, ms, rate] = spec.split(':');
  if (!sys) throw new Error('--chaos system:extraLatencyMs:failRate');
  return { [sys]: { extraLatencyMs: Number(ms ?? 0), failRate: Number(rate ?? 0) } };
}

export async function runBench(base: string, runs: number, chaos?: ChaosSettings): Promise<Samples> {
  const s = emptySamples();
  for (let r = 0; r < runs; r++) {
    for (const j of journeys()) {
      try {
        // Fresh data each run (a confirmed dispute or promise would block the next run), then the chaos settings.
        await resetChaos(base);
        if (chaos) await setChaos(base, chaos);
        const conv = await runConversationFull(base, j.customerId, j.steps, j.workflowId ? { workflowId: j.workflowId } : {});
        s.journeyRuns[j.id] = (s.journeyRuns[j.id] ?? 0) + 1;
        conv.results.forEach((t, i) => {
          if (t.trace) addTurn(s, j.id, t);
          else if (t.actionResults.length) { s.confirm.push(t.ms); s.confirmed[j.id] = (s.confirmed[j.id] ?? 0) + 1; }
          else s.errors.push(`${j.id} step ${i + 1}: ${t.errors.join(',') || 'no trace'}`);
        });
        if (j.steps.some((x) => typeof x === 'object' && 'confirm' in x)) s.confirmed[j.id] ??= 0;
      } catch (e) {
        s.errors.push(`${j.id}: ${(e as Error).message}`);
      }
    }
    process.stdout.write(`run ${r + 1}/${runs}\r`);
  }
  await resetChaos(base);
  return s;
}

// --------------------------------------------------------------------------- voice

export interface VoiceResult {
  runs: number;
  stt: number[]; llm: number[]; firstAudioServer: number[]; firstAudioClient: number[]; turnTotal: number[]; barge: number[];
  failures: string[];
}

const num = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => Number(m[1]));

function runVoice(runs: number): VoiceResult {
  const v: VoiceResult = { runs, stt: [], llm: [], firstAudioServer: [], firstAudioClient: [], turnTotal: [], barge: [], failures: [] };
  for (let i = 0; i < runs; i++) {
    const r = spawnSync('npx', ['tsx', 'scripts/voice-smoke.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) { v.failures.push(`run ${i + 1}: exit ${r.status}`); continue; }
    const sc1 = out.split('-- Scenario 2')[0]!;
    v.stt.push(...num(/stt committed transcript\s*:\s*(\d+) ms/g, sc1));
    v.llm.push(...num(/llm first token\s*:\s*(\d+) ms/g, sc1));
    v.firstAudioClient.push(...num(/first TTS audio at client:\s*(\d+) ms/g, sc1));
    v.firstAudioServer.push(...num(/server commit->first audio: (\d+) ms/g, sc1));
    v.turnTotal.push(...num(/turn_total \(engine\)\s*:\s*(\d+) ms/g, sc1));
    v.barge.push(...num(/barge_in fired (\d+) ms after/g, out));
    process.stdout.write(`voice run ${i + 1}/${runs}\r`);
  }
  return v;
}

// --------------------------------------------------------------------------- main

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRootEnv();
  const base = arg('base', `http://127.0.0.1:${process.env.PORT ?? 4000}`)!;
  const voiceRuns = Number(arg('voice-runs', '0'));
  mkdirSync(BENCH_DIR, { recursive: true });
  if (voiceRuns > 0) {
    const v = runVoice(voiceRuns);
    writeFileSync(join(BENCH_DIR, 'voice.json'), JSON.stringify(v));
    console.log(`voice: ${v.stt.length} runs; first audio (client) p50 ${percentile(v.firstAudioClient, 0.5)} ms`);
  } else {
    const runs = Number(arg('runs', '20'));
    const chaosSpec = arg('chaos');
    const chaos = parseChaos(chaosSpec);
    const model = arg('model', process.env.GEMINI_MODEL ?? 'unknown')!;
    const section = arg('section', chaos ? 'Chaos' : 'Default')!;
    const samples = await runBench(base, runs, chaos);
    const file = section === 'model' ? `model-${model}.json` : `${section}.json`;
    writeFileSync(join(BENCH_DIR, file), JSON.stringify({ model, runs, chaosSpec, chaos, samples }));
    console.log(`${section}: ${samples.turns} traced turns, turn_total p50 ${percentile(samples.turn_total, 0.5)} ms, p95 ${percentile(samples.turn_total, 0.95)} ms`);
  }
  console.log(`report: ${writeLatencyReport()}`);
}
