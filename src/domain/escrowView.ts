/**
 * Decoded public ledger of one escrow (everything a party, the notary or the simulator can read).
 * Pure data: bytes are lower-case hex, numbers that can exceed 2^53 stay bigint. Never contains private terms.
 */

/** Mirrors the contract's `EscrowStatus` (same ordinal values). */
export const STATUS = [
  'Initializing',
  'Created',
  'Funded',
  'ContingenciesPending',
  'ReadyToClose',
  'Disputed',
  'Settled',
  'Refunded',
  'Expired',
  'Closed',
  'Cancelled',
  'Forfeited',
  'Withdrawn'
] as const;
export type StatusName = (typeof STATUS)[number];

/** Mirrors the contract's `InitAttribute`. */
export const INIT_ATTRIBUTES = [
  'Inspector',
  'Lender',
  'TitleAgent',
  'Resolver',
  'BuyerPayout',
  'SellerPayout',
  'EscrowAmount',
  'ClosingDeadline',
  'DisputeDeadline',
  'KycIssuers',
  'KycPolicy',
  'Financing',
  'Price',
  'LenderShare',
  'LenderPayout',
  'LoanTerms',
  'LoanOfferExpiry',
  'TopUpWindow',
  'CoolingOff',
  'CoolingOffTerms'
] as const;

/** Mirrors the contract's `FinancingMode`. */
export const FINANCING_MODES = ['Attested', 'Deposited'] as const;
export type FinancingModeName = (typeof FINANCING_MODES)[number];

/** v2: how the financing contingency is met, and where the second coin stands. */
export interface FinancingState {
  /** Null until configured. */
  mode: FinancingModeName | null;
  /** Unix seconds (loan mode): the lender may withdraw from here on. */
  loanOfferExpiry: bigint;
  /** Seconds the buyer has to top up after a lost loan (refund term on). */
  topUpWindow: bigint;
  loanHeld: boolean;
  topUpHeld: boolean;
  /** The lender refused or withdrew. */
  loanLost: boolean;
  loanWithdrawn: boolean;
  /** The refund term, public once the loan is lost. */
  loanLostRefund: boolean;
  /** Unix seconds; meaningful when the loan is lost with the refund term on. */
  topUpWindowEnd: bigint;
  buyerCoinPaid: boolean;
  secondCoinPaid: boolean;
}
export type InitAttributeName = (typeof INIT_ATTRIBUTES)[number];

/** Cooling-off period: the public part (the penalty itself stays private). */
export interface CoolingOffState {
  /** Seconds after the deposit; 0 = off. */
  period: bigint;
  /** Unix seconds, set at the deposit: min(deposit time + period, closing deadline). 0 when off or not funded. */
  end: bigint;
  /** The buyer withdrew (Withdrawn inside the period, Forfeited after). */
  buyerWithdrew: boolean;
  /** Withdrawn with a non-zero penalty, known once the withdrawal refund ran. */
  penaltyDue: boolean;
  penaltyPaid: boolean;
}

/** Mirrors the contract's `Contingency`. */
export const CONTINGENCIES = ['Inspection', 'Financing', 'Title'] as const;
export type ContingencyName = (typeof CONTINGENCIES)[number];

export interface ContingencyState {
  submitted: boolean;
  /** Favourable outcome (passed / approved / cleared). Meaningful only when `submitted`. */
  passed: boolean;
  waived: boolean;
  /** Anchored document commitment (64 hex); all zeros when none. */
  reportHash: string;
}

export interface KycRecord {
  verified: boolean;
  issuerId: string;
  ref: string;
  travelRuleRef: string;
}

/** On-chain contract maintenance authority (who can change verifier keys, i.e. the contract's rules). */
export interface MaintenanceStatus {
  committeeSize: number;
  threshold: number;
  counter: string;
}

export type AuthorityLevel = 'immutable' | 'controlled' | 'open' | 'unknown';

