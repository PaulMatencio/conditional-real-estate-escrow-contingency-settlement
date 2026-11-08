/**
 * Private Terms Vault use-cases (FR-TERMS-01..05) and the KYC pre-checks (FR-KYC-01) that run before any proof.
 * Crypto is injected (TermsCrypto port) so these rules stay framework-free and unit-testable.
 */
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { norm, validateTerms, type AttestationBundle, type Opening, type TermsCommitments, type TermsPackage, type WirePrivateTerms } from '@/domain/terms';

export interface TermsCrypto {
  newSalt(): string;
  commitmentsOf(t: WirePrivateTerms): TermsCommitments;
  amountCommitment(amount: bigint, salt: string): string;
  payoutCommitment(key: string, salt: string): string;
  /** Schnorr check of a CASP bundle against the given issuer public key. */
  verifyBundleSignature(b: AttestationBundle, publicKey: { x: string; y: string }): boolean;
  kycReference(b: AttestationBundle): string;
}

/** FR-TERMS-01/02: the admin assembles the package from the amount and the keys the parties submitted. */
export function createTermsPackage(
  crypto: TermsCrypto,
  input: { amount: string; buyerPayout: string; sellerPayout: string; contractAddress?: string; escrowColor?: string; escrowTicker?: string },
  now: number = Date.now()
): TermsPackage {
  const terms: WirePrivateTerms = {
    amount: input.amount.trim(),
    amountSalt: crypto.newSalt(),
    buyerPayout: norm(input.buyerPayout),
    buyerSalt: crypto.newSalt(),
    sellerPayout: norm(input.sellerPayout),
    sellerSalt: crypto.newSalt()
  };
  const problem = validateTerms(terms);
  if (problem) throw new AppError('VALIDATION', problem);
  return {
    format: 'EscrowTermsV1',
    contractAddress: input.contractAddress ? norm(input.contractAddress) : undefined,
    escrowColor: input.escrowColor ? norm(input.escrowColor) : undefined,
    escrowTicker: input.escrowTicker,
    terms,
    commitments: crypto.commitmentsOf(terms),
    createdAt: now
  };
}

export interface CommitmentCheck {
  amount: 'match' | 'mismatch' | 'unset';
  buyerPayout: 'match' | 'mismatch' | 'unset';
  sellerPayout: 'match' | 'mismatch' | 'unset';
  ok: boolean;
}

/** FR-TERMS-03: recompute all three commitments from the local copy and compare them with the ledger. */
export function checkTermsAgainstLedger(crypto: TermsCrypto, pkg: TermsPackage, view: EscrowView): CommitmentCheck {
  const mine = crypto.commitmentsOf(pkg.terms);
  const cmp = (local: string, onchain: string | null) => (onchain === null ? 'unset' : local === onchain ? 'match' : 'mismatch');
  const r = {
    amount: cmp(mine.amount, view.commitments.amount),
    buyerPayout: cmp(mine.buyerPayout, view.commitments.buyerPayout),
    sellerPayout: cmp(mine.sellerPayout, view.commitments.sellerPayout)
  } as const;
  return { ...r, ok: r.amount === 'match' && r.buyerPayout === 'match' && r.sellerPayout === 'match' };
}

export function assertTermsMatch(crypto: TermsCrypto, pkg: TermsPackage | undefined, view: EscrowView): void {
  if (!pkg) throw new AppError('MISSING_MATERIAL', 'TERMS_COMMITMENT_MISMATCH: no private terms package in this browser.');
  const c = checkTermsAgainstLedger(crypto, pkg, view);
  if (!c.ok) {
    const bad = (['amount', 'buyerPayout', 'sellerPayout'] as const).filter((k) => c[k] !== 'match');
    throw new AppError('TERMS_COMMITMENT_MISMATCH', `TERMS_COMMITMENT_MISMATCH: ${bad.join(', ')} ${bad.length > 1 ? 'do' : 'does'} not open the on-chain commitment.`);
  }
}

