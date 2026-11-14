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
  /** Cooling-off penalty rate, basis points of the price ("0" = no penalty; always "0" when the period is off). */
  penaltyRate: string;
  /** Cooling-off penalty = floor(price × rate / 10 000), strictly lower than the buyer deposit. */
  penalty: string;
  coolingOffSalt: string;
}

export interface TermsCommitments {
  amount: string;
  buyerPayout: string;
  sellerPayout: string;
  price: string;
  lenderShare: string;
  lenderPayout: string;
  loanTerms: string;
  /** Cooling-off penalty (rate and amount). */
  coolingOff: string;
}

/** The eight commitment names, in display order. */
export const COMMITMENT_KEYS = ['price', 'amount', 'lenderShare', 'buyerPayout', 'sellerPayout', 'lenderPayout', 'loanTerms', 'coolingOff'] as const satisfies readonly (keyof TermsCommitments)[];
/** The ones the lender package opens. */
export const LENDER_COMMITMENT_KEYS = ['price', 'lenderShare', 'lenderPayout', 'loanTerms'] as const satisfies readonly (keyof TermsCommitments)[];

/** What the admin distributes to buyer, seller, resolver (and a backup custodian). */
export interface TermsPackage {
  format: 'EscrowTermsV2';
  /** Unknown until deployment; bound on first import into a contract's vault. */
  contractAddress?: string;
  escrowColor?: string;
  escrowTicker?: string;
  /** Token decimals (amounts in `terms` are base units): for display and input only, never committed. Default 6. */
  escrowDecimals?: number;
  terms: WirePrivateTerms;
  commitments: TermsCommitments;
  createdAt: number;
  /** FR-FUND-03: vault coin Merkle index, filled in after the deposit confirms (shared by the depositor if needed). */
  vaultIndex?: string;
  depositTxHash?: string;
  /** The deployment's name, test case and description, so every party's vault shows the same label. Not committed. */
  meta?: import('./escrowMeta').WireMeta;
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
  escrowDecimals?: number;
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
  meta?: import('./escrowMeta').WireMeta;
}

/** FR-TERMS-05 / FR-NOTARY-02: one opening handed to a third party, without the rest of the package. */
export type Opening =
  /** amount = the buyer deposit (v2), price = the total price, lenderShare = the loan amount. */
  | { format: 'EscrowOpeningV1'; kind: 'amount' | 'price' | 'lenderShare'; contractAddress?: string; amount: string; salt: string; ticker?: string; decimals?: number }
  | { format: 'EscrowOpeningV1'; kind: 'buyerPayout' | 'sellerPayout' | 'lenderPayout'; contractAddress?: string; key: string; salt: string }
  /** v2: the loan refusal refund term. */
  | { format: 'EscrowOpeningV1'; kind: 'loanTerms'; contractAddress?: string; refundOnLoss: boolean; salt: string }
  /** Cooling-off penalty: the rate (basis points of the price) and the amount. */
  | { format: 'EscrowOpeningV1'; kind: 'coolingOff'; contractAddress?: string; penaltyRate: string; penalty: string; salt: string; ticker?: string; decimals?: number };

/** Opening kinds in display order. The loan ones exist only in a loan deal. */
export const OPENING_KINDS = ['price', 'amount', 'lenderShare', 'loanTerms', 'coolingOff', 'buyerPayout', 'sellerPayout', 'lenderPayout'] as const satisfies readonly Opening['kind'][];
export const LOAN_OPENING_KINDS: readonly Opening['kind'][] = ['lenderShare', 'loanTerms', 'lenderPayout'];
/** What the lender package can open. */
export const LENDER_OPENING_KINDS = ['price', 'lenderShare', 'loanTerms', 'lenderPayout'] as const satisfies readonly Opening['kind'][];

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

/** Basis points in 100 %. */
export const RATE_SCALE = 10_000n;
/** The cooling-off penalty for a rate: floor(price × rate / 10 000), exactly as the contract checks it. */
export const penaltyOf = (price: bigint, rate: bigint): bigint => (price * rate) / RATE_SCALE;
/** "1.5 %" from 150 basis points. */
export const fmtRate = (bps: string | bigint): string => `${(Number(bps) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} %`;

/**
 * Mirrors the contract's openTerms() and checkCoolingOff() rules, so a package that would fail on-chain is refused here
 * first. `coolingOff` (when known) says whether the escrow has a cooling-off period: without one the penalty must be 0.
 */
export function validateTerms(t: WirePrivateTerms, mode?: 'attested' | 'deposited', coolingOff?: boolean): string | null {
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
  if (!whole(t.penaltyRate ?? '') || !whole(t.penalty ?? '')) return 'The cooling-off penalty rate and amount must be whole numbers.';
  const rate = BigInt(t.penaltyRate), penalty = BigInt(t.penalty);
  if (rate > RATE_SCALE) return 'The cooling-off penalty rate cannot exceed 100 %.';
  if (penalty !== penaltyOf(price, rate)) return 'The cooling-off penalty must be the rate applied to the price, rounded down.';
  if (penalty >= amount) return 'The cooling-off penalty must be lower than the buyer deposit.';
  if (coolingOff === false && rate !== 0n) return 'Without a cooling-off period there is no penalty: set the rate to 0.';
  if (!isHex32(t.coolingOffSalt ?? '')) return 'Cooling-off salt must be 64 hex characters.';
  if (norm(t.buyerPayout) === norm(t.sellerPayout)) return 'Buyer and seller payout keys must differ.';
  if (loan > 0n && (norm(t.lenderPayout) === norm(t.sellerPayout) || norm(t.lenderPayout) === norm(t.buyerPayout))) return 'The lender payout key must differ from the buyer and seller keys.';
  return null;
}

export const norm = (h: string): string => h.trim().toLowerCase().replace(/^0x/, '');

export function isTermsPackage(x: unknown): x is TermsPackage {
  const p = x as TermsPackage;
  return !!p && p.format === 'EscrowTermsV2' && typeof p.terms === 'object' && typeof p.commitments === 'object' && typeof p.terms.coolingOffSalt === 'string';
}

/** A v2 package made before the cooling-off term (no 8th commitment): refused, re-issue it. */
export function isPreCoolingOffPackage(x: unknown): boolean {
  const p = x as TermsPackage;
  return !!p && p.format === 'EscrowTermsV2' && typeof p.terms === 'object' && typeof p.terms.coolingOffSalt !== 'string';
}
export const TERMS_PRE_COOLING_OFF_MESSAGE = 'This terms package predates the cooling-off term (it has 7 commitments, the contract now has 8). Ask the admin to issue a new package.';

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
