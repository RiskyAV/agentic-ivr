import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventLog, type LoggedEvent } from './eventLog.js';

describe('EventLog', () => {
  it('never throws: a failing write is warned about once and counted', () => {
    const base = mkdtempSync(join(tmpdir(), 'ev-'));
    const blocker = join(base, 'file');
    writeFileSync(blocker, 'x'); // a file where the directory should be: mkdir/append fail
    const warn = vi.fn();
    const recorded: string[] = [];
    const log = new EventLog(join(blocker, 'events'), { warn, metrics: { record: (n) => { recorded.push(n); } } });
    expect(() => log.append('s1', { type: 'timing', at: 1, metrics: {} })).not.toThrow();
    expect(() => log.append('s1', { type: 'timing', at: 2, metrics: {} })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual(['event_log_errors', 'event_log_errors']);
  });

  it('keeps the directory under maxBytes by deleting the oldest session files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const old = join(dir, 'old.jsonl');
    writeFileSync(old, 'x'.repeat(1500) + '\n');
    utimesSync(old, new Date(1000), new Date(1000));
    const log = new EventLog(dir, { maxBytes: 2000 });
    const big = 'y'.repeat(300);
    for (let i = 0; i < 4; i++) log.append(`s${i}`, { type: 'user_input', at: i, text: big });
    const files = readdirSync(dir);
    expect(files).not.toContain('old.jsonl');
    expect(files).toContain('s3.jsonl');
    const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(2000);
    expect(log.read('s3')).toHaveLength(1);
  });

  it('round-trips events in order, creating the dir', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ev-')), 'nested', 'sessions');
    const log = new EventLog(dir);
    const evs: LoggedEvent[] = [
      { type: 'user_input', at: 1, text: 'hi' },
      { type: 'llm_request', at: 2, promptHash: 'abc' },
      { type: 'assistant_final', at: 3, text: 'hello' },
    ];
    for (const e of evs) log.append('s1', e);
    expect(log.read('s1')).toEqual(evs);
    expect(log.read('nope')).toEqual([]);
  });
  it('sanitises session ids against path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const log = new EventLog(dir);
    log.append('../../evil', { type: 'timing', at: 1, metrics: {} });
    expect(readdirSync(dir).every((f) => f.endsWith('.jsonl') && !f.includes('/'))).toBe(true);
    expect(log.read('../../evil')).toHaveLength(1);
  });
  it('redacts PII before it reaches disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-'));
    const log = new EventLog(dir);
    log.append('s2', { type: 'backend_call', at: 1, system: 'crm', method: 'GET', path: '/x', status: 200, body: { pan: 'ABCDE1234F' } });
    expect((log.read('s2')[0] as { body: { pan: string } }).body.pan).toBe('XXXXXX234F');
    expect(readFileSync(join(dir, 's2.jsonl'), 'utf8')).not.toContain('ABCDE1234F');
  });
});
