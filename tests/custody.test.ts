/** Custodian copy of the terms: envelope round trip to the custodian, checks against the ledger, backup merge. */
import { describe, expect, it } from 'vitest';
import { checkTermsAgainstLedger, selectiveOpening, verifyOpening } from '@/application/termsService';
import { mergeRecord, summarize, BACKUP_FORMAT } from '@/application/vaultBackup';
import { isTermsPackage } from '@/domain/terms';
import { generateRecipientKeyPair, openEnvelope, sealTo } from '@/infrastructure/crypto/aead';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { configuredEscrow, hex } from './helpers/fixtures';

describe('custodian copy', () => {
  it('opens only with the custodian key, matches the ledger and yields a verifiable price opening', async () => {
    const { sim, pkg } = await configuredEscrow();
    const custodian = await generateRecipientKeyPair();
    const other = await generateRecipientKeyPair();
    const env = await sealTo(pkg, custodian.publicKey, 'custodian');
    await expect(openEnvelope(env, other)).rejects.toThrow();
    const opened = await openEnvelope(env, custodian);
    expect(isTermsPackage(opened)).toBe(true);
    const view = sim.view();
    expect(checkTermsAgainstLedger(termsCrypto, opened as typeof pkg, view).ok).toBe(true);
    expect(verifyOpening(termsCrypto, selectiveOpening(opened as typeof pkg, 'amount'), view)).toEqual({ ok: true, detail: 'Price verified: 250000 EURe' });
    // Handing it back to a party: a fresh envelope only that party opens.
    const buyer = await generateRecipientKeyPair();
    expect(await openEnvelope(await sealTo(opened, buyer.publicKey, 'buyer'), buyer)).toEqual(opened);
  });

  it('is carried by vault backups and merged without loss', async () => {
    const { pkg } = await configuredEscrow();
    const custody = { terms: pkg, receivedAt: 1, fileName: 'terms-for-custodian.json', handedOut: [{ at: 2, to: 'buyer', kind: 'envelope' as const }] };
    expect(summarize({ format: BACKUP_FORMAT, createdAt: 'x', records: { [hex(1)]: { custody } } }).contracts[0].custody).toBe(true);

    const added = mergeRecord({}, { custody }, 'c');
    expect(added.record.custody).toEqual(custody);
    expect(added.added).toEqual(['c: custodian copy of the terms']);

    const merged = mergeRecord({ custody: { ...custody, handedOut: [{ at: 3, to: 'seller', kind: 'envelope' }] } }, { custody }, 'c');
    expect(merged.record.custody?.handedOut?.map((h) => h.to)).toEqual(['seller', 'buyer']);

    const changed = { ...custody, terms: { ...pkg, terms: { ...pkg.terms, amount: '1' } } };
    expect(mergeRecord({ custody }, { custody: changed }, 'c').conflicts).toEqual(['c: custodian copy differs (kept the current one)']);
  });
});
