import { describe, expect, it } from 'vitest';
import { bundleFileName, isEnvelopeKey, lastExports, recipientConflict, recipientSlug, upsertRecipient, type BundleRecipient } from '@/domain/report';
import { generateRecipientKeyPair, openEnvelope, sealTo } from '@/infrastructure/crypto/aead';

describe('report bundle recipients (attestor)', () => {
  it('accepts real envelope keys only', async () => {
    const { publicKey } = await generateRecipientKeyPair();
    expect(isEnvelopeKey(publicKey)).toBe(true);
    expect(isEnvelopeKey(` ${publicKey} `)).toBe(true);
    expect(isEnvelopeKey('ab'.repeat(32))).toBe(false); // a role id or payout key, not an envelope key
    expect(isEnvelopeKey('')).toBe(false);
  });

  it('flags a key already saved for another recipient', () => {
    const list: BundleRecipient[] = [
      { id: 'buyer', key: 'K1' },
      { id: 'seller', key: 'K2' }
    ];
    expect(recipientConflict(list, 'buyer', 'K2')?.id).toBe('seller');
    expect(recipientConflict(list, 'buyer', 'K1')).toBeNull();
    expect(recipientConflict(list, 'notary', 'K3')).toBeNull();
  });

  it('names each file after its recipient', () => {
    expect(bundleFileName('Title', 'buyer')).toBe('title-bundle-for-buyer.json');
    expect(bundleFileName('Inspection', `other:${recipientSlug('Banque Épargne & Co')}`)).toBe('inspection-bundle-for-banque-epargne-co.json');
  });

  it('remembers keys in order and the last export per recipient', () => {
    let list = upsertRecipient([], { id: 'seller', key: 'K2' });
    list = upsertRecipient(list, { id: 'buyer', key: 'K1' });
    list = upsertRecipient(list, { id: 'seller', key: 'K2b' });
    expect(list).toEqual([
      { id: 'seller', key: 'K2b' },
      { id: 'buyer', key: 'K1' }
    ]);
    const ex = [
      { reportHash: 'h', recipient: 'buyer', at: 1 },
      { reportHash: 'h', recipient: 'buyer', at: 5 },
      { reportHash: 'other', recipient: 'seller', at: 9 }
    ];
    expect(lastExports(ex, 'h')).toEqual({ buyer: 5 });
  });

  it('the recipient name travels inside the sealed file', async () => {
    const seller = await generateRecipientKeyPair();
    const env = await sealTo({ format: 'EscrowDocumentBundleV1', sealedFor: 'Seller' }, seller.publicKey, 'Seller');
    expect(env.to).toBe('Seller');
    expect(await openEnvelope<{ sealedFor: string }>(env, seller)).toMatchObject({ sealedFor: 'Seller' });
  });
});
