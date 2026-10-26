import { describe, expect, it } from 'vitest';
import { voiceSection } from './latencyReport.js';

const v = (runs: number) => {
  const a = Array.from({ length: runs }, (_, i) => 1000 + i * 10);
  return { runs, stt: a, llm: a, firstAudioServer: a, firstAudioClient: a, turnTotal: a, barge: a, failures: [] };
};

describe('voiceSection', () => {
  it('labels p95 as the max when there are too few runs for a real p95', () => {
    const out = voiceSection(v(5));
    expect(out).toContain('| Stage | n | p50 | p95 (max of 5 runs) |');
    expect(out).toContain('| 5 | 1020 | 1040 |');
  });
  it('keeps a plain p95 header with 20 or more runs', () => {
    expect(voiceSection(v(20))).toContain('| Stage | n | p50 | p95 |');
  });
});
