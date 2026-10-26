/**
 * Concurrency load test: N simulated conversations over WebSocket against a server running the stub LLM
 * (fixed latency per scripted chunk), so the numbers show server overhead, not model speed.
 *
 *   npm run load -- --sessions 200 --turns 5 [--stub-delay 600] [--think-ms 1500] [--ramp-ms 4000]
 *                   [--llm-concurrency 50] [--label "..."] [--base http://host:port] [--no-write]
 *
 * Without --base it starts its own mock systems + server as child processes (ports 4110/4010) and stops them at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMsg } from '@app/shared';
import { arg, login, openSocket, percentile } from './eval/runner.js';
import { upsertSection, readSection } from './docSections.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CUSTOMERS = ['C1001', 'C1002', 'C1003', 'C1004'];
const PROMPTS = ['Why did my EMI go up?', "What's my EMI now?", 'Tell me about my EMI change', 'Explain my EMI again', 'Has my EMI changed?'];

interface MetricsReply {
  metrics: Record<string, { p50: number; p95: number; n: number }>;
  eventLoopLagP99: number;
  rssMb: number;
  sessions: number;
  limiter: { active: number; queued: number };
}

export interface LoadResult {
  sessions: number;
  turns: number;
  connected: number;
  completedTurns: number;
  failedTurns: number;
  highDemand: number;
  clientMs: number[];
  serverMs: number[];
  peakQueued: number;
  peakActive: number;
  lagMax: number;
  lagLast: number;
  rssBase: number;
  rssConnected: number;
  rssPeak: number;
  wallSec: number;
  stubDelay: number;
  llmConcurrency: number;
  idealTurnMs: number;
  serverMetrics: MetricsReply['metrics'];
  errors: string[];
}

function child(file: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
  const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, file)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', (d: Buffer) => { if (process.env.LOAD_VERBOSE) process.stdout.write(`[${log}] ${d}`); });
  p.stderr?.on('data', (d: Buffer) => { if (process.env.LOAD_VERBOSE) process.stderr.write(`[${log}] ${d}`); });
  return p;
}

async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server at ${base} did not become healthy`);
}

const getMetrics = (base: string) => fetch(`${base}/api/metrics`).then((r) => r.json() as Promise<MetricsReply>);

export async function runLoad(base: string, o: { sessions: number; turns: number; thinkMs: number; rampMs: number; stubDelay: number; llmConcurrency: number }): Promise<LoadResult> {
  const res: LoadResult = {
    sessions: o.sessions, turns: o.turns, connected: 0, completedTurns: 0, failedTurns: 0, highDemand: 0, clientMs: [], serverMs: [], peakQueued: 0, peakActive: 0,
    lagMax: 0, lagLast: 0, rssBase: 0, rssConnected: 0, rssPeak: 0, wallSec: 0, stubDelay: o.stubDelay, llmConcurrency: o.llmConcurrency,
    idealTurnMs: o.stubDelay * 3, serverMetrics: {}, errors: [],
  };
  const m0 = await getMetrics(base);
  res.rssBase = m0.rssMb;
  res.rssPeak = m0.rssMb;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const m = await getMetrics(base);
        res.peakQueued = Math.max(res.peakQueued, m.limiter.queued);
        res.peakActive = Math.max(res.peakActive, m.limiter.active);
        res.lagMax = Math.max(res.lagMax, m.eventLoopLagP99);
        res.lagLast = m.eventLoopLagP99;
        res.rssPeak = Math.max(res.rssPeak, m.rssMb);
      } catch { /* server too busy to answer; that is data too */ }
      await sleep(500);
    }
  })();

  let connectedCount = 0;
  let release!: () => void;
  const go = new Promise<void>((r) => { release = r; });
  const t0 = performance.now();

  const one = async (i: number): Promise<void> => {
    await sleep((o.rampMs * i) / o.sessions);
    let sock;
    try {
      const { token } = await login(base, CUSTOMERS[i % CUSTOMERS.length]!);
      sock = await openSocket(base, token);
      await sock.waitFor((m) => m.type === 'session_ready', 0, 30_000);
      res.connected++;
    } catch (e) {
      res.errors.push(`connect: ${(e as Error).message}`);
      connectedCount++;
      return;
    }
    connectedCount++;
    await go;
    try {
      for (let t = 0; t < o.turns; t++) {
        await sleep(Math.random() * o.thinkMs * 2);
        const turnId = `load-${i}-${t}`;
        const from = sock.msgs.length;
        const sent = performance.now();
        sock.send({ type: 'user_text', turnId, text: PROMPTS[(i + t) % PROMPTS.length] });
        try {
          const end = await sock.waitFor((m) => (m.type === 'trace' && m.trace.turnId === turnId) || m.type === 'error', from, 60_000);
          const ms = performance.now() - sent;
          const msgs = sock.msgs.slice(from);
          const done = msgs.find((m): m is Extract<ServerMsg, { type: 'assistant_done' }> => m.type === 'assistant_done');
          if (end.type === 'error' || !done) { res.failedTurns++; res.errors.push(end.type === 'error' ? `${end.code}` : 'no assistant_done'); continue; }
          res.completedTurns++;
          res.clientMs.push(ms);
          if (done.text.includes('very high demand')) res.highDemand++;
          if (end.type === 'trace' && end.trace.metrics.turn_total !== undefined) res.serverMs.push(end.trace.metrics.turn_total);
        } catch (e) {
          res.failedTurns++;
          res.errors.push((e as Error).message);
        }
      }
    } finally {
      sock.close();
    }
  };

  const all = Array.from({ length: o.sessions }, (_, i) => one(i));
  // Barrier: every session connected (or failed to), then measure idle memory and release the turns together.
  while (connectedCount < o.sessions) await sleep(100);
  await sleep(1000);
  try { res.rssConnected = (await getMetrics(base)).rssMb; } catch { /* ignore */ }
  const t1 = performance.now();
  release();
  await Promise.all(all);
  res.wallSec = (performance.now() - t1) / 1000;
  sampling = false;
  await sampler;
  try { res.serverMetrics = (await getMetrics(base)).metrics; } catch { /* ignore */ }
  void t0;
  return res;
}

