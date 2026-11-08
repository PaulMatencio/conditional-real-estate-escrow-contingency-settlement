import type { TermsCrypto } from '@/application/termsService';
import { amountCommitment, attestationFromWire, commitmentsOf, kycReferenceHex, newSalt, payoutCommitment, pointFromWire, sigFromWire, verifyKycSignature } from './escrowCrypto';

/** TermsCrypto port backed by the compiled contract's pure circuits. */
export const termsCrypto: TermsCrypto = {
  newSalt,
  commitmentsOf,
  amountCommitment,
  payoutCommitment,
  verifyBundleSignature: (b, pk) => {
    try {
      return verifyKycSignature(pointFromWire(pk), attestationFromWire(b.attestation), sigFromWire(b.signature));
    } catch {
      return false;
    }
  },
  kycReference: (b) => kycReferenceHex(b.attestation)
};
