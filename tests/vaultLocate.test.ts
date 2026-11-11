/** A party that did not deposit finds the deposit transaction from the public chain history. */
import { describe, expect, it, vi } from 'vitest';
import type { ChainAction } from '@/application/chainHistory';

const actions: ChainAction[] = [
  { kind: 'deploy', txHash: 'aa', identifiers: [], blockHeight: 1, blockTime: 1, result: 'SUCCESS' },
  { kind: 'call', entryPoint: 'depositToEscrow', txHash: 'failed', identifiers: [], blockHeight: 2, blockTime: 2, result: 'FAILURE' },
  { kind: 'call', entryPoint: 'depositToEscrow', txHash: 'deposit', identifiers: [], blockHeight: 3, blockTime: 3, result: 'SUCCESS' },
  { kind: 'call', entryPoint: 'openContingencyReview', txHash: 'review', identifiers: [], blockHeight: 4, blockTime: 4, result: 'SUCCESS' }
];
vi.mock('@/infrastructure/indexer/chainHistorySource', () => ({
  IndexerChainHistory: class {
    contractActions = async () => ({ actions, complete: true });
  }
}));

describe('findDepositTxHash', () => {
  it('returns the successful deposit, ignoring failed attempts and other calls', async () => {
    const { findDepositTxHash } = await import('@/infrastructure/gateway/partyGateway');
    expect(await findDepositTxHash('ab'.repeat(32))).toBe('deposit');
  });
});
