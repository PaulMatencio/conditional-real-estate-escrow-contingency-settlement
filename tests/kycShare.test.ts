/** Sharing a party's KYC attestation with the notary: sealed to its envelope key, or with a passphrase. */
import { describe, expect, it } from 'vitest';
import type { AttestationBundle } from '@/domain/terms';
import { generateRecipientKeyPair } from '@/infrastructure/crypto/aead';
import { KycFileError, kycFileName, openKycFile, sealKycForNotary, sealKycWithPassphrase } from '@/infrastructure/crypto/kycShare';
import { BUYER_KEY, K, makeCasp, rid } from './helpers/fixtures';

const bundle = (): AttestationBundle => makeCasp().bundle(rid(K.buyer), BUYER_KEY) as AttestationBundle;
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof KycFileError ? e.problem : (e as Error).message;
  }
};

describe('KYC attestation for the notary', () => {
  it('names the files after the party and the recipient', () => {
    expect(kycFileName('seller', true)).toBe('kyc-seller-for-notary.json');
    expect(kycFileName('buyer', false)).toBe('kyc-buyer.json');
  });

  it('sealed to the notary: only the notary’s vault opens it', async () => {
    const notary = await generateRecipientKeyPair();
    const other = await generateRecipientKeyPair();
    const b = bundle();
    const sealed = await sealKycForNotary(b, notary.publicKey);
    expect(JSON.stringify(sealed)).not.toContain(b.reference);
    expect(await openKycFile(sealed, [other, notary])).toEqual(b);
    expect(await problem(openKycFile(sealed, [other]))).toBe('not-for-me');
    expect(await problem(openKycFile(sealed, []))).toBe('unlock');
  });

  it('with a passphrase: opens with it, refuses a wrong or missing one', async () => {
    const b = bundle();
    const sealed = await sealKycWithPassphrase(b, 'correct horse');
    expect(await openKycFile(sealed, [], 'correct horse')).toEqual(b);
    expect(await problem(openKycFile(sealed, []))).toBe('need-pass');
    expect(await problem(openKycFile(sealed, [], 'wrong passphrase'))).toBe('wrong-pass');
    expect(await problem(sealKycWithPassphrase(b, 'short'))).toBe('short-pass');
  });

  it('a plain file from a real CASP still loads; anything else is refused', async () => {
    const b = bundle();
    expect(await openKycFile(b, [])).toEqual(b);
    expect(await problem(openKycFile({ format: 'something else' }, []))).toBe('bad-file');
  });
});
