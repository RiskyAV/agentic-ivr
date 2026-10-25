import { describe, expect, it } from 'vitest';
import { actionResultMsg } from './ws.js';

describe('actionResultMsg', () => {
  it('marks execution_uncertain and validation_unavailable failures as retryable, with the reason', () => {
    for (const reason of ['execution_uncertain', 'validation_unavailable']) {
      expect(actionResultMsg('P1', { status: 'failed', reason, message: 'm' })).toEqual({
        type: 'action_result', proposalId: 'P1', status: 'failed', message: 'm', reason, retryable: true,
      });
    }
  });
  it('other outcomes are not retryable; cancelled maps to rejected; reference passes through', () => {
    const terminal = actionResultMsg('P1', { status: 'failed', message: 'This request failed earlier.' });
    expect(terminal.retryable).toBeUndefined();
    expect(actionResultMsg('P1', { status: 'rejected', reason: 'hash_mismatch', message: 'x' })).toMatchObject({ status: 'rejected', reason: 'hash_mismatch' });
    expect(actionResultMsg('P1', { status: 'rejected', reason: 'hash_mismatch', message: 'x' }).retryable).toBeUndefined();
    expect(actionResultMsg('P1', { status: 'cancelled', message: 'c' }).status).toBe('rejected');
    expect(actionResultMsg('P1', { status: 'executed', reference: 'SR-1', message: 'ok' })).toMatchObject({ status: 'executed', reference: 'SR-1' });
  });
});
