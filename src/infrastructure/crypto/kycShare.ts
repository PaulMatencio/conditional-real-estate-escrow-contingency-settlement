/**
 * Sharing a party's CASP KYC attestation with the notary. The attestation is personal data (KYC level, AML risk score,
 * bound to the party's role id and payout key), so it never travels as a plain file from the dApp: it is sealed to
 * the notary's envelope key (custodian card), or protected with a passphrase given separately. The notary portal
 * opens either form, and still accepts a plain file a real CASP may have sent.
 */
import { isAttestationBundle, type AttestationBundle } from '@/domain/terms';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase, sealTo, sealWithPassphrase, type Envelope, type RecipientKeyPair, type SealedJson } from './aead';

export type KycParty = 'buyer' | 'seller';

/** `kyc-seller-for-notary.json` (sealed to the notary) or `kyc-seller.json` (passphrase). */
export const kycFileName = (party: KycParty, forNotary: boolean): string => `kyc-${party}${forNotary ? '-for-notary' : ''}.json`;

/** Minimum passphrase length for a passphrase-protected attestation (as for report bundles). */
export const KYC_PASSPHRASE_MIN = 8;

export const sealKycForNotary = (bundle: AttestationBundle, notaryKey: string): Promise<Envelope> => sealTo(bundle, notaryKey.trim(), 'notary');

export async function sealKycWithPassphrase(bundle: AttestationBundle, passphrase: string): Promise<SealedJson> {
  if (passphrase.length < KYC_PASSPHRASE_MIN) throw new KycFileError('short-pass');
  return sealWithPassphrase(bundle, passphrase);
}

export type KycFileProblem = 'bad-file' | 'not-for-me' | 'unlock' | 'need-pass' | 'wrong-pass' | 'short-pass';

/** Why a KYC file could not be opened; `problem` is translated by the UI. */
export class KycFileError extends Error {
  constructor(readonly problem: KycFileProblem) {
    super(`KYC file: ${problem}`);
    this.name = 'KycFileError';
  }
}

/** Opens a plain, envelope-sealed or passphrase-protected attestation file. */
export async function openKycFile(raw: unknown, identities: readonly RecipientKeyPair[], passphrase?: string): Promise<AttestationBundle> {
  let b: unknown = raw;
  if (isEnvelope(raw)) {
    const me = identities.find((k) => k.publicKey === raw.recipient);
    if (!me) throw new KycFileError(identities.length ? 'not-for-me' : 'unlock');
    b = await openEnvelope(raw, me);
  } else if (isSealedJson(raw)) {
    if (!passphrase) throw new KycFileError('need-pass');
    try {
      b = await openWithPassphrase(raw, passphrase);
    } catch {
      throw new KycFileError('wrong-pass');
    }
  }
  if (!isAttestationBundle(b)) throw new KycFileError('bad-file');
  return b;
}
