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
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeLatencyReport } from './latencyReport.js';
import { type LoadResult, type MetricsReply } from './loadStats.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CUSTOMERS = ['C1001', 'C1002', 'C1003', 'C1004'];
const PROMPTS = ['Why did my EMI go up?', "What's my EMI now?", 'Tell me about my EMI change', 'Explain my EMI again', 'Has my EMI changed?'];

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
    mkdirSync(join(ROOT, '.data/bench'), { recursive: true });
    if (arg('no-write') !== 'true') {
      writeFileSync(join(ROOT, `.data/bench/load-${sessions}-${llmConcurrency}.json`), JSON.stringify({ label, result: r }));
      console.log(`report: ${writeLatencyReport()}`);
    }
    console.log(JSON.stringify({ label, ...r, clientMs: undefined, serverMs: undefined }));
  } finally {
    for (const p of procs.reverse()) p.kill('SIGINT');
    await sleep(500);
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  }
  process.exit(0);
}
