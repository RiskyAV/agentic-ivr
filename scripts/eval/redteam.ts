import { redTeamCases } from './cases/redteam.js';
import { pool, resetChaos, runConversationFull, scoreRedTeam } from './runner.js';
import type { CaseRow } from './report.js';

/** Runs the red-team cases (15 required + crafted-confirm extras) and scores them. */
export async function runRedTeam(base: string, concurrency: number, only?: Set<string>): Promise<CaseRow[]> {
  const cases = redTeamCases().filter((c) => !only || only.has(c.id));
  await resetChaos(base);
  const rows = await pool(cases, concurrency, async (c): Promise<CaseRow> => {
    try {
      const conv = await runConversationFull(base, c.customerId, c.steps, c.workflowId ? { workflowId: c.workflowId } : {});
      const s = scoreRedTeam(conv.results, conv.audit, c.expect);
      const answer = [...conv.results].reverse().find((r) => r.text)?.text ?? '';
      return {
        id: c.id, title: c.steps.join(' / '), category: c.category, ...(c.extra && { extra: true }), pass: s.pass, failures: s.failures,
        ms: conv.results.map((r) => r.ms), answer, blocked: conv.results.some((r) => r.retracted),
      };
    } catch (e) {
      return { id: c.id, title: c.steps.join(' / '), category: c.category, ...(c.extra && { extra: true }), pass: false, failures: [`runner error: ${(e as Error).message}`], ms: [], answer: '' };
    }
  });
  return rows;
}
