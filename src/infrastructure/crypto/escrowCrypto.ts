/**
 * Off-chain mirrors of the contract's pure circuits (commitments, vault/payout nonces, KYC references) and the
 * document hash used for contingency reports. Everything goes through the compiled `pureCircuits`, so the
 * dApp, the notary portal and the chain can never compute different values.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import type { AttestationBundle, LenderPackage, TermsCommitments, WireAttestation, WirePrivateTerms } from '@/domain/terms';
import { pureCircuits, type KycAttestation, type LenderTerms, type PrivateTerms, type SchnorrSignature } from '../contract/module';
import { randomBytes } from './identity';
import { insecureContextMessage } from './aead';

export const newSalt = (): string => bytesToHex(randomBytes(32));

export function termsFromWire(t: WirePrivateTerms): PrivateTerms {
  return {
    amount: BigInt(t.amount.trim()),
    amountSalt: hex32ToBytes(t.amountSalt, 'amount salt'),
    buyerPayout: { bytes: hex32ToBytes(t.buyerPayout, 'buyer payout key') },
    buyerSalt: hex32ToBytes(t.buyerSalt, 'buyer salt'),
    sellerPayout: { bytes: hex32ToBytes(t.sellerPayout, 'seller payout key') },
    sellerSalt: hex32ToBytes(t.sellerSalt, 'seller salt'),
    price: BigInt(t.price.trim()),
    priceSalt: hex32ToBytes(t.priceSalt, 'price salt'),
    lenderShare: BigInt(t.lenderShare.trim()),
    lenderShareSalt: hex32ToBytes(t.lenderShareSalt, 'loan amount salt'),
    lenderPayout: { bytes: hex32ToBytes(t.lenderPayout, 'lender payout key') },
    lenderPayoutSalt: hex32ToBytes(t.lenderPayoutSalt, 'lender salt'),
    refundOnLoss: t.refundOnLoss,
    loanTermsSalt: hex32ToBytes(t.loanTermsSalt, 'loan terms salt'),
    penaltyRate: BigInt(t.penaltyRate.trim()),
    penalty: BigInt(t.penalty.trim()),
    coolingOffSalt: hex32ToBytes(t.coolingOffSalt, 'cooling-off salt')
  };
}

/** v2: the `lenderTerms` witness, from the lender package (or from the full terms, for a party refunding the lender). */
export function lenderTermsFromWire(t: Pick<LenderPackage, 'lenderShare' | 'lenderShareSalt' | 'lenderPayout' | 'lenderPayoutSalt' | 'refundOnLoss' | 'loanTermsSalt'>): LenderTerms {
  return {
    lenderShare: BigInt(t.lenderShare.trim()),
    lenderShareSalt: hex32ToBytes(t.lenderShareSalt, 'loan amount salt'),
    lenderPayout: { bytes: hex32ToBytes(t.lenderPayout, 'lender payout key') },
    lenderPayoutSalt: hex32ToBytes(t.lenderPayoutSalt, 'lender salt'),
    refundOnLoss: t.refundOnLoss,
    loanTermsSalt: hex32ToBytes(t.loanTermsSalt, 'loan terms salt')
  };
}

export const amountCommitment = (amount: bigint, saltHex: string): string => bytesToHex(pureCircuits.amountCommitmentOf(amount, hex32ToBytes(saltHex, 'salt')));
export const payoutCommitment = (keyHex: string, saltHex: string): string =>
  bytesToHex(pureCircuits.payoutCommitmentOf({ bytes: hex32ToBytes(keyHex, 'payout key') }, hex32ToBytes(saltHex, 'salt')));
export const priceCommitment = (price: bigint, saltHex: string): string => bytesToHex(pureCircuits.priceCommitmentOf(price, hex32ToBytes(saltHex, 'salt')));
export const lenderShareCommitment = (share: bigint, saltHex: string): string => bytesToHex(pureCircuits.lenderShareCommitmentOf(share, hex32ToBytes(saltHex, 'salt')));
export const loanTermsCommitment = (refundOnLoss: boolean, saltHex: string): string => bytesToHex(pureCircuits.loanTermsCommitmentOf(refundOnLoss, hex32ToBytes(saltHex, 'salt')));
export const coolingOffCommitment = (rate: bigint, penalty: bigint, saltHex: string): string =>
  bytesToHex(pureCircuits.coolingOffCommitmentOf(rate, penalty, hex32ToBytes(saltHex, 'salt')));

