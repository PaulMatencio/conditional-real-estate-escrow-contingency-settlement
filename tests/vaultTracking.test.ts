import { describe, expect, it } from 'vitest';
import { trackVault, type PartyContext } from '@/application/partyService';
import { classifyContractError } from '@/domain/contractErrors';
import { AppError } from '@/domain/errors';
import type { TermsPackage } from '@/domain/terms';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';

const terms = { format: 'EscrowTermsV2', terms: {}, commitments: {}, createdAt: 1 } as unknown as TermsPackage;
const ctx = (locate: () => Promise<bigint | null>): PartyContext =>
  ({ gateway: { locateVaultIndex: locate } as unknown as PartyContext['gateway'], crypto: termsCrypto, record: { terms } }) as PartyContext;

describe('vault tracking (seller locates the buyer’s deposit)', () => {
  it('stores the index found', async () => {
    const r = await trackVault(ctx(async () => 7n), { strict: true });
    expect(r.terms?.vaultIndex).toBe('7');
  });

  it('the Locate button gets the reason; the automatic attempt before a payout stays quiet', async () => {
    const failing = ctx(async () => {
      throw new AppError('VALIDATION', 'No transaction with this hash or identifier on the preview indexer.');
    });
    await expect(trackVault(failing, { strict: true })).rejects.toThrow(/No transaction with this hash/);
    expect((await trackVault(failing)).terms?.vaultIndex).toBeUndefined();
  });
});


describe('payout rejected with an unknown coin tree root', () => {
  it('is explained as a wrong vault coin index, with the fix', () => {
    const info = classifyContractError('Transaction failed: use of unknown coin tree root fc3fac7caefc8c405aa3b505dfbfc98ae62ab88439832e850033cf44a054d704');
    expect(info.code).toBe('VAULT_COIN_MISMATCH');
    expect(info.guidance).toMatch(/Locate vault index/);
  });
});
