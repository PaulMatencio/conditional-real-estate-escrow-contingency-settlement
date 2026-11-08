import { describe, expect, it } from 'vitest';
import { checkTermsAgainstLedger, createTermsPackage, selectiveOpening, verifyOpening } from '@/application/termsService';
import { buildCertificate } from '@/application/notaryService';
import { generateRecipientKeyPair, openEnvelope, openWithPassphrase, sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { documentCommitment, payoutCoinOf, vaultCoinOf } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { EncryptedVault } from '@/infrastructure/storage/encryptedVault';
import { MemoryStore } from '@/infrastructure/storage/kv';
import { pureCircuits } from '@/infrastructure/contract/module';
import { bytesToHex } from '@/domain/hex';
import { BUYER_KEY, SELLER_KEY, configuredEscrow, hex } from './helpers/fixtures';

describe('terms package (FR-TERMS-01/03/05)', () => {
  it('uses fresh salts and the contract commitments', () => {
    const a = createTermsPackage(termsCrypto, { amount: '100', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY });
    const b = createTermsPackage(termsCrypto, { amount: '100', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY });
    expect(a.terms.amountSalt).not.toBe(b.terms.amountSalt);
    expect(a.commitments.amount).toBe(bytesToHex(pureCircuits.amountCommitmentOf(100n, Uint8Array.from(Buffer.from(a.terms.amountSalt, 'hex')))));
  });
  it('rejects bad inputs', () => {
    expect(() => createTermsPackage(termsCrypto, { amount: '0', buyerPayout: BUYER_KEY, sellerPayout: SELLER_KEY })).toThrow(/positive/);
    expect(() => createTermsPackage(termsCrypto, { amount: '5', buyerPayout: BUYER_KEY, sellerPayout: BUYER_KEY })).toThrow(/differ/);
  });
  it('matches the ledger and verifies single openings without revealing the rest', () => {
    const { sim, pkg } = configuredEscrow();
    const v = sim.view();
    expect(checkTermsAgainstLedger(termsCrypto, pkg, v)).toMatchObject({ ok: true, amount: 'match' });
    const amount = selectiveOpening(pkg, 'amount');
    expect(Object.keys(amount)).not.toContain('buyerSalt');
    expect(verifyOpening(termsCrypto, amount, v)).toEqual({ ok: true, detail: 'Price verified: 250000 EURe' });
    expect(verifyOpening(termsCrypto, { ...amount, amount: '250001' } as typeof amount, v).ok).toBe(false);
    expect(verifyOpening(termsCrypto, selectiveOpening(pkg, 'sellerPayout'), v).ok).toBe(true);
    const cert = buildCertificate(termsCrypto, { ...v, status: 'Funded' }, { network: 'preview', openings: [amount] });
    expect(cert.lockedFunds.locked).toBe(true);
    expect(JSON.stringify(cert)).not.toContain(pkg.terms.amountSalt);
  });
  it('builds the vault and payout coins deterministically', () => {
    const { sim, pkg } = configuredEscrow();
    const a = vaultCoinOf(sim.contractAddress, pkg.escrowColor!, pkg.terms);
    expect(a.value).toBe(250000n);
    expect(payoutCoinOf(sim.contractAddress, pkg.escrowColor!, pkg.terms).nonce).toBe(bytesToHex(pureCircuits.payoutNonceOf(a.nonce)));
  });
});

describe('document commitment (FR-ATTEST-02)', () => {
  it('is salted and non-zero', async () => {
    const doc = new TextEncoder().encode('inspection report');
    const h1 = await documentCommitment(doc, hex(1));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await documentCommitment(doc, hex(2))).not.toBe(h1);
    expect(await documentCommitment(doc, hex(1))).toBe(h1);
  });
});

describe('encryption (FR-TERMS-04, NFR-06)', () => {
  it('passphrase backup round-trips and rejects a wrong passphrase', async () => {
    const s = await sealWithPassphrase({ a: 1 }, 'correct horse');
    expect(await openWithPassphrase(s, 'correct horse')).toEqual({ a: 1 });
    await expect(openWithPassphrase(s, 'wrong pass')).rejects.toThrow(/Wrong passphrase/);
  });
  it('X25519 envelopes open only for their recipient', async () => {
    const seller = await generateRecipientKeyPair();
    const other = await generateRecipientKeyPair();
    const env = await sealTo({ secret: 'terms' }, seller.publicKey, 'seller');
    expect(await openEnvelope(env, seller)).toEqual({ secret: 'terms' });
    await expect(openEnvelope(env, other)).rejects.toThrow(/another key/);
    await expect(openEnvelope({ ...env, ct: env.ct.slice(0, -4) + 'AAAA' }, seller)).rejects.toThrow(/tampered/);
  });
  it('vault encrypts records at rest and erases locally', async () => {
    const store = new MemoryStore();
    const vault = new EncryptedVault(store);
    await vault.unlock('passphrase-1');
    await vault.save('abc', { roleKeys: { buyer: hex(1) } });
    expect(await store.get('vault:rec:abc')).not.toContain(hex(1));
    vault.lock();
    await expect(vault.load('abc')).rejects.toThrow(/Unlock/);
    await expect(vault.unlock('passphrase-2')).rejects.toThrow(/Wrong vault passphrase/);
    await vault.unlock('passphrase-1');
    expect(await vault.load('abc')).toEqual({ roleKeys: { buyer: hex(1) } });
    await vault.erase('abc');
    expect(await vault.contracts()).toEqual([]);
  });
});
