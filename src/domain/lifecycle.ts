/**
 * Which circuit may run now, for whom, and why not. A pure mirror of the contract's phase / role / deadline
 * asserts, used to render only the actions valid in the current state (§3.1.6 AC-1) with their preconditions,
 * and as a cheap pre-flight before proving (FR-FUND-04). The contract stays the authority: this table only
 * avoids sending transactions that are bound to fail.
 */
import { CONTINGENCIES, allCleared, anyFailed, coolingOffOver, hasUsableSellerKyc, insideCoolingOff, isFullyConfigured, type ContingencyName, type EscrowView, type StatusName } from './escrowView';
import type { Caller, PartyRole } from './roles';

export type PartyCircuit =
  | 'acceptConfiguration'
  | 'cancelBeforeFunding'
  | 'depositToEscrow'
  | 'submitSellerKyc'
  | 'openContingencyReview'
  | 'submitInspection'
  | 'submitFinancing'
  | 'submitTitle'
  | 'waiveContingency'
  | 'cancelAndRefund'
  | 'sellerWithdraw'
  | 'expireEscrow'
  | 'openDispute'
  | 'resolveDisputeRefund'
  | 'resolveDisputeSettlement'
  | 'voidContingencyResult'
  | 'dismissDispute'
  | 'releaseToSeller'
  | 'refundBuyer'
  | 'refundTopUp'
  | 'depositLoan'
  | 'declineLoan'
  | 'withdrawLoan'
  | 'depositTopUp'
  | 'endTopUpWindow'
  | 'refundLender'
  | 'claimForfeit'
  | 'buyerWithdraw'
  | 'refundWithdrawal'
  | 'claimPenalty'
  | 'revokeKycAttestation'
  | 'revokeKycIssuer';

export type Witness = 'localSecretKey' | 'privateTerms' | 'kycAttestation' | 'vaultCoin' | 'lenderTerms' | 'secondCoin' | 'penaltyCoin';

/** Local, private material the caller's browser holds (never on-chain). */
export interface LocalMaterial {
  terms: boolean;
  kycAttestation: boolean;
  vaultCoin: boolean;
  /** v2: the lender package (lender) or the full terms it is cut from (other parties). */
  lenderTerms?: boolean;
  /** v2: the second coin's index is known (or can be located). */
  secondCoin?: boolean;
  /** Cooling-off: the penalty coin's index is known (or can be located). */
  penaltyCoin?: boolean;
}

// ------------------------------------------------------------------ v2 financing helpers (mirror the contract)
export const isLoanMode = (v: EscrowView): boolean => v.financing.mode === 'Deposited';
export const secondCoinHeld = (v: EscrowView): boolean => v.financing.loanHeld || v.financing.topUpHeld;
/** The contract's refundableFailure(): what lets the buyer cancel and be refunded. */
export function refundableFailure(v: EscrowView): boolean {
  const c = v.contingencies;
  const other = (c.Inspection.submitted && !c.Inspection.passed) || (c.Title.submitted && !c.Title.passed);
  if (isLoanMode(v)) return other || (v.financing.loanLost && v.financing.loanLostRefund && !v.financing.topUpHeld);
  return other || (c.Financing.submitted && !c.Financing.passed);
}
/** Whether a circuit spends the second coin in this state (and so needs its index). */
export function needsSecondCoin(circuit: PartyCircuit, v: EscrowView): boolean {
  if (circuit === 'withdrawLoan' || circuit === 'refundLender') return true;
  if (circuit === 'releaseToSeller') return isLoanMode(v);
  if (circuit === 'refundTopUp') return true;
  return false;
}
const loanMode = (v: EscrowView) => (isLoanMode(v) ? null : 'Not a loan-financed escrow');

export interface ActionSpec {
  circuit: PartyCircuit;
  callers: Caller[];
  witnesses: Witness[];
  /** Moves funds or is otherwise final: the UI asks for an explicit confirmation. */
  irreversible?: boolean;
  /** Returns null when allowed, otherwise the reason (phrased like the contract's assert). */
  check(v: EscrowView, caller: Caller, nowSec: bigint, arg?: ContingencyName): string | null;
}

