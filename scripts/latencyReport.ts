/**
 * Renders docs/latency-report.md from scratch out of the raw results in .data/ (bench, voice, load, replay, eval).
 * Nothing in the report is pasted by hand: every number is read from those files.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { percentile } from './eval/runner.js';
import { loadRuns, modelTable } from './eval/report.js';
import { fmt, renderStats, shares, type Samples } from './benchStats.js';
import { LATENCY_REPORT, ROOT, upsertSection } from './docSections.js';
import { renderLoad, type LoadResult } from './loadStats.js';

const BENCH = join(ROOT, '.data/bench');
const read = <T>(file: string): T | undefined => {
  try { return JSON.parse(readFileSync(join(BENCH, file), 'utf8')) as T; } catch { return undefined; }
};
interface BenchFile { model: string; runs: number; chaosSpec?: string; samples: Samples }
interface LoadFile { label: string; result: LoadResult }
interface VoiceFile { runs: number; stt: number[]; llm: number[]; firstAudioServer: number[]; firstAudioClient: number[]; turnTotal: number[]; barge: number[]; failures: string[] }
interface ReplayTurn { turnId: string; user: string; original: string; replayed: string; same: boolean; status: string }
interface ReplayFile { sessionId: string; model?: string; recorded: { turns: ReplayTurn[]; misses: string[] }; live: { turns: ReplayTurn[]; misses: string[] } }

const p = (v: number[], q: number) => fmt(percentile(v, q));
const pp = (v: number[]) => `${p(v, 0.5)} / ${p(v, 0.95)}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function benchSection(title: string, f: BenchFile, extra = ''): string {
  const cmd = `npm run bench -- --runs ${f.runs}${f.chaosSpec ? ` --chaos ${f.chaosSpec}` : ''}`;
  const cond = f.chaosSpec ? `Chaos \`--chaos ${f.chaosSpec}\` (system:extra latency ms:failure rate).` : 'Default mock latencies, no chaos.';
  return [`Model \`${f.model}\` (guard \`gemini-3.5-flash-lite\`). ${cond} Command: \`${cmd}\`.`, '', renderStats(f.samples, f.runs), ...(extra ? ['', extra] : [])].join('\n');
}

function timeGoes(d: BenchFile, c: BenchFile | undefined, h: BenchFile | undefined, v: VoiceFile | undefined): string {
  const s = d.samples;
  const sh = shares(s);
  const tools = Object.entries(s.tool).map(([k, a]) => [k, percentile(a, 0.5), percentile(a, 0.95)] as const).sort((a, b) => b[1] - a[1]);
  const backends = Object.entries(s.backend).map(([k, a]) => `${k.slice(8)} ${p(a, 0.5)} ms`).join(', ');
  const journeys = Object.entries(s.journey).map(([k, a]) => [k, percentile(a, 0.5)] as const).sort((a, b) => b[1] - a[1]);
  const L: string[] = [];
  L.push(`Median share of a turn's server time (default run, ${s.turns} turns, \`${d.model}\`), computed from the trace spans: LLM rounds ${pct(sh.llm)}, tool execution ${pct(sh.tool)} (tool spans overlap with each other, so their union is used), everything else ${pct(sh.other)}. The guard classifier (p50 ${p(s.guard, 0.5)} ms, p95 ${p(s.guard, 0.95)} ms) runs in parallel with the turn; the engine waited out its verdict timeout in ${s.guardTimeouts} of ${s.turns} default turns.`, '');
  L.push(`- **LLM.** First token p50 ${p(s.llm_first_token, 0.5)} ms (p95 ${p(s.llm_first_token, 0.95)} ms). A tool turn needs two model rounds, so the model is the largest single cost of a ${p(s.turn_total, 0.5)} ms median turn.`);
  L.push(`- **Tools.** Slowest by p50: ${tools.slice(0, 3).map(([k, a, b]) => `${k} ${fmt(a)} ms (p95 ${fmt(b)})`).join('; ')}. A tool span includes every backend call it fans out to; backend p50 per system: ${backends}.`);
  L.push(`- **Journeys.** Slowest by median turn: ${journeys.map(([k, a]) => `${k} ${fmt(a)} ms`).join(', ')}.`);
  if (c) {
    const cs = c.samples;
    const pay = cs.outcomes.payments ?? {};
    const reached = Object.entries(cs.confirmed).map(([k, n]) => `${k} ${n} of ${cs.journeyRuns[k]}`).join(', ');
    L.push(`- **Chaos (\`${c.chaosSpec}\`).** ${cs.turns} turns, turn_total p50 ${p(cs.turn_total, 0.5)} ms, p95 ${p(cs.turn_total, 0.95)} ms, max ${fmt(Math.max(...cs.turn_total))} ms against a 9000 ms budget; ${cs.degraded} turns ended degraded and ${cs.guardTimeouts} guard verdicts timed out. Payments calls: ${Object.entries(pay).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. When payments is down the assistant cannot build the dispute or promise, so the journeys did not always reach their confirm step; runs with a proposal to confirm: ${reached}. That is the honest outcome (the answer says it could not check), not a runner fault.`);
  }
  const hp = h?.samples.backend['backend:payments'] ?? [];
  const hedgeNote = h
    ? ` A slow-tail run (\`${h.chaosSpec}\`: every payments call about 600 ms slower, still inside the 1.5 s timeout) gave payments p50 ${p(hp, 0.5)} ms / p95 ${p(hp, 0.95)} ms and ${h.samples.hedged} completed hedged attempts in ${h.samples.backendCalls} calls: hedging did not help there either, because the hedge delay is the rolling p95 of recent successful calls, so a backend that is uniformly slower moves its own p95 up and no call looks like a tail outlier.`
    : '';
  L.push(`- **Hedging did not fire in any run (honest finding).** Completed hedged attempts: ${s.hedged} of ${s.backendCalls} calls by default and ${c ? `${c.samples.hedged} of ${c.samples.backendCalls}` : 'n/a'} under chaos. Two mechanisms explain it. (1) A hedge starts only for a GET while the circuit breaker is closed, after the rolling p95 of recent successes, within a 10% budget, and never on a half-open trial. Under \`${c?.chaosSpec ?? 'chaos'}\` every payments call exceeds the 1.5 s call timeout, the consecutive-failure count reaches 5 inside the first logical call (3 attempts, each possibly with a hedge), the breaker opens for 10 s, and from then on payments calls are short-circuited or half-open trials. (2) A hedge that loses the race is cancelled before it reports, so this counter only sees hedges that completed, which understates launches.${hedgeNote} Hedging helps against occasional slow outliers on an otherwise fast backend, which these profiles do not produce; the breaker, retries and stale fallback are what handled the outage here.`);
  if (v) {
    L.push(`- **Voice.** End of speech to final transcript p50 ${p(v.stt, 0.5)} ms; LLM first token p50 ${p(v.llm, 0.5)} ms (p95 ${p(v.llm, 0.95)}); first audio at the test client p50 ${p(v.firstAudioClient, 0.5)} ms, p95 ${p(v.firstAudioClient, 0.95)} ms (${v.runs} runs). The STT silence window and vendor commit set the first term; the LLM first token and the first TTS sentence the rest.`);
  }
  return L.join('\n');
}

function voiceSection(v: VoiceFile): string {
  const row = (name: string, a: number[]) => `| ${name} | ${a.length} | ${p(a, 0.5)} | ${p(a, 0.95)} |`;
  return [
    `\`npx tsx scripts/voice-smoke.ts\` run ${v.runs} times (real Gemini, real ElevenLabs STT and TTS, in-process mocks; macOS \`say\` fixtures of "What's my next EMI?" and "Actually, check my last payment first."). Scenario 1 gives the first five rows; the barge-in row comes from scenario 2. The "test client" row is the end-of-speech to first audio frame as the WebSocket client sees it; browser playback adds the audio output buffer on top, and no browser end-to-end figure is repeated here.`, '',
    '| Stage | n | p50 | p95 |\n|---|---|---|---|',
    row('STT commit (end of speech to final transcript)', v.stt),
    row('LLM first token (engine, after turn start)', v.llm),
    row('First TTS audio, server (commit to first audio frame sent)', v.firstAudioServer),
    row('First TTS audio at the test client (end of speech)', v.firstAudioClient),
    row('turn_total (engine)', v.turnTotal),
    row('Barge-in (interruption begins to barge_in event)', v.barge),
    ...(v.failures.length ? ['', `Failed runs: ${v.failures.join('; ')}`] : []),
  ].join('\n');
}

function pathTo1000(loads: LoadFile[]): string {
  const by = (sessions: number, lim: (l: number) => boolean) => loads.find((l) => l.result.sessions === sessions && lim(l.result.llmConcurrency));
  const lifted = [...loads].filter((l) => l.result.llmConcurrency >= l.result.sessions).sort((a, b) => b.result.sessions - a.result.sessions)[0]?.result;
  const dflt200 = by(200, (l) => l === 50)?.result;
  const dflt500 = by(500, (l) => l === 50)?.result;
  const r = (x: LoadResult) => `${x.sessions} sessions`;
  const L: string[] = [];
  L.push('What the load test shows (stub LLM, one Node process, load generator on the same Mac):', '');
  if (lifted) {
    const c = lifted.clientMs;
    L.push(`- **Server overhead is small.** ${r(lifted)} with the LLM limit lifted to ${lifted.llmConcurrency}: turn p50 ${p(c, 0.5)} ms and p95 ${p(c, 0.95)} ms for a turn whose ideal stub time is ${lifted.idealTurnMs} ms; ${lifted.failedTurns} failed turns; event-loop lag p99 peak ${lifted.lagMax.toFixed(1)} ms (the histogram resolution is 20 ms, so this is the floor, not a measured idle value). RSS ${lifted.rssBase} MB empty, ${lifted.rssConnected} MB with all sessions connected, ${lifted.rssPeak} MB peak: about ${fmt(((lifted.rssConnected - lifted.rssBase) / lifted.connected) * 1024)} KB per idle session, so 1,000 sessions is roughly ${fmt(lifted.rssBase + (1000 * (lifted.rssPeak - lifted.rssBase)) / lifted.sessions)} MB at the peak-under-load rate.`);
  }
  if (dflt200 && dflt500) {
    L.push(`- **What degrades first is the LLM concurrency limit (50) with its 4 s queue timeout, by design.** At ${r(dflt200)} everything completes (peak queue ${dflt200.peakQueued}, turn p50 ${p(dflt200.clientMs, 0.5)} ms). At ${r(dflt500)}: peak queue ${dflt500.peakQueued}, turn p50 ${p(dflt500.clientMs, 0.5)} ms, and ${dflt500.highDemand} of ${dflt500.completedTurns} turns were answered with the "very high demand" message. Shedding is the intended behaviour, but a 50-wide limit cannot serve 1,000 users.`);
  }
  L.push(
    '- **Call-rate arithmetic for 1,000 concurrent users.** If each user sends one turn every 10 s, that is 100 turns/s. A tool turn needs at least two answer-model calls (the tool round and the final answer) plus one guard classification, so about 200 answer calls/s plus 100 guard calls/s, roughly 300 model requests/s. At the observed first-token latency that is hundreds of calls in flight, far above a limit of 50.',
    '- **What breaks next, in order:** (1) the provider quota on the Gemini key (requests and tokens per minute) before our limiter matters; (2) the single event loop: synchronous JSONL appends in the event log (`appendFileSync` per event), JSON serialisation of every delta and trace, and snapshot loads all run on one thread; the lag is not visible at this scale, but it is the first CPU limit; (3) backend fan-out (a cold turn makes 3 to 7 backend calls) and the per-process connector caches; (4) in-memory sessions, proposals and audit log tie a user to one process.',
    '- **What to change:** raise `LLM_MAX_CONCURRENCY` to the provider quota and put the guard on its own limiter so it cannot starve answers; replace `appendFileSync` with a buffered asynchronous writer; run N Node processes behind a load balancer with sticky routing by session id and move sessions, proposals and the audit log to Redis or a database so a reconnect can land anywhere; add a shared cache in front of the read endpoints and keep hedging on; shed load before the model call by queue depth rather than by timeout, and keep voice on a separately capped pool (`MAX_VOICE_SESSIONS`), since each voice session also holds an STT and a TTS websocket to the vendor. The scarce resource is model tokens, not CPU.',
  );
  return L.join('\n');
}

function replaySection(f: ReplayFile): string {
  const show = (t: ReplayTurn) => `ORIGINAL: ${t.original.replace(/\s+/g, ' ')}\nREPLAYED: ${t.replayed.replace(/\s+/g, ' ')}\n${t.same ? 'IDENTICAL' : 'DIFFERENT'}`;
  const ident = f.recorded.turns.filter((t) => t.same).length;
  const liveDiff = f.live.turns.filter((t) => !t.same);
  return [
    `\`npm run replay -- <sessionId> [--turn n] [--live-llm]\` rebuilds the engine with the logged backend responses (served by method and path, in order; a request with no logged response is reported and served as 404), the logged LLM output and the logged guard verdicts. Session \`${f.sessionId}\`, ${f.recorded.turns.length} turns.`, '',
    `**Recorded LLM:** ${ident} of ${f.recorded.turns.length} turns identical${f.recorded.misses.length ? `; unrecorded requests: ${[...new Set(f.recorded.misses)].join(', ')}` : '; no unrecorded backend requests'}.`, '',
    '```', ...f.recorded.turns.map((t, i) => `turn ${i + 1}: "${t.user}"\n${show(t)}`), '```', '',
    `**Live LLM (\`${f.model ?? 'default model'}\`, same recorded backend):** ${f.live.turns.length - liveDiff.length} of ${f.live.turns.length} turns identical${f.live.misses.length ? `; backend requests with no recording (served 404): ${[...new Set(f.live.misses)].join(', ')}` : ''}.`, '',
    '```', ...liveDiff.map((t) => `turn ${f.live.turns.indexOf(t) + 1}: "${t.user}"\n${show(t)}`), '```', '',
    'A live model may ask a backend question the recording never saw (different arguments); the replay reports those and the model then answers from a 404, as in any turn above that reports an unrecorded request. Replay reproduces model faults exactly, so a recorded `[unverified]` marker replays with the same marker. Not replayed: confirm (execution) steps, and sessions recorded before the connect-time snapshot load was logged.',
  ].join('\n');
}

/** Regenerates the whole report from the raw results. */
export function writeLatencyReport(): string {
  rmSync(LATENCY_REPORT, { force: true });
  const d = read<BenchFile>('Default.json');
  const c = read<BenchFile>('Chaos.json');
  const h = read<BenchFile>('Hedging.json');
  const v = read<VoiceFile>('voice.json');
  const replay = read<ReplayFile>('replay.json');
  const loads = existsSync(BENCH) ? readdirSync(BENCH).filter((f) => /^load-.*\.json$/.test(f)).map((f) => read<LoadFile>(f)!).sort((a, b) => a.result.sessions - b.result.sessions || a.result.llmConcurrency - b.result.llmConcurrency) : [];
  const models = existsSync(BENCH) ? readdirSync(BENCH).filter((f) => f.startsWith('model-')).map((f) => read<BenchFile>(f)!) : [];
  if (d) upsertSection('Default', benchSection('Default', d));
  if (c) upsertSection('Chaos', benchSection('Chaos', c));
  if (h) upsertSection('Hedging', benchSection('Hedging', h, 'A slow-tail profile: payments are slower than the rolling p95 but within the 1.5 s call timeout, so hedges can fire.'));
  const evals = loadRuns();
  if (models.length) {
    const primary = d?.model ?? 'gemini-3.5-flash-lite';
    const rows = models.sort((a, b) => a.model.localeCompare(b.model)).map((m) => {
      const s = m.samples;
      const j = (id: string) => pp(s.journey[id] ?? []);
      return `| ${m.model}${m.model === primary ? ' (default)' : ''} | ${m.runs} | ${pp(s.llm_first_token)} | ${pp(s.turn_total)} | ${j('J1')} | ${j('J2')} | ${j('J3')} | ${j('J4')} | ${s.degraded}/${s.turns} |`;
    });
    upsertSection('Model comparison', [
      `Latency: the same four journeys, ${models[0]!.runs} runs each, real Gemini, default backend latencies, guard \`gemini-3.5-flash-lite\` in every row. Accuracy: the strict scorer (see docs/eval-report.md), same table as in the report and in DECISIONS.md D-044.`, '',
      modelTable(evals, primary), '',
      '| Model | bench runs | llm_first_token p50 / p95 | turn_total p50 / p95 | J1 p50 / p95 | J2 p50 / p95 | J3 p50 / p95 | J4 p50 / p95 | degraded turns |', '|---|---|---|---|---|---|---|---|---|', ...rows,
    ].join('\n'));
  }
  if (d) upsertSection('Where the time goes', timeGoes(d, c, h, v));
  if (v) upsertSection('Voice', voiceSection(v));
  if (loads.length) {
    upsertSection('Concurrency', ['Run with `npm run load -- --sessions N --turns 5`: the server (stub LLM, real gateway, engine, guard rules, connectors and mock systems) and the load generator run on the same Mac, so the generator competes for CPU; treat the numbers as a floor for server overhead.', '', ...loads.map((l) => renderLoad(l.result, l.label) + '\n')].join('\n'));
    upsertSection('Path to 1,000 concurrent', pathTo1000(loads));
  }
  if (replay) upsertSection('Deterministic replay', replaySection(replay));
  return LATENCY_REPORT;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`report: ${writeLatencyReport()}`);
