import { describe, expect, it, vi } from 'vitest';
import { withFallback, type Pdp } from '@/infrastructure/indexer/fallbackIndexer';
import { IndexerBreaker } from '@/infrastructure/indexer/indexerBreaker';

const pdp = (impl: () => Promise<unknown>) => ({ queryContractState: vi.fn(impl), watchForTxData: vi.fn(impl) }) as unknown as Pdp & { queryContractState: ReturnType<typeof vi.fn>; watchForTxData: ReturnType<typeof vi.fn> };
const q = (p: Pdp) => (p as unknown as { queryContractState(a: string): Promise<unknown> }).queryContractState('addr');

describe('IndexerBreaker + fallback', () => {
  it('after a failure, skips the configured indexer for the cooldown, then retries it once', async () => {
    let now = 0;
    const breaker = new IndexerBreaker(60_000, () => now);
    const states: string[] = [];
    breaker.subscribe((s) => states.push(s.status));
    let primaryUp = false;
    const primary = pdp(async () => {
      if (!primaryUp) throw new TypeError('Failed to fetch');
      return { from: 'primary' };
    });
    const fallback = pdp(async () => ({ from: 'wallet' }));
    const reads = withFallback(primary, fallback, breaker);

    expect(await q(reads)).toEqual({ from: 'wallet' }); // primary failed → wallet's indexer
    expect(breaker.get()).toMatchObject({ status: 'down', retryAt: 60_000, lastError: 'Failed to fetch' });

    for (let i = 0; i < 5; i++) expect(await q(reads)).toEqual({ from: 'wallet' });
    expect(primary.queryContractState).toHaveBeenCalledTimes(1); // not hammered during the cooldown

    now = 60_000;
    primaryUp = true;
    expect(await q(reads)).toEqual({ from: 'primary' }); // retried once, and it answered
    expect(breaker.get().status).toBe('ok');
    expect(states).toEqual(['down', 'ok']);
  });

  it('"not found" on the configured indexer is an answer: it falls back for the data but stays healthy', async () => {
    const breaker = new IndexerBreaker();
    const reads = withFallback(pdp(async () => null), pdp(async () => ({ from: 'wallet' })), breaker);
    expect(await q(reads)).toEqual({ from: 'wallet' });
    expect(breaker.get().status).toBe('ok');
  });

  it('a failed watch on the configured indexer opens the breaker; the wallet’s watch still resolves', async () => {
    const breaker = new IndexerBreaker();
    const reads = withFallback(pdp(async () => { throw new Error('503'); }), pdp(async () => ({ txHash: 'h' })), breaker) as unknown as { watchForTxData(id: string): Promise<unknown> };
    expect(await reads.watchForTxData('id')).toEqual({ txHash: 'h' });
    expect(breaker.get().status).toBe('down');
  });

  it('without a breaker it behaves as before (configured indexer tried every time)', async () => {
    const primary = pdp(async () => { throw new Error('down'); });
    const reads = withFallback(primary, pdp(async () => ({ from: 'wallet' })));
    await q(reads);
    await q(reads);
    expect(primary.queryContractState).toHaveBeenCalledTimes(2);
  });
});
