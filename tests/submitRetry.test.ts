import { describe, expect, it, vi } from 'vitest';
import { isAlreadySubmitted, isUserRejection, submitWithRetry, walletErrorText } from '@/infrastructure/wallet/submitRetry';

const noWait = { sleep: async () => undefined };

describe('wallet submit: one automatic retry of the same transaction', () => {
  it('a first failure is retried once and the second attempt goes through', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error('object: [object Object]')).mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();
    expect(await submitWithRetry(submit, { ...noWait, onRetry })).toEqual({ attempts: 2 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, 'object: [object Object]');
  });

  it('a retry that finds the transaction already in the pool counts as submitted', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('Transaction already imported'));
    expect(await submitWithRetry(submit, noWait)).toEqual({ attempts: 2 });
  });

  it('gives up after the retry and surfaces the last error', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('node unreachable'));
    await expect(submitWithRetry(submit, noWait)).rejects.toThrow('node unreachable');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('never retries a refusal by the user', async () => {
    const refused = { type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'User rejected the transaction' };
    const submit = vi.fn().mockRejectedValue(refused);
    await expect(submitWithRetry(submit, noWait)).rejects.toBe(refused);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(isUserRejection(refused)).toBe(true);
  });

  it('waits before retrying', async () => {
    const sleep = vi.fn(async () => undefined);
    await submitWithRetry(vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(undefined), { sleep, delayMs: 2500 });
    expect(sleep).toHaveBeenCalledWith(2500);
  });
});

describe('wallet error text', () => {
  it('reads DApp Connector errors and nested causes instead of "[object Object]"', () => {
    expect(walletErrorText({ type: 'DAppConnectorAPIError', code: 'InternalError', reason: 'Wallet not synced' })).toBe('InternalError: Wallet not synced');
    expect(walletErrorText(new Error('outer', { cause: { code: 'Disconnected', reason: 'lost' } }))).toBe('outer ← Disconnected: lost');
    const opaque = Object.assign(new Error('object: [object Object]'), { status: 503 });
    expect(walletErrorText(opaque)).toContain('"status":503');
    expect(isAlreadySubmitted(new Error('Duplicate transaction'))).toBe(true);
  });
});