/** FR-TERMS-01: the eight salted commitments (`configure` takes three, `configureFinancing` the other five). */
export function commitmentsOf(t: WirePrivateTerms): TermsCommitments {
  return {
    amount: amountCommitment(BigInt(t.amount.trim()), t.amountSalt),
    buyerPayout: payoutCommitment(t.buyerPayout, t.buyerSalt),
    sellerPayout: payoutCommitment(t.sellerPayout, t.sellerSalt),
    price: priceCommitment(BigInt(t.price.trim()), t.priceSalt),
    lenderShare: lenderShareCommitment(BigInt(t.lenderShare.trim()), t.lenderShareSalt),
    lenderPayout: payoutCommitment(t.lenderPayout, t.lenderPayoutSalt),
    loanTerms: loanTermsCommitment(t.refundOnLoss, t.loanTermsSalt),
    coolingOff: coolingOffCommitment(BigInt(t.penaltyRate.trim()), BigInt(t.penalty.trim()), t.coolingOffSalt)
  };
}

/** The 32 bytes `kernel.self().bytes` holds for a deployed contract address (64 hex). */
export const contractSelfBytes = (contractAddress: string): Uint8Array => new Uint8Array(rt.encodeContractAddress(contractAddress.trim().toLowerCase().replace(/^0x/, '')));

/** FR-FUND-01: the deterministic vault coin `{vaultNonceOf(self, buyerSalt, sellerSalt), escrowColor, amount}`. */
export function vaultCoinOf(contractAddress: string, escrowColorHex: string, t: WirePrivateTerms): { nonce: Uint8Array; color: Uint8Array; value: bigint } {
  return {
    nonce: pureCircuits.vaultNonceOf(contractSelfBytes(contractAddress), hex32ToBytes(t.buyerSalt), hex32ToBytes(t.sellerSalt)),
    color: hex32ToBytes(escrowColorHex, 'escrow color'),
    value: BigInt(t.amount)
  };
}

/** v2: the lender's loan coin `{lenderNonceOf(self, shareSalt, payoutSalt), escrowColor, lenderShare}`. */
export function loanCoinOf(contractAddress: string, escrowColorHex: string, t: Pick<WirePrivateTerms, 'lenderShare' | 'lenderShareSalt' | 'lenderPayoutSalt'>) {
  return {
    nonce: pureCircuits.lenderNonceOf(contractSelfBytes(contractAddress), hex32ToBytes(t.lenderShareSalt), hex32ToBytes(t.lenderPayoutSalt)),
    color: hex32ToBytes(escrowColorHex, 'escrow color'),
    value: BigInt(t.lenderShare)
  };
}

/** v2: the buyer's top-up coin `{topUpNonceOf(self, buyerSalt, sellerSalt), escrowColor, lenderShare}`. */
export function topUpCoinOf(contractAddress: string, escrowColorHex: string, t: WirePrivateTerms) {
  return {
    nonce: pureCircuits.topUpNonceOf(contractSelfBytes(contractAddress), hex32ToBytes(t.buyerSalt), hex32ToBytes(t.sellerSalt)),
    color: hex32ToBytes(escrowColorHex, 'escrow color'),
    value: BigInt(t.lenderShare)
  };
}

/** v2: the coin a payout of any held coin (vault, loan or top-up) creates for its recipient. */
export function payoutOfCoin(coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }): { nonce: string; color: string; value: string } {
  return { nonce: bytesToHex(pureCircuits.payoutNonceOf(coin.nonce)), color: bytesToHex(coin.color), value: coin.value.toString() };
}

/**
 * Cooling-off withdrawal: refundWithdrawal pays deposit − penalty to the buyer (a coin {payoutNonceOf(vault nonce),
 * color, deposit − penalty}) and keeps the penalty as the change coin {changeNonceOf(vault nonce), color, penalty},
 * which claimPenalty later pays to the seller ({payoutNonceOf(change nonce), color, penalty}).
 */
export function withdrawalCoinsOf(contractAddress: string, escrowColorHex: string, t: WirePrivateTerms) {
  const v = vaultCoinOf(contractAddress, escrowColorHex, t);
  const penalty = BigInt(t.penalty);
  const kept = { nonce: pureCircuits.changeNonceOf(v.nonce), color: v.color, value: penalty };
  return {
    /** What the buyer imports after refundWithdrawal. */
    buyerRefund: { ...payoutOfCoin(v), value: (v.value - penalty).toString() },
    /** The change coin the contract holds until claimPenalty (none when the penalty is 0). */
    penaltyCoin: penalty > 0n ? kept : null,
    /** What the seller imports after claimPenalty. */
    sellerPenalty: penalty > 0n ? payoutOfCoin(kept) : null
  };
}

