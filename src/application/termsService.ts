/**
 * Private Terms Vault use-cases (FR-TERMS-01..05) and the KYC pre-checks (FR-KYC-01) that run before any proof.
 * Crypto is injected (TermsCrypto port) so these rules stay framework-free and unit-testable.
 */
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import {
  COMMITMENT_KEYS,
  LENDER_COMMITMENT_KEYS,
  norm,
  validateTerms,
  type AttestationBundle,
  type LenderPackage,
  type Opening,
  type TermsCommitments,
  type TermsPackage,
  type WirePrivateTerms
} from '@/domain/terms';

export interface TermsCrypto {
  newSalt(): string;
  commitmentsOf(t: WirePrivateTerms): TermsCommitments;
  amountCommitment(amount: bigint, salt: string): string;
  payoutCommitment(key: string, salt: string): string;
  priceCommitment(price: bigint, salt: string): string;
  lenderShareCommitment(share: bigint, salt: string): string;
  loanTermsCommitment(refundOnLoss: boolean, salt: string): string;
  /** Schnorr check of a CASP bundle against the given issuer public key. */
  verifyBundleSignature(b: AttestationBundle, publicKey: { x: string; y: string }): boolean;
  kycReference(b: AttestationBundle): string;
}

export interface TermsInput {
  /** Total price (whole token base units). */
  price: string;
  /** Buyer deposit (whole token base units). Defaults to the price (cash deal). The loan amount is price − deposit. */
  buyerDeposit?: string;
  buyerPayout: string;
  sellerPayout: string;
  /** Loan deals: the lender's shielded coin public key. Cash deals: omitted (a random placeholder is committed). */
  lenderPayout?: string;
  /** Loan refusal refund term (default true). */
  refundOnLoss?: boolean;
  /** The escrow's financing mode, when known: the shares are checked against it. */
  mode?: 'attested' | 'deposited';
  contractAddress?: string;
  escrowColor?: string;
  escrowTicker?: string;
}

/** FR-TERMS-01/02: the admin assembles the package from the price, the deposit split and the keys the parties submitted. */
export function createTermsPackage(crypto: TermsCrypto, input: TermsInput, now: number = Date.now()): TermsPackage {
  const price = input.price.trim();
  const deposit = (input.buyerDeposit ?? input.price).trim();
  if (!/^\d+$/.test(price) || !/^\d+$/.test(deposit)) throw new AppError('VALIDATION', 'Price and buyer deposit must be whole numbers in the token base unit.');
  const loan = BigInt(price) - BigInt(deposit);
  if (loan < 0n) throw new AppError('VALIDATION', 'The buyer deposit cannot exceed the price.');
  if (loan > 0n && !input.lenderPayout?.trim()) throw new AppError('VALIDATION', 'A loan needs the lender payout key.');
  const terms: WirePrivateTerms = {
    amount: deposit,
    amountSalt: crypto.newSalt(),
    buyerPayout: norm(input.buyerPayout),
    buyerSalt: crypto.newSalt(),
    sellerPayout: norm(input.sellerPayout),
    sellerSalt: crypto.newSalt(),
    price,
    priceSalt: crypto.newSalt(),
    lenderShare: loan.toString(),
    lenderShareSalt: crypto.newSalt(),
    // Cash deal: the contract still needs a lender payout commitment; a random key nobody holds is never paid.
    lenderPayout: loan > 0n ? norm(input.lenderPayout!) : crypto.newSalt(),
    lenderPayoutSalt: crypto.newSalt(),
    refundOnLoss: input.refundOnLoss ?? true,
    loanTermsSalt: crypto.newSalt()
  };
  const problem = validateTerms(terms, input.mode);
  if (problem) throw new AppError('VALIDATION', problem);
  return {
    format: 'EscrowTermsV2',
    contractAddress: input.contractAddress ? norm(input.contractAddress) : undefined,
    escrowColor: input.escrowColor ? norm(input.escrowColor) : undefined,
    escrowTicker: input.escrowTicker,
    terms,
    commitments: crypto.commitmentsOf(terms),
    createdAt: now
  };
}

