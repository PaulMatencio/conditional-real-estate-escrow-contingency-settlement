/**
 * Private terms package (FR-TERMS) and CASP attestation bundle (FR-KYC) in their JSON wire forms.
 * Bytes are 64-hex, amounts decimal strings, so packages survive JSON and can be encrypted and shared.
 * NFR-07: none of these values may ever go into a URL, a log line or a server request.
 */
import { isHex32 } from './hex';

/**
 * Contract v2 private terms. `amount` is the BUYER SHARE (the buyer's own deposit); `price` = amount + lenderShare.
 * A cash deal has lenderShare "0" (its lender payout key is a random placeholder that is never paid).
 */
export interface WirePrivateTerms {
  /** Buyer share: integer in the token's base unit (decimal string, < 2^128). */
  amount: string;
  amountSalt: string;
  /** Buyer's shielded coin public key (64 hex). */
  buyerPayout: string;
  buyerSalt: string;
  sellerPayout: string;
  sellerSalt: string;
  /** Total price (decimal string) = amount + lenderShare. */
  price: string;
  priceSalt: string;
  /** Loan amount (decimal string), "0" in a cash deal. */
  lenderShare: string;
  lenderShareSalt: string;
  /** Lender's shielded coin public key (64 hex): the loan is repaid here on any unwind. */
  lenderPayout: string;
  lenderPayoutSalt: string;
  /** Loan refusal refund term: a lost loan opens a top-up window, then refunds the buyer. */
  refundOnLoss: boolean;
  loanTermsSalt: string;
}

export interface TermsCommitments {
  amount: string;
  buyerPayout: string;
  sellerPayout: string;
  price: string;
  lenderShare: string;
  lenderPayout: string;
  loanTerms: string;
}

/** The seven commitment names, in display order. */
export const COMMITMENT_KEYS = ['price', 'amount', 'lenderShare', 'buyerPayout', 'sellerPayout', 'lenderPayout', 'loanTerms'] as const satisfies readonly (keyof TermsCommitments)[];
/** The ones the lender package opens. */
export const LENDER_COMMITMENT_KEYS = ['price', 'lenderShare', 'lenderPayout', 'loanTerms'] as const satisfies readonly (keyof TermsCommitments)[];

/** What the admin distributes to buyer, seller, resolver (and a backup custodian). */
export interface TermsPackage {
  format: 'EscrowTermsV2';
  /** Unknown until deployment; bound on first import into a contract's vault. */
  contractAddress?: string;
  escrowColor?: string;
  escrowTicker?: string;
  terms: WirePrivateTerms;
  commitments: TermsCommitments;
  createdAt: number;
  /** FR-FUND-03: vault coin Merkle index, filled in after the deposit confirms (shared by the depositor if needed). */
  vaultIndex?: string;
  depositTxHash?: string;
}

/**
 * v2: the lender package — only what the lender needs to fund the loan, to refuse it and to be repaid: the price (to
 * check the loan against), its share, its payout key and the refund term. No buyer share, no buyer or seller key.
 */
export interface LenderPackage {
  format: 'EscrowLenderTermsV2';
  contractAddress?: string;
  escrowColor?: string;
  escrowTicker?: string;
  price: string;
  priceSalt: string;
  lenderShare: string;
  lenderShareSalt: string;
  lenderPayout: string;
  lenderPayoutSalt: string;
  refundOnLoss: boolean;
  loanTermsSalt: string;
  commitments: Pick<TermsCommitments, (typeof LENDER_COMMITMENT_KEYS)[number]>;
  createdAt: number;
}

/** FR-TERMS-05 / FR-NOTARY-02: one opening handed to a third party, without the rest of the package. */
export type Opening =
  | { format: 'EscrowOpeningV1'; kind: 'amount'; contractAddress?: string; amount: string; salt: string; ticker?: string }
  | { format: 'EscrowOpeningV1'; kind: 'buyerPayout' | 'sellerPayout'; contractAddress?: string; key: string; salt: string };

