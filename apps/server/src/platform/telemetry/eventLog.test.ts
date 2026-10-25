import { mkdtempSync, readdirSync } from 'node:fs';
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
});
