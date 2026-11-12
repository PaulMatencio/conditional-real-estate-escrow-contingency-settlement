import type { TermsCrypto } from '@/application/termsService';
import { amountCommitment, attestationFromWire, commitmentsOf, kycReferenceHex, lenderShareCommitment, loanTermsCommitment, newSalt, payoutCommitment, pointFromWire, priceCommitment, sigFromWire, verifyKycSignature } from './escrowCrypto';

/** TermsCrypto port backed by the compiled contract's pure circuits. */
export const termsCrypto: TermsCrypto = {
  newSalt,
  commitmentsOf,
  amountCommitment,
  payoutCommitment,
  priceCommitment,
  lenderShareCommitment,
  loanTermsCommitment,
  verifyBundleSignature: (b, pk) => {
    try {
      return verifyKycSignature(pointFromWire(pk), attestationFromWire(b.attestation), sigFromWire(b.signature));
    } catch {
      return false;
    }
  },
  kycReference: (b) => kycReferenceHex(b.attestation)
};