/** FR-TERMS-05: a single opening for a third party (notary, auditor) without the rest of the package. */
export function selectiveOpening(pkg: TermsPackage, kind: Opening['kind']): Opening {
  const base = { format: 'EscrowOpeningV1' as const, contractAddress: pkg.contractAddress };
  if (kind === 'amount') return { ...base, kind, amount: pkg.terms.amount, salt: pkg.terms.amountSalt, ticker: pkg.escrowTicker };
  return kind === 'buyerPayout' ? { ...base, kind, key: pkg.terms.buyerPayout, salt: pkg.terms.buyerSalt } : { ...base, kind, key: pkg.terms.sellerPayout, salt: pkg.terms.sellerSalt };
}

/** FR-NOTARY-02: verify an opening locally against the ledger commitment. */
export function verifyOpening(crypto: TermsCrypto, o: Opening, view: EscrowView): { ok: boolean; detail: string } {
  if (o.kind === 'amount') {
    const c = crypto.amountCommitment(BigInt(o.amount), o.salt);
    return c === view.commitments.amount ? { ok: true, detail: `Price verified: ${o.amount} ${view.escrowTicker}` } : { ok: false, detail: 'The amount opening does not match amountCommitment.' };
  }
  const onchain = o.kind === 'buyerPayout' ? view.commitments.buyerPayout : view.commitments.sellerPayout;
  const c = crypto.payoutCommitment(o.key, o.salt);
  return c === onchain ? { ok: true, detail: `${o.kind === 'buyerPayout' ? 'Buyer' : 'Seller'} payout key verified` } : { ok: false, detail: `The opening does not match ${o.kind}Commitment.` };
}

// ------------------------------------------------------------------------ KYC pre-check (FR-KYC-01)

export interface KycPrecheck {
  ok: boolean;
  problems: string[];
  warnings: string[];
  reference: string;
  validUntil: number;
}

/**
 * Mirrors verifyBuyerKyc / submitSellerKyc off-chain so a bad attestation is caught before proving:
 * whitelist, signature, subject, committed wallet, expiry, policy and revocation.
 */
export function precheckAttestation(
  crypto: TermsCrypto,
  b: AttestationBundle,
  view: EscrowView,
  role: 'buyer' | 'seller',
  terms: WirePrivateTerms | undefined,
  nowSec: number
): KycPrecheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const issuer = view.kycIssuers.find((i) => i.issuerId === norm(b.issuerId));
  if (!issuer) problems.push('ERROR_NOT_WHITELISTED: issuer is not a trusted CASP of this escrow');
  else if (!crypto.verifyBundleSignature(b, issuer.publicKey)) problems.push('ERROR_NOT_WHITELISTED: invalid KYC attestation signature');
  const subject = role === 'buyer' ? view.roles.buyer : view.roles.seller;
  if (norm(b.attestation.subject) !== subject) problems.push('ERROR_NOT_WHITELISTED: attestation is for another subject');
  const committed = role === 'buyer' ? terms?.buyerPayout : terms?.sellerPayout;
  if (!committed) warnings.push('Cannot compare the attested wallet: no private terms in this browser.');
  else if (norm(b.attestation.wallet) !== norm(committed)) problems.push(`ERROR_NOT_WHITELISTED: wallet is not the verified ${role} wallet (attested key ≠ committed payout key)`);
  if (b.attestation.validUntil <= nowSec) problems.push('ERROR_KYC_EXPIRED');
  if (b.attestation.kycLevel < view.kycPolicy.minKycLevel) problems.push('ERROR_KYC_LEVEL_INSUFFICIENT');
  if (b.attestation.amlRiskScore > view.kycPolicy.maxAmlRiskScore) problems.push('ERROR_AML_RISK_TOO_HIGH');
  const reference = crypto.kycReference(b);
  if (view.revokedKycRefs.includes(reference)) problems.push('ERROR_KYC_REVOKED');
  if (b.reference && norm(b.reference) !== reference) warnings.push('The bundle reference differs from kycReference(attestation).');
  if (b.attestation.validUntil - nowSec < 24 * 3600 && b.attestation.validUntil > nowSec) warnings.push('The attestation expires within 24 hours.');
  return { ok: problems.length === 0, problems, warnings, reference, validUntil: b.attestation.validUntil };
}