/**
 * immutable: no committee can reach the threshold (e.g. empty committee, threshold 1) — the rules can never change;
 * controlled: `committeeSize` keys exist and `threshold` of them can change the rules;
 * open: threshold 0 — anyone could submit an update (must never happen);
 * unknown: not reported (simulator, or state not read).
 */
export function authorityLevel(m: MaintenanceStatus | null | undefined): AuthorityLevel {
  if (!m) return 'unknown';
  if (m.threshold <= 0) return 'open';
  return m.committeeSize < m.threshold ? 'immutable' : 'controlled';
}

export interface EscrowView {
  contractAddress: string;
  /** Null in Simulator Mode or when the authority could not be read. */
  maintenance: MaintenanceStatus | null;
  status: StatusName;
  lifecycleRound: bigint;
  correctionCount: bigint;
  disbursed: boolean;
  configVersion: bigint;
  buyerAccepted: boolean;
  sellerAccepted: boolean;
  configured: InitAttributeName[];
  roles: {
    admin: string;
    buyer: string;
    seller: string;
    inspector: string | null;
    lender: string | null;
    titleAgent: string | null;
    resolver: string | null;
  };
  escrowColor: string;
  escrowTicker: string;
  commitments: {
    amount: string | null;
    buyerPayout: string | null;
    sellerPayout: string | null;
    price: string | null;
    lenderShare: string | null;
    lenderPayout: string | null;
    loanTerms: string | null;
    coolingOff: string | null;
  };
  financing: FinancingState;
  coolingOff: CoolingOffState;
  closingDeadline: bigint;
  disputeDeadline: bigint;
  kycIssuers: { issuerId: string; publicKey: { x: string; y: string } }[];
  revokedKycRefs: string[];
  kycPolicy: { minKycLevel: number; maxAmlRiskScore: number };
  buyerKyc: KycRecord;
  sellerKyc: KycRecord & { validUntil: bigint };
  contingencies: Record<ContingencyName, ContingencyState>;
  voidedReportHistory: { index: bigint; reportHash: string }[];
}

export const ZERO_HEX32 = '0'.repeat(64);
export const isZeroHex = (h: string): boolean => /^0*$/.test(h);

export const isFullyConfigured = (v: EscrowView): boolean => v.configured.length === INIT_ATTRIBUTES.length;
export const missingAttributes = (v: EscrowView): InitAttributeName[] => INIT_ATTRIBUTES.filter((a) => !v.configured.includes(a));

export const allCleared = (v: EscrowView): boolean => CONTINGENCIES.every((c) => v.contingencies[c].submitted && v.contingencies[c].passed);
export const anyFailed = (v: EscrowView): boolean => CONTINGENCIES.some((c) => v.contingencies[c].submitted && !v.contingencies[c].passed);

/** Same rule as the contract's `hasUsableSellerKyc` (block time approximated by `nowSec`). */
export function hasUsableSellerKyc(v: EscrowView, nowSec: bigint): boolean {
  const k = v.sellerKyc;
  return k.verified && v.kycIssuers.some((i) => i.issuerId === k.issuerId) && !v.revokedKycRefs.includes(k.ref) && nowSec < k.validUntil;
}

/** FR-NOTARY / §3.1.4 AC-4: the committed amount is locked while one of these holds and nothing was disbursed. */
export const LOCKED_STATES: readonly StatusName[] = ['Funded', 'ContingenciesPending', 'ReadyToClose', 'Disputed', 'Settled'];
export const fundsLocked = (v: EscrowView): boolean => LOCKED_STATES.includes(v.status) && !v.disbursed;

/** The buyer may still withdraw without forfeiting (cooling-off on, deposit made, before the end). */
export const insideCoolingOff = (v: EscrowView, nowSec: bigint): boolean => v.coolingOff.period > 0n && v.coolingOff.end > 0n && nowSec < v.coolingOff.end;
/** No release before the cooling-off period ends. */
export const coolingOffOver = (v: EscrowView, nowSec: bigint): boolean => nowSec >= v.coolingOff.end;
