/**
 * Which circuit may run now, for whom, and why not. A pure mirror of the contract's phase / role / deadline
 * asserts, used to render only the actions valid in the current state (§3.1.6 AC-1) with their preconditions,
 * and as a cheap pre-flight before proving (FR-FUND-04). The contract stays the authority: this table only
 * avoids sending transactions that are bound to fail.
 */
import { CONTINGENCIES, allCleared, anyFailed, hasUsableSellerKyc, isFullyConfigured, type ContingencyName, type EscrowView, type StatusName } from './escrowView';
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
  | 'revokeKycAttestation'
  | 'revokeKycIssuer';

export type Witness = 'localSecretKey' | 'privateTerms' | 'kycAttestation' | 'vaultCoin';

/** Local, private material the caller's browser holds (never on-chain). */
export interface LocalMaterial {
  terms: boolean;
  kycAttestation: boolean;
  vaultCoin: boolean;
}

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
    witnesses: ['localSecretKey'],
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
    check: (v) => phase(v, 'Seller KYC cannot be submitted in current state', 'Created', 'Funded', 'ContingenciesPending', 'ReadyToClose', 'Disputed', 'Settled')
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
    check: (v) => first(phase(v, 'Not in contingency review', 'ContingenciesPending'), v.contingencies.Financing.submitted ? 'Financing outcome already submitted' : null)
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
      const c = v.contingencies[contingencyKey(which)];
      return c.submitted && c.passed ? `${which} already cleared` : null;
    }
  },
  cancelAndRefund: {
    circuit: 'cancelAndRefund',
    callers: ['buyer'],
    witnesses: ['localSecretKey'],
    irreversible: true,
    check: (v) => first(phase(v, 'Escrow is not in contingency review', 'ContingenciesPending'), anyFailed(v) ? null : 'No submitted contingency has failed')
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
    witnesses: ['localSecretKey', 'privateTerms', 'vaultCoin'],
    irreversible: true,
    check: (v, caller, now) =>
      first(
        phase(v, 'Escrow is not releasable to seller', 'ReadyToClose', 'Settled'),
        v.disbursed ? 'Funds already disbursed' : null,
        v.status === 'ReadyToClose' && caller !== 'buyer' && caller !== 'seller' ? 'Caller is not buyer or seller' : null,
        v.status === 'Settled' && caller !== 'resolver' ? 'Caller is not the dispute resolver' : null,
        v.sellerKyc.verified ? null : 'ERROR_SELLER_KYC_REQUIRED',
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
    check: (v) => first(phase(v, 'Escrow is not refundable', 'Refunded', 'Expired'), v.disbursed ? 'Funds already disbursed' : null)
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

const missingMaterial = (spec: ActionSpec, m: LocalMaterial): string | null => {
  if (spec.witnesses.includes('privateTerms') && !m.terms) return 'Needs the private terms package (Terms vault)';
  if (spec.witnesses.includes('kycAttestation') && !m.kycAttestation) return 'Needs a CASP KYC attestation (Compliance)';
  if (spec.witnesses.includes('vaultCoin') && !m.vaultCoin) return 'Needs the vault coin index (Funding → vault tracking)';
  return null;
};

/** Actions a role can see on its page, each with enabled / reason. Permissionless ones are shown to every role. */
export function availableActions(v: EscrowView, role: PartyRole, nowSec: bigint, material: LocalMaterial, which?: ContingencyName): AvailableAction[] {
  return Object.values(ACTIONS)
    .filter((a) => a.callers.includes(role) || (a.callers.includes('anyone') && a.circuit === 'expireEscrow'))
    .map((a) => {
      const reason = a.check(v, a.callers.includes(role) ? role : 'anyone', nowSec, which) ?? missingMaterial(a, material);
      return { circuit: a.circuit, enabled: reason === null, reason, irreversible: !!a.irreversible };
    });
}

/** Only what is enabled right now (the resolver workspace lists exactly these, §3.1.6). */
export const enabledActions = (v: EscrowView, role: PartyRole, nowSec: bigint, m: LocalMaterial): AvailableAction[] =>
  availableActions(v, role, nowSec, m).filter((a) => a.enabled);

/** FR-DISPUTE-03 / FR-AUDIT-02: the next deadline that matters in the current phase, if any. */
export function nextDeadline(v: EscrowView): { kind: 'closing' | 'dispute' | 'sellerKyc'; at: bigint } | null {
  switch (v.status) {
    case 'Created':
    case 'Funded':
    case 'ContingenciesPending':
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
