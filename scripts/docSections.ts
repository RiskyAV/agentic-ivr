import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LATENCY_REPORT = join(ROOT, 'docs/latency-report.md');

/** Section order of docs/latency-report.md. Scripts own their sections; hand-written ones are preserved. */
export const SECTION_ORDER = ['Default', 'Chaos', 'Model comparison', 'Where the time goes', 'Voice', 'Concurrency', 'Path to 1,000 concurrent', 'Deterministic replay'];
const HEADER = '# Latency and load report\n\nProduced by `npm run bench`, `npm run load` and `scripts/voice-smoke.ts` against the running stack (see each section for the command and conditions). Times are milliseconds. p50 and p95 use nearest-rank.\n';

function parse(text: string): { header: string; sections: Map<string, string> } {
  const parts = text.split(/^## /m);
  const header = parts.shift() ?? HEADER;
  const sections = new Map<string, string>();
  for (const p of parts) {
    const nl = p.indexOf('\n');
    sections.set(p.slice(0, nl).trim(), p.slice(nl + 1).replace(/\s+$/, ''));
  }
  return { header: header.trim() ? header : HEADER, sections };
}

/** Replaces (or adds) one `## title` section of docs/latency-report.md, keeping every other section as it is. */
export function upsertSection(title: string, body: string, path = LATENCY_REPORT): void {
  const cur = existsSync(path) ? parse(readFileSync(path, 'utf8')) : { header: HEADER, sections: new Map<string, string>() };
  cur.sections.set(title, body.replace(/\s+$/, ''));
  const known = SECTION_ORDER.filter((t) => cur.sections.has(t));
  const extra = [...cur.sections.keys()].filter((t) => !SECTION_ORDER.includes(t));
  const out = [cur.header.trimEnd(), ...[...known, ...extra].map((t) => `## ${t}\n\n${cur.sections.get(t)!}`)].join('\n\n') + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
}

export function readSection(title: string, path = LATENCY_REPORT): string | undefined {
  return existsSync(path) ? parse(readFileSync(path, 'utf8')).sections.get(title) : undefined;
}
