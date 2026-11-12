/** Domain types for the admin side of the escrow. Pure and framework-free. */

export interface TxReceipt {
  txId: string;
  txHash: string;
  blockHeight?: number;
}

export interface KycPolicyInput {
  minKycLevel: number;
  maxAmlRiskScore: number;
}

/**
 * The terms the admin may leave for later. Role ids are 64-hex `roleIdOf(secretKey)`; the three commitments are
 * 64-hex salted commitments (the private openings stay with the parties). Deadlines are unix seconds.
 */
export interface ConfigureTerms {
  inspector?: string;
  lender?: string;
  titleAgent?: string;
  resolver?: string;
  buyerPayoutCommitment?: string;
  sellerPayoutCommitment?: string;
  amountCommitment?: string;
  closingDeadline?: bigint;
  disputeDeadline?: bigint;
  kycPolicy?: KycPolicyInput;
}

/**
 * v2 financing terms (`configureFinancing`): the financing mode, the four commitments only the full terms package can
 * open (price, loan amount, lender payout key, refund term) and the loan dates. Same delayed-initialization rules as
 * `configure`: any subset, admin only, while Initializing.
 */
export interface FinancingTerms {
  mode?: 'attested' | 'deposited';
  priceCommitment?: string;
  lenderShareCommitment?: string;
  lenderPayoutCommitment?: string;
  loanTermsCommitment?: string;
  /** Unix seconds (loan mode): the lender may withdraw from here on. Must not be after the closing deadline. */
  loanOfferExpiry?: bigint;
  /** Seconds (loan mode, refund term on): how long the buyer has to top up after a lost loan. */
  topUpWindow?: bigint;
}

/** Days → seconds for the top-up window (default 7 days). */
export const DEFAULT_TOP_UP_DAYS = 7;

/** Mandatory at deployment and immutable afterwards; everything in `terms` may be filled in later. */
export interface DeployParams {
  adminRoleId: string;
  buyerRoleId: string;
  sellerRoleId: string;
  /** 64-hex shielded token type (color) the escrow holds. */
  tokenColor: string;
  ticker: string;
  terms?: ConfigureTerms;
  /** Circuits carried by the deploy transaction (default from midnight.config.json). */
  deployCircuits?: string[];
}

export interface AdminState {
  contractAddress: string;
  status: number;
  ticker: string;
  tokenColor: string;
  configVersion: bigint;
  buyerAccepted: boolean;
  sellerAccepted: boolean;
  closingDeadline: bigint;
  disputeDeadline: bigint;
  roles: Record<'admin' | 'buyer' | 'seller' | 'inspector' | 'lender' | 'titleAgent' | 'resolver', string | null>;
  configured: string[];
  missingAttributes: string[];
  registeredCircuits: string[];
  missingCircuits: string[];
  /** v2: financing mode (null until configured), loan offer expiry (unix s) and top-up window (s). */
  financing: { mode: 'attested' | 'deposited' | null; loanOfferExpiry: bigint; topUpWindow: bigint };
  /** On-chain maintenance authority (null if not reported). */
  maintenance: import('./escrowView').MaintenanceStatus | null;
}
