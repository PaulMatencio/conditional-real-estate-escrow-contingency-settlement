/**
 * CASP / KYC-provider signing helper for the escrow's KYC attestation.
 *
 * The CASP verifies the buyer's identity documents and wallet ownership OFF-chain, then signs a
 * KycAttestation with its Jubjub key. The buyer's wallet keeps { attestation, signature, issuerId }
 * privately and supplies them to depositToEscrow() through the `kycAttestation` witness.
 *
 * Scheme (must match `verifySchnorr` in the contract):
 *   msg = kycMessage(att)                                   (exported pure circuit)
 *   c   = transientHash([Rx, Ry, pkx, pky, msg]) mod 2^248  (challenge reduced below 2^248)
 *   R   = k·G,  s = k + c·sk  (mod Jubjub order)
 *
 * Usage:
 *   import { pureCircuits } from '../managed/escrow/contract/index.js';
 *   const casp = createCaspSigner(generateIssuerSecret(), pureCircuits);
 *   // register casp.publicKey with addKycIssuer(issuerId, casp.publicKey) during initialization
 *   const att = { subject, wallet, kycLevel: 2n, amlRiskScore: 10n, validUntil, salt: newSalt() };
 *   const signature = casp.sign(att);
 *   // revocations (anyone may submit them on-chain):
 *   casp.revokeAttestation(pureCircuits.kycReference(att))  -> revokeKycAttestation(issuerId, ref, sig)
 *   casp.revokeIssuer(issuerId)                               -> revokeKycIssuer(issuerId, sig)
 *
 * Keep the issuer secret in an HSM/KMS in production. Never reuse a nonce: two signatures with the
 * same nonce reveal the secret key. sign() draws a fresh random nonce unless one is passed (tests only).
 */
import { randomBytes } from 'node:crypto';
import * as rt from '@midnight-ntwrk/compact-runtime';

/** Order of the Jubjub prime-order subgroup (scalar field). */
export const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
export const TWO_248 = 1n << 248n;

const VEC5_FIELD = new rt.CompactTypeVector(5, rt.CompactTypeField);
const mod = (a, m = JUBJUB_ORDER) => ((a % m) + m) % m;
const bytesToBigint = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));

/** Uniform-enough random scalar in [1, order-1] (512 random bits reduced; bias is negligible). */
export function randomScalar() {
  return mod(bytesToBigint(randomBytes(64)), JUBJUB_ORDER - 1n) + 1n;
}
export const generateIssuerSecret = randomScalar;

/** Random 32-byte salt for KycAttestation.salt (keeps the on-chain buyerKycRef hiding). */
export const newSalt = () => new Uint8Array(randomBytes(32));

export const issuerPublicKey = (secret) => rt.ecMulGenerator(mod(secret));

/** Full (unreduced) Fiat–Shamir challenge, exactly as the contract computes `cFull`. */
export function challengeFull(announcement, publicKey, msg) {
  return rt.transientHash(VEC5_FIELD, [
    rt.jubjubPointX(announcement), rt.jubjubPointY(announcement),
    rt.jubjubPointX(publicKey), rt.jubjubPointY(publicKey),
    msg,
  ]);
}

/**
 * Witness implementation for `schnorrReduction(c)`: splits c into [q, r] with c = q·2^248 + r.
 * Use it in the buyer dApp's witnesses object:
 *   schnorrReduction: ({ privateState }, c) => [privateState, schnorrReduction(c)]
 */
export const schnorrReduction = (cFull) => [cFull / TWO_248, cFull % TWO_248];

/**
 * @param secret   issuer secret scalar (bigint)
 * @param circuits the contract's `pureCircuits`
 *                 (kycMessage, kycRevocationMessage, issuerRevocationMessage)
 */
export function createCaspSigner(secret, circuits) {
  const sk = mod(secret);
  if (sk === 0n) throw new Error('issuer secret must be non-zero');
  const publicKey = issuerPublicKey(sk);
  return {
    publicKey,
    /** Signs any contract message (a Field); returns the contract's SchnorrSignature struct. */
    signMessage(msg, nonce = randomScalar()) {
      const k = mod(nonce);
      if (k === 0n) throw new Error('nonce must be non-zero');
      const announcement = rt.ecMulGenerator(k);
      const c = challengeFull(announcement, publicKey, msg) % TWO_248;
      return { announcement, response: mod(k + c * sk) };
    },
    /** Signs a KycAttestation. */
    sign(attestation, nonce) {
      return this.signMessage(circuits.kycMessage(attestation), nonce);
    },
    /** Signs the revocation of one attestation, identified by kycReference(att). */
    revokeAttestation(ref, nonce) {
      return this.signMessage(circuits.kycRevocationMessage(ref), nonce);
    },
    /** Signs the withdrawal of this CASP's own key from the escrow's whitelist. */
    revokeIssuer(issuerId, nonce) {
      return this.signMessage(circuits.issuerRevocationMessage(issuerId), nonce);
    },
  };
}

/** Off-chain mirror of the contract's verifySchnorr (for CASP self-checks and dApp pre-flight). */
export function verifyKycSignature(publicKey, attestation, signature, circuits) {
  const { announcement, response } = signature;
  const c = challengeFull(announcement, publicKey, circuits.kycMessage(attestation)) % TWO_248;
  const lhs = rt.ecMulGenerator(response);
  const rhs = rt.ecAdd(announcement, rt.ecMul(publicKey, c));
  return rt.jubjubPointX(lhs) === rt.jubjubPointX(rhs) && rt.jubjubPointY(lhs) === rt.jubjubPointY(rhs);
}