/** KycAttestationV1 bundle exactly as the eu-counterparty-simulator CASP returns it. */
export interface WirePoint {
  x: string;
  y: string;
}
export interface WireSignature {
  announcement: WirePoint;
  response: string;
}
export interface WireAttestation {
  subject: string;
  wallet: string;
  kycLevel: number;
  amlRiskScore: number;
  validUntil: number;
  travelRuleRef: string;
  salt: string;
}
export interface AttestationBundle {
  format: 'KycAttestationV1';
  issuerId: string;
  issuerPublicKey: WirePoint;
  attestation: WireAttestation;
  signature: WireSignature;
  reference: string;
  issuedAt: number;
}
export interface RevocationBundle {
  format: 'KycAttestationV1';
  kind: 'attestation' | 'issuer';
  issuerId: string;
  reference?: string;
  signature: WireSignature;
  reason: string;
  issuedAt: number;
}

const U128_MAX = (1n << 128n) - 1n;

const whole = (v: string) => /^\d+$/.test(v.trim());

/** Mirrors the contract's openTerms() rules, so a package that would fail on-chain is refused here first. */
export function validateTerms(t: WirePrivateTerms, mode?: 'attested' | 'deposited'): string | null {
  for (const [label, v] of [
    ['Price', t.price],
    ['Buyer deposit', t.amount],
    ['Loan amount', t.lenderShare]
  ] as const) {
    if (!whole(v)) return `${label} must be a whole number in the token base unit.`;
    if (BigInt(v.trim()) > U128_MAX) return `${label} must be below 2^128.`;
  }
  const price = BigInt(t.price.trim()), amount = BigInt(t.amount.trim()), loan = BigInt(t.lenderShare.trim());
  if (amount <= 0n) return 'The buyer deposit must be positive.';
  if (amount + loan !== price) return 'The buyer deposit and the loan amount must add up to the price.';
  if (mode === 'deposited' && loan <= 0n) return 'A loan-financed escrow needs a loan amount.';
  if (mode === 'attested' && loan !== 0n) return 'A cash deal has no loan amount: the buyer deposit must equal the price.';
  for (const [label, v] of [
    ['Buyer payout key', t.buyerPayout],
    ['Seller payout key', t.sellerPayout],
    ['Lender payout key', t.lenderPayout],
    ['Amount salt', t.amountSalt],
    ['Buyer salt', t.buyerSalt],
    ['Seller salt', t.sellerSalt],
    ['Price salt', t.priceSalt],
    ['Loan amount salt', t.lenderShareSalt],
    ['Lender salt', t.lenderPayoutSalt],
    ['Loan terms salt', t.loanTermsSalt]
  ] as const) {
    if (!isHex32(v)) return `${label} must be 64 hex characters.`;
  }
  if (typeof t.refundOnLoss !== 'boolean') return 'The loan refusal refund term must be yes or no.';
  if (norm(t.buyerPayout) === norm(t.sellerPayout)) return 'Buyer and seller payout keys must differ.';
  if (loan > 0n && (norm(t.lenderPayout) === norm(t.sellerPayout) || norm(t.lenderPayout) === norm(t.buyerPayout))) return 'The lender payout key must differ from the buyer and seller keys.';
  return null;
}

export const norm = (h: string): string => h.trim().toLowerCase().replace(/^0x/, '');

export function isTermsPackage(x: unknown): x is TermsPackage {
  const p = x as TermsPackage;
  return !!p && p.format === 'EscrowTermsV2' && typeof p.terms === 'object' && typeof p.commitments === 'object';
}

/** A package made for a version 1 escrow: refused by this dApp with a clear message (see TERMS_V1_MESSAGE). */
export function isV1TermsPackage(x: unknown): boolean {
  return !!x && (x as { format?: string }).format === 'EscrowTermsV1';
}
export const TERMS_V1_MESSAGE = 'This terms package was made for a version 1 escrow. This dApp opens version 2 escrows only; use the v1.0-dapp release for older escrows.';

export function isLenderPackage(x: unknown): x is LenderPackage {
  const p = x as LenderPackage;
  return !!p && p.format === 'EscrowLenderTermsV2' && typeof p.commitments === 'object';
}

export function isAttestationBundle(x: unknown): x is AttestationBundle {
  const b = x as AttestationBundle;
  return !!b && b.format === 'KycAttestationV1' && typeof b.attestation === 'object' && typeof b.signature === 'object' && isHex32(b.issuerId ?? '');
}

export function isRevocationBundle(x: unknown): x is RevocationBundle {
  const b = x as RevocationBundle;
  return !!b && b.format === 'KycAttestationV1' && (b.kind === 'attestation' || b.kind === 'issuer') && typeof b.signature === 'object';
}
