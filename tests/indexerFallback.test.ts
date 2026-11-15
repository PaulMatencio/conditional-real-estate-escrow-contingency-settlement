import { describe, expect, it, vi } from 'vitest';
import { withFallback } from '@/infrastructure/indexer/fallbackIndexer';

const mk = (state: unknown, tx?: unknown) =>
  ({
    queryContractState: vi.fn(async () => {
      if (state instanceof Error) throw state;
      return state;
    }),
    queryUnshieldedBalances: vi.fn(async () => null),
    queryDeployContractState: vi.fn(async () => null),
    watchForTxData: vi.fn(() => (tx === undefined ? new Promise(() => {}) : Promise.resolve(tx))),
    watchForDeployTxData: vi.fn(() => new Promise(() => {})),
    other: vi.fn(() => 'primary-other')
  }) as never;

describe('indexer reads with a wallet-indexer fallback', () => {
  it('uses the configured indexer when it has the contract', async () => {
    const p = mk({ data: 'p' }), f = mk({ data: 'f' });
    expect(await (withFallback(p, f) as never as { queryContractState(a: string): Promise<unknown> }).queryContractState('x')).toEqual({ data: 'p' });
    expect((f as never as { queryContractState: { mock: { calls: unknown[] } } }).queryContractState.mock.calls).toHaveLength(0);
  });

  it('falls back when the configured indexer returns nothing or fails', async () => {
    for (const first of [null, new Error('down')]) {
      const w = withFallback(mk(first), mk({ data: 'f' })) as never as { queryContractState(a: string): Promise<unknown> };
      expect(await w.queryContractState('x')).toEqual({ data: 'f' });
    }
  });

  it('a watch resolves with whichever indexer sees the transaction first; other methods pass through', async () => {
    const w = withFallback(mk(null), mk(null, { txHash: 'h' })) as never as { watchForTxData(id: string): Promise<unknown>; other(): string };
    expect(await w.watchForTxData('id')).toEqual({ txHash: 'h' });
    expect(w.other()).toBe('primary-other');
  });
});