export type CommitmentState = 'match' | 'mismatch' | 'unset';
export type CommitmentCheck = Record<keyof TermsCommitments, CommitmentState> & { ok: boolean };

const cmp = (local: string, onchain: string | null): CommitmentState => (onchain === null ? 'unset' : local === onchain ? 'match' : 'mismatch');

/** FR-TERMS-03: recompute all seven commitments from the local copy and compare them with the ledger. */
export function checkTermsAgainstLedger(crypto: TermsCrypto, pkg: TermsPackage, view: EscrowView): CommitmentCheck {
  const mine = crypto.commitmentsOf(pkg.terms);
  const r = Object.fromEntries(COMMITMENT_KEYS.map((k) => [k, cmp(mine[k], view.commitments[k])])) as Record<keyof TermsCommitments, CommitmentState>;
  return { ...r, ok: COMMITMENT_KEYS.every((k) => r[k] === 'match') };
}

/** v2: the lender package checked against the four commitments it opens. */
export function checkLenderPackage(crypto: TermsCrypto, pkg: LenderPackage, view: EscrowView): Record<(typeof LENDER_COMMITMENT_KEYS)[number], CommitmentState> & { ok: boolean } {
  const mine = {
    price: crypto.priceCommitment(BigInt(pkg.price), pkg.priceSalt),
    lenderShare: crypto.lenderShareCommitment(BigInt(pkg.lenderShare), pkg.lenderShareSalt),
    lenderPayout: crypto.payoutCommitment(pkg.lenderPayout, pkg.lenderPayoutSalt),
    loanTerms: crypto.loanTermsCommitment(pkg.refundOnLoss, pkg.loanTermsSalt)
  };
  const r = Object.fromEntries(LENDER_COMMITMENT_KEYS.map((k) => [k, cmp(mine[k], view.commitments[k])])) as Record<(typeof LENDER_COMMITMENT_KEYS)[number], CommitmentState>;
  return { ...r, ok: LENDER_COMMITMENT_KEYS.every((k) => r[k] === 'match') };
}

/** v2: the lender package cut from the full terms (sealed to the lender's envelope key by the admin). */
export function lenderPackageOf(pkg: TermsPackage, now: number = Date.now()): LenderPackage {
  const t = pkg.terms;
  if (BigInt(t.lenderShare) <= 0n) throw new AppError('VALIDATION', 'This escrow has no loan: there is no lender package.');
  return {
    format: 'EscrowLenderTermsV2',
    contractAddress: pkg.contractAddress,
    escrowColor: pkg.escrowColor,
    escrowTicker: pkg.escrowTicker,
    price: t.price,
    priceSalt: t.priceSalt,
    lenderShare: t.lenderShare,
    lenderShareSalt: t.lenderShareSalt,
    lenderPayout: t.lenderPayout,
    lenderPayoutSalt: t.lenderPayoutSalt,
    refundOnLoss: t.refundOnLoss,
    loanTermsSalt: t.loanTermsSalt,
    commitments: { price: pkg.commitments.price, lenderShare: pkg.commitments.lenderShare, lenderPayout: pkg.commitments.lenderPayout, loanTerms: pkg.commitments.loanTerms },
    createdAt: now
  };
}

export function assertTermsMatch(crypto: TermsCrypto, pkg: TermsPackage | undefined, view: EscrowView): void {
  if (!pkg) throw new AppError('MISSING_MATERIAL', 'TERMS_COMMITMENT_MISMATCH: no private terms package in this browser.');
  const c = checkTermsAgainstLedger(crypto, pkg, view);
  if (!c.ok) {
    const bad = COMMITMENT_KEYS.filter((k) => c[k] !== 'match');
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
