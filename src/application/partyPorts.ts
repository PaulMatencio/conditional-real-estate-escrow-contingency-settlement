/**
 * Ports for the Phase 2 party use-cases. Implemented by infrastructure:
 *  - EscrowPartyGateway: chain (midnight-js + wallet) and the in-browser simulator (FR-WALLET-04);
 *  - CaspGateway: the eu-counterparty-simulator CASP REST API (through the dApp's same-origin proxy);
 *  - Vault: the encrypted, client-side store of private material (FR-TERMS-04/06, NFR-06).
 */
import type { ContingencyName, EscrowView } from '@/domain/escrowView';
import type { PartyCircuit } from '@/domain/lifecycle';
import type { AttestationBundle, RevocationBundle, TermsPackage, WireSignature } from '@/domain/terms';
import type { TxReceipt } from '@/domain/escrow';

/** Private inputs for one call. Lives only for the duration of the call. */
export interface CallMaterial {
  secretKey?: Uint8Array;
  terms?: TermsPackage['terms'];
  kyc?: AttestationBundle;
  /** Merkle index of the vault coin (FR-FUND-03). */
  vaultIndex?: bigint;
}

export interface CircuitArgs {
  acceptConfiguration: [expectedVersion: bigint];
  cancelBeforeFunding: [];
  depositToEscrow: [];
  submitSellerKyc: [];
  openContingencyReview: [];
  submitInspection: [passed: boolean, reportHash: string];
  submitFinancing: [approved: boolean, reportHash: string];
  submitTitle: [cleared: boolean, reportHash: string];
  waiveContingency: [which: ContingencyName];
  cancelAndRefund: [];
  sellerWithdraw: [];
  expireEscrow: [];
  openDispute: [];
  resolveDisputeRefund: [];
  resolveDisputeSettlement: [];
  voidContingencyResult: [which: ContingencyName];
  dismissDispute: [];
  releaseToSeller: [];
  refundBuyer: [];
  revokeKycAttestation: [issuerId: string, ref: string, sig: WireSignature];
  revokeKycIssuer: [issuerId: string, sig: WireSignature];
}

/** Shielded effects of a call (the simulator reports them; on chain they are hidden). */
export interface ShieldedEffects {
  inputs: { nonce: string; color: string; value: string }[];
  outputs: { nonce: string; color: string; value: string; recipient: string; recipientIsContract: boolean }[];
}

export interface CallReceipt extends TxReceipt {
  blockHash?: string;
  shielded?: ShieldedEffects;
  /** Set by a deposit when the vault index could be derived (FR-FUND-03). */
  vaultIndex?: bigint;
}

export interface EscrowPartyGateway {
  readonly mode: 'wallet' | 'simulator';
  readonly contractAddress: string;
  readView(): Promise<EscrowView>;
  /** Best estimate of the chain's block time, in unix seconds. */
  now(): Promise<bigint>;
  call<C extends PartyCircuit>(circuit: C, args: CircuitArgs[C], material: CallMaterial): Promise<CallReceipt>;
  /**
   * FR-FUND-03: Merkle index of the vault coin, derived from the deposit transaction. Any party holding the terms can
   * call it (NFR-08); without the deposit hash the gateway may still find it (the simulator always can).
   */
  locateVaultIndex(depositTxHash: string | null, terms: TermsPackage['terms']): Promise<bigint | null>;
  /** FR-WALLET-05: the connected wallet's shielded coin public key (64 hex), if any. */
  coinPublicKey(): Promise<string | null>;
  /** FR-WALLET-06: shielded balance of a token type, if the wallet reports it. */
  shieldedBalance(color: string): Promise<bigint | null>;
}

// ------------------------------------------------------------------ CASP

export interface CaspIssuerKey {
  issuerId: string;
  publicKey: { x: string; y: string };
  status: string;
  createdAt?: number;
}

export interface CaspAssessment {
  decision: 'approve' | 'refer' | 'reject';
  kycLevel: number;
  amlRiskScore: number;
  eddRequired: boolean;
  sanctionsHit: boolean;
  reasons: string[];
}

export interface CaspGateway {
  health(): Promise<{ ok: boolean; casp: string; testOnly?: boolean }>;
  issuerKeys(): Promise<{ casp: string; keys: CaspIssuerKey[] }>;
  /** TEST ONLY: one-shot onboarding of a fixture persona, returning a signed bundle when approved. */
  personaAttestation(persona: string, req: { subject: string; walletKey: string; role: 'originator' | 'beneficiary'; validityDays?: number }): Promise<{ customerId: string; assessment: CaspAssessment; bundle: AttestationBundle | null }>;
  /** Officer: signed revocation of one attestation (by its on-chain reference). */
  revokeAttestation(reference: string, reason: string): Promise<RevocationBundle>;
  /** Officer: signed self-revocation of an issuer key. */
  revokeIssuer(issuerId: string, reason: string): Promise<RevocationBundle>;
  /** Officer / notary: status of an attestation (source of funds statement, revocation). */
  attestationStatus(reference: string): Promise<Record<string, unknown>>;
  /** Officer / notary: Travel Rule record + salt for a reference. */
  travelRule(reference: string): Promise<Record<string, unknown>>;
}

// ------------------------------------------------------------------ Vault

export interface VaultRecord {
  terms?: TermsPackage;
  /** Attestation bundles keyed by role (buyer, seller). */
  kyc?: Partial<Record<'buyer' | 'seller', AttestationBundle>>;
  /** Role secret keys held for this contract, hex (FR-WALLET-02). */
  roleKeys?: Record<string, string>;
  /** Role keys removed or replaced in this vault, kept so a mistaken removal can be undone. */
  roleKeyHistory?: { role: string; key: string; removedAt: number }[];
  /** FR-TERMS-04: at least one confirmed backup before finalize. */
  backups?: { at: number; kind: 'file' | 'custodian'; note?: string }[];
  /** Salt + metadata of documents this party committed (FR-ATTEST-02). */
  documents?: { contingency: ContingencyName; reportHash: string; salt: string; fileName: string; at: number }[];
  /** Contract maintenance-authority (signing) key, admin only; removed once the authority is renounced. */
  authorityKey?: string;
  authorityKeyHistory?: { key: string; replacedAt: number }[];
  /** When this browser renounced the maintenance authority (contract immutable). */
  authorityRenouncedAt?: number;
  /** X25519 key pair for receiving encrypted terms packages (stored under the IDENTITY_RECORD id). */
  identity?: { publicKey: string; privateKeyJwk: JsonWebKey };
  /** ADMIN_RECORD only: the admin secret key (64 hex) and the keys it replaced. */
  adminKey?: string;
  adminKeyHistory?: { key: string; replacedAt: number }[];
  /** Earlier envelope key pairs (e.g. restored from a backup); still tried when opening envelopes. */
  identityHistory?: { publicKey: string; privateKeyJwk: JsonWebKey }[];
  /** FR-AUDIT-03: local transaction history. */
  history?: { at: number; circuit: string; txHash: string; blockHeight?: number; status: string; role?: string }[];
}

/** Vault record id that holds this browser's envelope identity rather than a contract. */
export const IDENTITY_RECORD = '_identity';
/** Vault record id that holds the admin console's secret key (one per browser, not per contract). */
export const ADMIN_RECORD = '_admin';

export interface Vault {
  readonly unlocked: boolean;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
  load(contractAddress: string): Promise<VaultRecord>;
  save(contractAddress: string, record: VaultRecord): Promise<void>;
  /** NFR-06 "erase locally": deletes salts and openings for this contract. */
  erase(contractAddress: string): Promise<void>;
  contracts(): Promise<string[]>;
}
