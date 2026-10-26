import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upsertSection } from './docSections.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'docs-')), 'report.md');

describe('upsertSection', () => {
  it('is idempotent: upserting the same section twice gives identical output', () => {
    const path = tmp();
    upsertSection('Default', 'body one\n\n\n', path);
    upsertSection('Concurrency', '\n\nbody two\n', path);
    const once = readFileSync(path, 'utf8');
    upsertSection('Default', 'body one', path);
    upsertSection('Concurrency', 'body two', path);
    expect(readFileSync(path, 'utf8')).toBe(once);
  });
  it('replaces one section and keeps the others and the order', () => {
    const path = tmp();
    upsertSection('Concurrency', 'c1', path);
    upsertSection('Default', 'd1', path);
    upsertSection('Concurrency', 'c2', path);
    const text = readFileSync(path, 'utf8');
    expect(text.indexOf('## Default')).toBeLessThan(text.indexOf('## Concurrency'));
    expect(text).toContain('d1');
    expect(text).toContain('c2');
    expect(text).not.toContain('c1');
    expect(text.match(/^## /gm)).toHaveLength(2);
  });
  it('does not grow blank lines or trailing whitespace on repeated writes', () => {
    const path = tmp();
    for (let i = 0; i < 4; i++) upsertSection('Default', `line\n\n| a | b |\n`, path);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/\n\n\n/);
    expect(text.endsWith('|\n')).toBe(true);
  });
});