const f = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : 'n/a');

export function renderLoad(r: LoadResult, label: string): string {
  const c = r.clientMs;
  const s = r.serverMs;
  const perSession = r.connected > 0 ? (r.rssConnected - r.rssBase) / r.connected : NaN;
  const llmFirst = r.serverMetrics.llm_first_token;
  return [
    `**${label}**`, '',
    `- Setup: ${r.sessions} sessions x ${r.turns} turns over WebSocket, stub LLM with ${r.stubDelay} ms per chunk-step (an ideal turn is about ${r.idealTurnMs} ms: three chunk-steps), LLM concurrency limit ${r.llmConcurrency}, think time 0 to 2x the configured mean between turns. ${r.connected}/${r.sessions} sessions connected.`,
    `- Turns: ${r.completedTurns} completed, ${r.failedTurns} failed, ${r.highDemand} answered with the "very high demand" message (limiter queue timeout). Wall time ${r.wallSec.toFixed(1)} s.`,
    `- Turn latency, client send to answer: p50 ${f(percentile(c, 0.5))} ms, p95 ${f(percentile(c, 0.95))} ms, max ${f(c.length ? Math.max(...c) : NaN)} ms. Server turn_total: p50 ${f(percentile(s, 0.5))} ms, p95 ${f(percentile(s, 0.95))} ms.`,
    `- llm_first_token (includes limiter wait): p50 ${f(llmFirst?.p50 ?? NaN)} ms, p95 ${f(llmFirst?.p95 ?? NaN)} ms.`,
    `- Limiter: peak active ${r.peakActive}, peak queued ${r.peakQueued}.`,
    `- Event-loop lag p99 (cumulative histogram of the server process): peak ${r.lagMax.toFixed(1)} ms, at the end ${r.lagLast.toFixed(1)} ms.`,
    `- Server RSS: ${r.rssBase} MB idle, ${r.rssConnected} MB with all sessions connected (${f(perSession * 1024)} KB per idle session), ${r.rssPeak} MB peak under load.`,
    ...(r.errors.length ? [`- Errors: ${[...new Set(r.errors)].slice(0, 5).join('; ')} (${r.errors.length} total)`] : []),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = Number(arg('sessions', '200'));
  const turns = Number(arg('turns', '5'));
  const stubDelay = Number(arg('stub-delay', '600'));
  const thinkMs = Number(arg('think-ms', '1500'));
  const rampMs = Number(arg('ramp-ms', '4000'));
  const llmConcurrency = Number(arg('llm-concurrency', '50'));
  const external = arg('base');
  const procs: ChildProcess[] = [];
  let base = external;
  try {
    if (!base) {
      const port = 4010;
      const mockPort = 4110;
      base = `http://127.0.0.1:${port}`;
      const env = {
        LLM_PROVIDER: 'stub', STUB_CHUNK_DELAY_MS: String(stubDelay), PORT: String(port), MOCK_PORT: String(mockPort), MOCK_BASE_URL: `http://127.0.0.1:${mockPort}`,
        LOGIN_RATE_PER_MIN: '1000000', TURN_RATE_PER_MIN: '1000000', LLM_MAX_CONCURRENCY: String(llmConcurrency), SESSION_SECRET: 'load-test-secret',
        EVENT_LOG_DIR: mkdtempSync(join(tmpdir(), 'load-events-')), GEMINI_API_KEY: '', DEMO_ACCESS_CODE: '',
      };
      procs.push(child('apps/mock-systems/src/main.ts', env, 'mocks'));
      await sleep(1500);
      procs.push(child('apps/server/src/main.ts', env, 'server'));
    }
    await waitHealthy(base);
    const r = await runLoad(base, { sessions, turns, thinkMs, rampMs, stubDelay, llmConcurrency });
    const label = arg('label', `${sessions} sessions, LLM concurrency ${llmConcurrency}`)!;
    const block = renderLoad(r, label);
    console.log(block);
    if (arg('no-write') !== 'true') {
      const prev = readSection('Concurrency') ?? '';
      const intro = 'Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.\n\n';
      const blocks = prev.startsWith('Run with') ? prev.split('\n\n').slice(1).join('\n\n') : prev;
      const kept = blocks.split(/\n\n(?=\*\*)/).filter((b) => b.trim() && !b.startsWith(`**${label}**`));
      upsertSection('Concurrency', intro + [...kept, block].join('\n\n'));
    }
  } finally {
    for (const p of procs.reverse()) p.kill('SIGINT');
    await sleep(500);
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  }
  process.exit(0);
}
