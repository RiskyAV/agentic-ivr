import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog, type LoggedEvent } from './eventLog.js';

describe('EventLog', () => {
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
