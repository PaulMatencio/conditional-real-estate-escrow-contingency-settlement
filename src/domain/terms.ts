/**
 * Private terms package (FR-TERMS) and CASP attestation bundle (FR-KYC) in their JSON wire forms.
 * Bytes are 64-hex, amounts decimal strings, so packages survive JSON and can be encrypted and shared.
 * NFR-07: none of these values may ever go into a URL, a log line or a server request.
 */
import { isHex32 } from './hex';

export interface WirePrivateTerms {
  /** Integer amount in the token's base unit (decimal string, < 2^128). */
  amount: string;
  amountSalt: string;
  /** Buyer's shielded coin public key (64 hex). */
  buyerPayout: string;
  buyerSalt: string;
  sellerPayout: string;
  sellerSalt: string;
}

export interface TermsCommitments {
  amount: string;
  buyerPayout: string;
  sellerPayout: string;
}

/** What the admin distributes to buyer, seller, resolver (and a backup custodian). */
export interface TermsPackage {
  format: 'EscrowTermsV1';
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

export function validateTerms(t: WirePrivateTerms): string | null {
  if (!/^\d+$/.test(t.amount.trim())) return 'Amount must be a whole number in the token base unit.';
  const a = BigInt(t.amount.trim());
  if (a <= 0n || a > U128_MAX) return 'Amount must be positive and below 2^128.';
  for (const [label, v] of [
    ['Buyer payout key', t.buyerPayout],
    ['Seller payout key', t.sellerPayout],
    ['Amount salt', t.amountSalt],
    ['Buyer salt', t.buyerSalt],
    ['Seller salt', t.sellerSalt]
  ] as const) {
    if (!isHex32(v)) return `${label} must be 64 hex characters.`;
  }
  if (norm(t.buyerPayout) === norm(t.sellerPayout)) return 'Buyer and seller payout keys must differ.';
  return null;
}

export const norm = (h: string): string => h.trim().toLowerCase().replace(/^0x/, '');

export function isTermsPackage(x: unknown): x is TermsPackage {
  const p = x as TermsPackage;
  return !!p && p.format === 'EscrowTermsV1' && typeof p.terms === 'object' && typeof p.commitments === 'object';
}

export function isAttestationBundle(x: unknown): x is AttestationBundle {
  const b = x as AttestationBundle;
  return !!b && b.format === 'KycAttestationV1' && typeof b.attestation === 'object' && typeof b.signature === 'object' && isHex32(b.issuerId ?? '');
}

export function isRevocationBundle(x: unknown): x is RevocationBundle {
  const b = x as RevocationBundle;
  return !!b && b.format === 'KycAttestationV1' && (b.kind === 'attestation' || b.kind === 'issuer') && typeof b.signature === 'object';
}
