/**
 * Accuracy golden eval + red-team eval against a running server.
 *
 *   npm run eval -- [--base http://127.0.0.1:4000] [--model gemini-3.5-flash-lite] [--only golden|redteam]
 *                   [--concurrency 3] [--case G05,R03] [--primary <model>] [--report-only]
 *
 * Results of each model run are kept in .data/eval/<model>.json; docs/eval-report.md is rendered from all of them.
 */
import { loadRootEnv } from '../../apps/server/src/config.js';
import { goldenCases, usesChaos, type GoldenCase } from './cases/golden.js';
import { TODAY } from './cases/facts.js';
import { SCORER, loadRuns, saveRun, summariseRun, updateDecisions, writeReport, type CaseRow, type ModelRun } from './report.js';
import { runRedTeam } from './redteam.js';
import { arg, pool, resetChaos, runConversationFull, scoreGolden } from './runner.js';

async function runCase(base: string, c: GoldenCase): Promise<CaseRow> {
  try {
    const conv = await runConversationFull(base, c.customerId, c.steps, c.workflowId ? { workflowId: c.workflowId } : {});
    const s = scoreGolden(conv.results, c.expect, conv.opener !== undefined ? { opener: conv.opener } : {});
    const last = conv.results[conv.results.length - 1];
    const answer = [...conv.results].reverse().find((r) => r.text)?.text ?? last?.actionResults.map((a) => `${a.status}: ${a.message}`).join(' ') ?? '';
    return { id: c.id, title: c.title, pass: s.pass, failures: s.failures, ms: conv.results.map((r) => r.ms), answer };
  } catch (e) {
    return { id: c.id, title: c.title, pass: false, failures: [`runner error: ${(e as Error).message}`], ms: [], answer: '' };
  }
}

export async function runGolden(base: string, concurrency: number, only?: Set<string>): Promise<CaseRow[]> {
  const cases = goldenCases().filter((c) => !only || only.has(c.id));
  const plain = cases.filter((c) => !usesChaos(c));
  const stateful = cases.filter(usesChaos);
  await resetChaos(base);
  const rows = new Map<string, CaseRow>();
  for (const r of await pool(plain, concurrency, (c) => runCase(base, c))) rows.set(r.id, r);
  for (const c of stateful) {
    // Chaos and confirm cases change shared mock state: one at a time, with a reset after each.
    rows.set(c.id, await runCase(base, c));
    await resetChaos(base);
  }
  return cases.map((c) => rows.get(c.id)!);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadRootEnv();
  const base = arg('base', `http://127.0.0.1:${process.env.PORT ?? 4000}`)!;
  const model = arg('model', process.env.GEMINI_MODEL ?? 'unknown')!;
  const only = arg('only');
  const concurrency = Number(arg('concurrency', '3'));
  const cases = arg('case') ? new Set(arg('case')!.split(',')) : undefined;
  if (arg('report-only') !== 'true') {
    const run: ModelRun = { model, guardModel: process.env.GEMINI_GUARD_MODEL ?? 'gemini-3.5-flash-lite', at: new Date().toISOString(), today: TODAY };
    if (only !== 'redteam') {
      run.golden = await runGolden(base, concurrency, cases);
      for (const r of run.golden) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.title}${r.pass ? '' : `\n     ${r.failures.join('\n     ')}\n     ANSWER: ${r.answer.replace(/\s+/g, ' ')}`}`);
      console.log(`golden: ${run.golden.filter((r) => r.pass).length}/${run.golden.length}`);
    }
    if (only !== 'golden') {
      run.redteam = await runRedTeam(base, concurrency, cases);
      for (const r of run.redteam) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.category} ${r.pass ? '' : `\n     ${r.failures.join('\n     ')}\n     ANSWER: ${r.answer.replace(/\s+/g, ' ')}`}`);
      console.log(`red team: ${run.redteam.filter((r) => r.pass && !r.extra).length}/${run.redteam.filter((r) => !r.extra).length} required, ${run.redteam.filter((r) => r.pass && r.extra).length}/${run.redteam.filter((r) => r.extra).length} extras`);
    }
    // Only complete runs (golden and red team, every case) are recorded: a history row is one whole run.
    if (run.golden && run.redteam && !cases) {
      const prev = loadRuns().find((r) => r.model === model);
      const history = [...(prev?.history ?? []), summariseRun(run.at, run.golden, run.redteam)];
      saveRun({ ...run, history, scorer: SCORER });
    } else {
      console.log('(partial run: not recorded)');
    }
  }
  const runs = loadRuns();
  const path = writeReport(runs, arg('primary', model)!);
  updateDecisions(runs, arg('primary', model)!);
  console.log(`report: ${path}`);
}