const inStatus = (v: EscrowView, ...s: StatusName[]) => s.includes(v.status);
const phase = (v: EscrowView, msg: string, ...s: StatusName[]) => (inStatus(v, ...s) ? null : msg);
const first = (...checks: (string | null)[]) => checks.find((c) => c !== null) ?? null;

const contingencyKey = (c: ContingencyName) => c;

export const ACTIONS: Record<PartyCircuit, ActionSpec> = {
  acceptConfiguration: {
    circuit: 'acceptConfiguration',
    callers: ['buyer', 'seller'],
    // Each party proves its package opens the deposit, price and cooling-off commitments.
    witnesses: ['localSecretKey', 'privateTerms'],
    check: (v, caller) =>
      first(
        phase(v, 'Contract is already initialized', 'Initializing'),
        isFullyConfigured(v) ? null : 'Configuration is incomplete',
        caller === 'buyer' && v.buyerAccepted ? 'Already accepted at this version' : null,
        caller === 'seller' && v.sellerAccepted ? 'Already accepted at this version' : null
      )
  },
  cancelBeforeFunding: {
    circuit: 'cancelBeforeFunding',
    callers: ['buyer', 'seller', 'admin'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v, caller) =>
      first(phase(v, 'Escrow already funded', 'Initializing', 'Created'), caller === 'admin' && v.status !== 'Initializing' ? 'Caller cannot cancel' : null)
  },
  depositToEscrow: {
    circuit: 'depositToEscrow',
    callers: ['buyer'],
    witnesses: ['localSecretKey', 'privateTerms', 'kycAttestation'],
    irreversible: true,
    check: (v, _c, now) => first(phase(v, 'Escrow is not ready for funding', 'Created'), now < v.closingDeadline ? null : 'Closing deadline has passed')
  },
  submitSellerKyc: {
    circuit: 'submitSellerKyc',
    callers: ['seller'],
    witnesses: ['localSecretKey', 'privateTerms', 'kycAttestation'],
    check: (v) => phase(v, 'Seller KYC cannot be submitted in current state', 'Created', 'Funded', 'ContingenciesPending', 'ReadyToClose', 'Disputed', 'Settled', 'Forfeited', 'Withdrawn')
  },
  openContingencyReview: {
    circuit: 'openContingencyReview',
    callers: ['buyer', 'seller'],
    witnesses: ['localSecretKey'],
    check: (v) => phase(v, 'Escrow is not funded', 'Funded')
  },
  submitInspection: {
    circuit: 'submitInspection',
    callers: ['inspector'],
    witnesses: ['localSecretKey'],
    check: (v) => first(phase(v, 'Not in contingency review', 'ContingenciesPending'), v.contingencies.Inspection.submitted ? 'Inspection outcome already submitted' : null)
  },
  submitFinancing: {
    circuit: 'submitFinancing',
    callers: ['lender'],
    witnesses: ['localSecretKey'],
    check: (v) =>
      first(
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        isLoanMode(v) ? 'Loan-financed escrow: the lender deposits or refuses the loan' : null,
        v.contingencies.Financing.submitted ? 'Financing outcome already submitted' : null
      )
  },
  submitTitle: {
    circuit: 'submitTitle',
    callers: ['titleAgent'],
    witnesses: ['localSecretKey'],
    check: (v) => first(phase(v, 'Not in contingency review', 'ContingenciesPending'), v.contingencies.Title.submitted ? 'Title outcome already submitted' : null)
  },
  waiveContingency: {
    circuit: 'waiveContingency',
    callers: ['buyer'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v, _c, _n, which) => {
      const p = phase(v, 'Not in contingency review', 'ContingenciesPending');
      if (p) return p;
      if (!which) return CONTINGENCIES.some((k) => !(v.contingencies[k].submitted && v.contingencies[k].passed)) ? null : 'Every contingency is already cleared';
      if (which === 'Financing' && isLoanMode(v)) return 'Loan-financed escrow: top up instead of waiving financing';
      const c = v.contingencies[contingencyKey(which)];
      return c.submitted && c.passed ? `${which} already cleared` : null;
    }
  },
  cancelAndRefund: {
    circuit: 'cancelAndRefund',
    callers: ['buyer'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not in contingency review', 'ContingenciesPending'), refundableFailure(v) ? null : 'No submitted contingency has failed')
  },
  sellerWithdraw: {
    circuit: 'sellerWithdraw',
    callers: ['seller'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v) => phase(v, 'Seller cannot withdraw in current state', 'Funded', 'ContingenciesPending', 'ReadyToClose')
  },
  expireEscrow: {
    circuit: 'expireEscrow',
    callers: ['anyone'],
    witnesses: [],
    check: (v, _c, now) => {
      if (v.status === 'Disputed') return now >= v.disputeDeadline ? null : 'Dispute deadline has not expired';
      if (v.status === 'ReadyToClose' || v.status === 'Settled') {
        return first(now >= v.disputeDeadline ? null : 'Dispute deadline has not expired', hasUsableSellerKyc(v, now) ? 'Seller has valid KYC; escrow can be released' : null);
      }
      return first(phase(v, 'Escrow cannot expire in current state', 'Funded', 'ContingenciesPending'), now >= v.closingDeadline ? null : 'Closing deadline has not expired');
    }
  },
  openDispute: {
    circuit: 'openDispute',
    callers: ['buyer', 'seller'],
    witnesses: ['localSecretKey'],
    check: (v, _c, now) => first(phase(v, 'Escrow cannot be disputed in current state', 'ContingenciesPending', 'ReadyToClose'), now < v.disputeDeadline ? null : 'Dispute window is closed')
  },
  resolveDisputeRefund: {
    circuit: 'resolveDisputeRefund',
    callers: ['resolver'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v) => phase(v, 'Escrow is not disputed', 'Disputed')
  },
  resolveDisputeSettlement: {
    circuit: 'resolveDisputeSettlement',
    callers: ['resolver'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not disputed', 'Disputed'), allCleared(v) ? null : 'Contingencies are not all cleared')
  },
  voidContingencyResult: {
    circuit: 'voidContingencyResult',
    callers: ['resolver'],
    witnesses: ['localSecretKey'],
    check: (v, _c, _n, which) => {
      const p = phase(v, 'Escrow is not disputed', 'Disputed');
      if (p) return p;
      if (!which) return CONTINGENCIES.some((k) => v.contingencies[k].submitted && !v.contingencies[k].waived) ? null : 'No attested result to void';
      const c = v.contingencies[which];
      if (which === 'Financing' && isLoanMode(v) && c.submitted && !(v.financing.loanLost && !v.financing.loanWithdrawn && !v.financing.topUpHeld)) return 'Only a loan refusal can be voided';
      return c.submitted && !c.waived ? null : `No attested ${which.toLowerCase()} to void`;
    }
  },
  dismissDispute: {
    circuit: 'dismissDispute',
    callers: ['resolver'],
    witnesses: ['localSecretKey'],
    check: (v) => phase(v, 'Escrow is not disputed', 'Disputed')
  },
  releaseToSeller: {
    circuit: 'releaseToSeller',
    callers: ['buyer', 'seller', 'resolver'],
    witnesses: ['localSecretKey', 'privateTerms', 'vaultCoin', 'secondCoin'],
    irreversible: true,
    check: (v, caller, now) =>
      first(
        phase(v, 'Escrow is not releasable to seller', 'ReadyToClose', 'Settled'),
        v.financing.buyerCoinPaid ? 'Funds already disbursed' : null,
        isLoanMode(v) && !secondCoinHeld(v) ? 'The loan (or the buyer\'s top-up) is not deposited' : null,
        v.status === 'ReadyToClose' && caller !== 'buyer' && caller !== 'seller' ? 'Caller is not buyer or seller' : null,
        v.status === 'Settled' && caller !== 'resolver' ? 'Caller is not the dispute resolver' : null,
        v.sellerKyc.verified ? null : 'ERROR_SELLER_KYC_REQUIRED',
        coolingOffOver(v, now) ? null : 'Cooling-off period is not over',
        v.kycIssuers.some((i) => i.issuerId === v.sellerKyc.issuerId) ? null : 'ERROR_NOT_WHITELISTED: seller KYC issuer was revoked',
        v.revokedKycRefs.includes(v.sellerKyc.ref) ? 'ERROR_KYC_REVOKED' : null,
        now < v.sellerKyc.validUntil ? null : 'ERROR_KYC_EXPIRED'
      )
  },
  refundBuyer: {
    circuit: 'refundBuyer',
    callers: ['buyer', 'seller', 'resolver'],
    witnesses: ['localSecretKey', 'privateTerms', 'vaultCoin'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not refundable', 'Refunded', 'Expired'), v.financing.buyerCoinPaid ? 'Funds already disbursed' : null)
  },
  /** v2: the buyer's top-up comes back in its own transaction (one payout per circuit keeps the proofs at k=16). */
  refundTopUp: {
    circuit: 'refundTopUp',
    callers: ['buyer', 'seller', 'resolver'],
    witnesses: ['localSecretKey', 'privateTerms', 'secondCoin'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not refundable', 'Refunded', 'Expired', 'Withdrawn', 'Forfeited'), v.financing.topUpHeld && !v.financing.secondCoinPaid ? null : 'No top-up to refund')
  },
  // ---------------------------------------------------------------- v2: financing by deposit
  depositLoan: {
    circuit: 'depositLoan',
    callers: ['lender'],
    witnesses: ['localSecretKey', 'lenderTerms'],
    irreversible: true,
    check: (v, _c, now) =>
      first(
        loanMode(v),
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        secondCoinHeld(v) ? 'The second coin is already deposited' : null,
        v.financing.loanLost ? 'The loan was already refused or withdrawn' : null,
        now < v.financing.loanOfferExpiry ? null : 'Loan offer has expired'
      )
  },
  declineLoan: {
    circuit: 'declineLoan',
    callers: ['lender'],
    witnesses: ['localSecretKey', 'lenderTerms'],
    irreversible: true,
    check: (v) =>
      first(
        loanMode(v),
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        secondCoinHeld(v) ? 'The second coin is already deposited' : null,
        v.financing.loanLost ? 'The loan was already refused or withdrawn' : null
      )
  },
  withdrawLoan: {
    circuit: 'withdrawLoan',
    callers: ['lender'],
    witnesses: ['localSecretKey', 'lenderTerms', 'secondCoin'],
    irreversible: true,
    check: (v, _c, now) =>
      first(
        loanMode(v),
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        v.financing.loanHeld && !v.financing.secondCoinPaid ? null : 'No loan deposit to withdraw',
        now >= v.financing.loanOfferExpiry ? null : 'Loan offer has not expired yet'
      )
  },
  depositTopUp: {
    circuit: 'depositTopUp',
    callers: ['buyer'],
    witnesses: ['localSecretKey', 'privateTerms', 'kycAttestation'],
    irreversible: true,
    check: (v, _c, now) => {
      const f = v.financing;
      const windowed = f.loanLost && f.loanLostRefund;
      return first(
        loanMode(v),
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        secondCoinHeld(v) ? 'The second coin is already deposited' : null,
        windowed ? (now < f.topUpWindowEnd ? null : 'Top-up window is over') : now < v.closingDeadline ? null : 'Closing deadline has passed'
      );
    }
  },
  endTopUpWindow: {
    circuit: 'endTopUpWindow',
    callers: ['anyone'],
    witnesses: [],
    check: (v, _c, now) =>
      first(
        loanMode(v),
        phase(v, 'Not in contingency review', 'ContingenciesPending'),
        v.financing.loanLost && v.financing.loanLostRefund ? null : 'No top-up window is running',
        v.financing.topUpHeld ? 'The buyer has topped up' : null,
        now >= v.financing.topUpWindowEnd ? null : 'Top-up window is not over'
      )
  },
  refundLender: {
    circuit: 'refundLender',
    callers: ['lender', 'buyer', 'seller', 'resolver'],
    witnesses: ['localSecretKey', 'lenderTerms', 'secondCoin'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not refundable', 'Refunded', 'Expired', 'Withdrawn', 'Forfeited'), v.financing.loanHeld && !v.financing.secondCoinPaid ? null : 'No loan deposit to refund')
  },
  // ---------------------------------------------------------------- cooling-off: the buyer withdraws
  buyerWithdraw: {
    circuit: 'buyerWithdraw',
    callers: ['buyer'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v, _c, now) =>
      first(
        inStatus(v, 'Funded', 'ContingenciesPending', 'ReadyToClose') || (v.status === 'Disputed' && insideCoolingOff(v, now)) ? null : 'Buyer cannot withdraw in current state',
        refundableFailure(v) ? 'A contingency failed: cancel and get a full refund instead' : null
      )
  },
  refundWithdrawal: {
    circuit: 'refundWithdrawal',
    callers: ['buyer', 'seller', 'resolver'],
    witnesses: ['localSecretKey', 'privateTerms', 'vaultCoin'],
    irreversible: true,
    check: (v) => first(phase(v, 'Buyer has not withdrawn in the cooling-off period', 'Withdrawn'), v.financing.buyerCoinPaid ? 'Funds already disbursed' : null)
  },
  claimPenalty: {
    circuit: 'claimPenalty',
    callers: ['seller'],
    witnesses: ['localSecretKey', 'privateTerms', 'penaltyCoin'],
    irreversible: true,
    check: (v, _c, now) =>
      first(
        phase(v, 'Buyer has not withdrawn in the cooling-off period', 'Withdrawn'),
        v.financing.buyerCoinPaid ? null : 'Refund the buyer first',
        v.coolingOff.penaltyDue && !v.coolingOff.penaltyPaid ? null : 'No penalty to claim',
        v.sellerKyc.verified ? null : 'ERROR_SELLER_KYC_REQUIRED',
        v.kycIssuers.some((i) => i.issuerId === v.sellerKyc.issuerId) ? null : 'ERROR_NOT_WHITELISTED: seller KYC issuer was revoked',
        v.revokedKycRefs.includes(v.sellerKyc.ref) ? 'ERROR_KYC_REVOKED' : null,
        now < v.sellerKyc.validUntil ? null : 'ERROR_KYC_EXPIRED'
      )
  },
  claimForfeit: {
    circuit: 'claimForfeit',
    callers: ['seller'],
    witnesses: ['localSecretKey', 'privateTerms', 'vaultCoin'],
    irreversible: true,
    check: (v, _c, now) =>
      first(
        phase(v, 'Escrow is not forfeited', 'Forfeited'),
        v.financing.buyerCoinPaid ? 'Funds already disbursed' : null,
        v.sellerKyc.verified ? null : 'ERROR_SELLER_KYC_REQUIRED',
        v.kycIssuers.some((i) => i.issuerId === v.sellerKyc.issuerId) ? null : 'ERROR_NOT_WHITELISTED: seller KYC issuer was revoked',
        v.revokedKycRefs.includes(v.sellerKyc.ref) ? 'ERROR_KYC_REVOKED' : null,
        now < v.sellerKyc.validUntil ? null : 'ERROR_KYC_EXPIRED'
      )
  },
  revokeKycAttestation: {
    circuit: 'revokeKycAttestation',
    callers: ['anyone'],
    witnesses: [],
    check: (v) => (v.kycIssuers.length ? null : 'No trusted CASP is registered')
  },
  revokeKycIssuer: {
    circuit: 'revokeKycIssuer',
    callers: ['anyone'],
    witnesses: [],
    check: (v) => (v.kycIssuers.length ? null : 'No trusted CASP is registered')
  }
};

export interface AvailableAction {
  circuit: PartyCircuit;
  enabled: boolean;
  /** Why it is disabled: a phase/role/deadline reason or the missing local material. */
  reason: string | null;
  irreversible: boolean;
}

const missingMaterial = (spec: ActionSpec, m: LocalMaterial, v: EscrowView): string | null => {
  if (spec.witnesses.includes('privateTerms') && !m.terms) return 'Needs the private terms package (Terms vault)';
  if (spec.witnesses.includes('lenderTerms') && !m.lenderTerms && !m.terms) return 'Needs the lender terms (Lender terms card)';
  if (spec.witnesses.includes('kycAttestation') && !m.kycAttestation) return 'Needs a CASP KYC attestation (Compliance)';
  if (spec.witnesses.includes('vaultCoin') && !m.vaultCoin) return 'Needs the vault coin index (Funding → vault tracking)';
  if (spec.witnesses.includes('secondCoin') && needsSecondCoin(spec.circuit, v) && m.secondCoin === false) return 'Needs the loan or top-up coin index';
  if (spec.witnesses.includes('penaltyCoin') && m.penaltyCoin === false) return 'Needs the penalty coin index';
  return null;
};

/** Permissionless circuits shown on every role page. */
const OPEN_TO_ALL: PartyCircuit[] = ['expireEscrow', 'endTopUpWindow'];

/** Actions a role can see on its page, each with enabled / reason. Permissionless ones are shown to every role. */
export function availableActions(v: EscrowView, role: PartyRole, nowSec: bigint, material: LocalMaterial, which?: ContingencyName): AvailableAction[] {
  return Object.values(ACTIONS)
    .filter((a) => a.callers.includes(role) || (a.callers.includes('anyone') && OPEN_TO_ALL.includes(a.circuit)))
    .map((a) => {
      const reason = a.check(v, a.callers.includes(role) ? role : 'anyone', nowSec, which) ?? missingMaterial(a, material, v);
      return { circuit: a.circuit, enabled: reason === null, reason, irreversible: !!a.irreversible };
    });
}

/** Only what is enabled right now (the resolver workspace lists exactly these, §3.1.6). */
export const enabledActions = (v: EscrowView, role: PartyRole, nowSec: bigint, m: LocalMaterial): AvailableAction[] =>
  availableActions(v, role, nowSec, m).filter((a) => a.enabled);

/** FR-DISPUTE-03 / FR-AUDIT-02: the next deadline that matters in the current phase, if any. */
export function nextDeadline(v: EscrowView, nowSec?: bigint): { kind: 'closing' | 'dispute' | 'sellerKyc' | 'topUp' | 'coolingOff'; at: bigint } | null {
  // Cooling-off: until it ends, the buyer may withdraw with at most the penalty, and no release is possible.
  if (nowSec !== undefined && insideCoolingOff(v, nowSec) && ['Funded', 'ContingenciesPending', 'ReadyToClose', 'Disputed'].includes(v.status)) return { kind: 'coolingOff', at: v.coolingOff.end };
  switch (v.status) {
    case 'Created':
    case 'Funded':
      return { kind: 'closing', at: v.closingDeadline };
    case 'ContingenciesPending':
      if (v.financing.loanLost && v.financing.loanLostRefund && !v.financing.topUpHeld && v.financing.topUpWindowEnd < v.closingDeadline) return { kind: 'topUp', at: v.financing.topUpWindowEnd };
      return { kind: 'closing', at: v.closingDeadline };
    case 'Disputed':
    case 'ReadyToClose':
    case 'Settled':
      if (v.sellerKyc.verified && v.sellerKyc.validUntil < v.disputeDeadline && v.status !== 'Disputed') return { kind: 'sellerKyc', at: v.sellerKyc.validUntil };
      return { kind: 'dispute', at: v.disputeDeadline };
    default:
      return null;
  }
}

export type { Caller, PartyRole };