/** FR-SETTLE-03: the coin a payout creates for its recipient. */
export function payoutCoinOf(contractAddress: string, escrowColorHex: string, t: WirePrivateTerms): { nonce: string; color: string; value: string } {
  const v = vaultCoinOf(contractAddress, escrowColorHex, t);
  return { nonce: bytesToHex(pureCircuits.payoutNonceOf(v.nonce)), color: escrowColorHex.toLowerCase(), value: v.value.toString() };
}

// ---------------------------------------------------------------- KYC wire ⇄ contract values

export function attestationFromWire(w: WireAttestation): KycAttestation {
  return {
    subject: hex32ToBytes(w.subject, 'attestation subject'),
    wallet: { bytes: hex32ToBytes(w.wallet, 'attestation wallet') },
    kycLevel: BigInt(w.kycLevel),
    amlRiskScore: BigInt(w.amlRiskScore),
    validUntil: BigInt(w.validUntil),
    travelRuleRef: hex32ToBytes(w.travelRuleRef, 'travel rule ref'),
    salt: hex32ToBytes(w.salt, 'attestation salt')
  };
}

export const pointFromWire = (p: { x: string; y: string }): rt.JubjubPoint => ({ x: BigInt(p.x), y: BigInt(p.y) });
export const sigFromWire = (s: AttestationBundle['signature']): SchnorrSignature => ({ announcement: pointFromWire(s.announcement), response: BigInt(s.response) });

/** The value the `kycAttestation` witness returns: [attestation, signature, issuerId]. */
export function bundleToWitness(b: AttestationBundle): [KycAttestation, SchnorrSignature, Uint8Array] {
  return [attestationFromWire(b.attestation), sigFromWire(b.signature), hex32ToBytes(b.issuerId, 'issuer id')];
}

export const kycReferenceHex = (w: WireAttestation): string => bytesToHex(pureCircuits.kycReference(attestationFromWire(w)));

// ---------------------------------------------------------------- Schnorr (mirror of verifySchnorr)

export const TWO_248 = 1n << 248n;
const VEC5_FIELD = new rt.CompactTypeVector(5, rt.CompactTypeField);

function challenge(announcement: rt.JubjubPoint, publicKey: rt.JubjubPoint, msg: bigint): bigint {
  return (
    rt.transientHash(VEC5_FIELD, [rt.jubjubPointX(announcement), rt.jubjubPointY(announcement), rt.jubjubPointX(publicKey), rt.jubjubPointY(publicKey), msg]) % TWO_248
  );
}

/** Off-chain check of a CASP Schnorr signature over any contract message (pre-flight, FR-KYC-01). */
export function verifySchnorr(publicKey: rt.JubjubPoint, msg: bigint, sig: SchnorrSignature): boolean {
  const c = challenge(sig.announcement, publicKey, msg);
  const lhs = rt.ecMulGenerator(sig.response);
  const rhs = rt.ecAdd(sig.announcement, rt.ecMul(publicKey, c));
  return rt.jubjubPointX(lhs) === rt.jubjubPointX(rhs) && rt.jubjubPointY(lhs) === rt.jubjubPointY(rhs);
}

export const verifyKycSignature = (publicKey: rt.JubjubPoint, att: KycAttestation, sig: SchnorrSignature): boolean => verifySchnorr(publicKey, pureCircuits.kycMessage(att), sig);
export const verifyAttestationRevocation = (publicKey: rt.JubjubPoint, refHex: string, sig: SchnorrSignature): boolean =>
  verifySchnorr(publicKey, pureCircuits.kycRevocationMessage(hex32ToBytes(refHex)), sig);
export const verifyIssuerRevocation = (publicKey: rt.JubjubPoint, issuerIdHex: string, sig: SchnorrSignature): boolean =>
  verifySchnorr(publicKey, pureCircuits.issuerRevocationMessage(hex32ToBytes(issuerIdHex)), sig);

// ---------------------------------------------------------------- documents (FR-ATTEST-02)

const DOC_DOMAIN = (() => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode('re-escrow:document:v1'));
  return b;
})();
const VEC3_BYTES32 = new rt.CompactTypeVector(3, new rt.CompactTypeBytes(32));

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const insecure = insecureContextMessage();
  if (insecure) throw new Error(insecure);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * Salted document commitment: persistentHash([pad(32,"re-escrow:document:v1"), sha256(document), salt]).
 * The document is first digested with SHA-256 (arbitrary length), then bound with a fresh 32-byte salt so a
 * guessable document (e.g. a template letter) cannot be confirmed from the on-chain hash.
 */
export async function documentCommitment(document: Uint8Array, saltHex: string): Promise<string> {
  const digest = await sha256(document);
  return bytesToHex(rt.persistentHash(VEC3_BYTES32, [DOC_DOMAIN, digest, hex32ToBytes(saltHex, 'document salt')]));
}
