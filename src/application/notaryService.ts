/**
 * Notary & Land Registry Verification (FR-NOTARY-01..03): read-only, no wallet. Builds the EU notarial escrow
 * certificate as a JSON proof bundle (the printable page is rendered by the presentation layer). Openings are
 * verified locally and only their verdicts — never the salts — go into the bundle.
 */
import { CONTINGENCIES, authorityLevel, fundsLocked, type EscrowView } from '@/domain/escrowView';
import type { Opening } from '@/domain/terms';
import { verifyOpening, type TermsCrypto } from './termsService';

export interface NotaryCertificate {
  format: 'EuNotarialEscrowCertificateV2';
  generatedAt: string;
  network: string;
  contractAddress: string;
  observed: { blockHeight?: number; blockHash?: string; stateRoot?: string; lifecycleRound: string };
  status: string;
  disbursed: boolean;
  /** Whether the contract's rules can still be changed (maintenance authority). */
  maintenanceAuthority: { level: string; committeeSize?: number; threshold?: number; counter?: string };
  lockedFunds: { locked: boolean; statement: string };
  token: { color: string; ticker: string };
  commitments: EscrowView['commitments'];
  /** v2: how the price is funded and where the second coin (loan or buyer top-up) stands. Amounts only via openings. */
  financing: {
    mode: string | null;
    loanHeld: boolean;
    topUpHeld: boolean;
    loanLost: boolean;
    loanWithdrawn: boolean;
    /** Public only once the loan was lost; otherwise "undisclosed" unless a loanTerms opening was verified. */
    refundTerm: 'on' | 'off' | 'undisclosed';
    loanOfferExpiry: string;
    topUpWindowEnd: string | null;
    buyerCoinPaid: boolean;
    secondCoinPaid: boolean;
  };
  /** Cooling-off period: public length and end; the penalty itself only via a coolingOff opening. */
  coolingOff: {
    /** Days; 0 = no cooling-off period. */
    days: number;
    /** Unix seconds, null when off or before the deposit. */
    end: string | null;
    buyerWithdrew: boolean;
    /** Verified from a coolingOff opening ("none" = rate 0), else "undisclosed". */
    penalty: string;
    penaltyDue: boolean;
    penaltyPaid: boolean;
  };
  verifiedOpenings: { kind: Opening['kind']; ok: boolean; detail: string }[];
  kyc: {
    buyer: { verified: boolean; issuerId: string; ref: string; travelRuleRef: string };
    seller: { verified: boolean; issuerId: string; ref: string; travelRuleRef: string; validUntil: string };
    trustedIssuers: string[];
    revokedRefs: string[];
  };
  contingencies: { name: string; submitted: boolean; passed: boolean; waived: boolean; reportHash: string }[];
  voidedReportHistory: { index: string; reportHash: string }[];
  transactions: { circuit?: string; txHash: string; blockHeight?: number }[];
  disclaimer: string;
}

export function lockedFundsStatement(v: EscrowView): { locked: boolean; statement: string } {
  const f = v.financing;
  const loan = f.mode === 'Deposited';
  const second = f.loanHeld && !f.secondCoinPaid ? ' The lender\'s loan coin (exactly the committed loan amount) is held too.' : f.topUpHeld && !f.secondCoinPaid ? ' The buyer\'s top-up coin (exactly the committed loan amount) is held too.' : '';
  if (fundsLocked(v)) {
    const what = loan ? 'the committed buyer deposit' : 'the committed amount (the whole price in a cash deal)';
    const missing = loan && !f.loanHeld && !f.topUpHeld ? ' The loan amount is not deposited yet: the seller cannot be paid until it is (by the lender, or by the buyer as a top-up).' : '';
    return {
      locked: true,
      statement: `The contract only accepts deposit coins equal to their committed amounts (ERROR_DEPOSIT_COIN_MISMATCH / ERROR_LOAN_COIN_MISMATCH / ERROR_TOPUP_COIN_MISMATCH otherwise). Status ${v.status} with nothing paid out proves ${what} is locked in the contract.${second}${missing}`
    };
  }
  if (v.status === 'Refunded' || v.status === 'Expired') return { locked: true, statement: `Funds are still held but are only payable back to whoever deposited them (status ${v.status}).${second}` };
  if (v.status === 'Forfeited') {
    return v.coolingOff.buyerWithdrew
      ? { locked: true, statement: `The buyer withdrew after the cooling-off period (or with none): the buyer deposit is payable only to the seller.${second ? ' Any loan or top-up coin goes back to whoever deposited it.' : ''}` }
      : { locked: true, statement: 'The loan was lost, the loan refusal refund term is off and the buyer did not replace the loan before the closing deadline: the buyer deposit is payable only to the seller.' };
  }
  if (v.status === 'Withdrawn') {
    return {
      locked: true,
      statement: `The buyer withdrew inside the cooling-off period: the buyer deposit minus the committed penalty is payable only to the buyer, and the penalty only to the seller.${v.financing.buyerCoinPaid ? (v.coolingOff.penaltyDue && !v.coolingOff.penaltyPaid ? ' The buyer was refunded; the penalty is still held for the seller.' : ' The buyer was refunded.') : ''}${second ? ' Any loan or top-up coin goes back to whoever deposited it.' : ''}`
    };
  }
  if (v.status === 'Closed') return { locked: false, statement: 'Funds were disbursed; the escrow is closed.' };
  return { locked: false, statement: `No funds are locked (status ${v.status}).` };
}

/** The refund term: from the ledger once the loan was lost, else from a verified loanTerms opening. */
function refundTermOf(crypto: TermsCrypto, view: EscrowView, openings: Opening[]): 'on' | 'off' | 'undisclosed' {
  if (view.financing.loanLost) return view.financing.loanLostRefund ? 'on' : 'off';
  const o = openings.find((x) => x.kind === 'loanTerms');
  if (o && o.kind === 'loanTerms' && verifyOpening(crypto, o, view).ok) return o.refundOnLoss ? 'on' : 'off';
  return 'undisclosed';
}

/** The cooling-off penalty, from a verified coolingOff opening. */
function penaltyOf(crypto: TermsCrypto, view: EscrowView, openings: Opening[]): string {
  if (view.coolingOff.period === 0n) return 'none';
  const o = openings.find((x) => x.kind === 'coolingOff');
  if (!o || o.kind !== 'coolingOff' || !verifyOpening(crypto, o, view).ok) return 'undisclosed';
  return BigInt(o.penaltyRate) === 0n ? 'none' : `${(Number(o.penaltyRate) / 100).toString()} % = ${o.penalty} ${view.escrowTicker}`;
}

export function buildCertificate(
  crypto: TermsCrypto,
  view: EscrowView,
  input: { network: string; openings: Opening[]; transactions?: NotaryCertificate['transactions']; blockHeight?: number; blockHash?: string; stateRoot?: string; now?: Date }
): NotaryCertificate {
  return {
    format: 'EuNotarialEscrowCertificateV2',
    generatedAt: (input.now ?? new Date()).toISOString(),
    network: input.network,
    contractAddress: view.contractAddress,
    observed: { blockHeight: input.blockHeight, blockHash: input.blockHash, stateRoot: input.stateRoot, lifecycleRound: view.lifecycleRound.toString() },
    status: view.status,
    disbursed: view.disbursed,
    maintenanceAuthority: { level: authorityLevel(view.maintenance), ...(view.maintenance ?? {}) },
    lockedFunds: lockedFundsStatement(view),
    token: { color: view.escrowColor, ticker: view.escrowTicker },
    commitments: view.commitments,
    financing: {
      mode: view.financing.mode,
      loanHeld: view.financing.loanHeld,
      topUpHeld: view.financing.topUpHeld,
      loanLost: view.financing.loanLost,
      loanWithdrawn: view.financing.loanWithdrawn,
      refundTerm: refundTermOf(crypto, view, input.openings),
      loanOfferExpiry: view.financing.loanOfferExpiry.toString(),
      topUpWindowEnd: view.financing.loanLost && view.financing.loanLostRefund ? view.financing.topUpWindowEnd.toString() : null,
      buyerCoinPaid: view.financing.buyerCoinPaid,
      secondCoinPaid: view.financing.secondCoinPaid
    },
    coolingOff: {
      days: Number(view.coolingOff.period / 86_400n),
      end: view.coolingOff.end > 0n ? view.coolingOff.end.toString() : null,
      buyerWithdrew: view.coolingOff.buyerWithdrew,
      penalty: penaltyOf(crypto, view, input.openings),
      penaltyDue: view.coolingOff.penaltyDue,
      penaltyPaid: view.coolingOff.penaltyPaid
    },
    verifiedOpenings: input.openings.map((o) => ({ kind: o.kind, ...verifyOpening(crypto, o, view) })),
    kyc: {
      buyer: view.buyerKyc,
      seller: { ...view.sellerKyc, validUntil: view.sellerKyc.validUntil.toString() },
      trustedIssuers: view.kycIssuers.map((i) => i.issuerId),
      revokedRefs: view.revokedKycRefs
    },
    contingencies: CONTINGENCIES.map((c) => ({ name: c, ...view.contingencies[c] })),
    voidedReportHistory: view.voidedReportHistory.map((h) => ({ index: h.index.toString(), reportHash: h.reportHash })),
    transactions: input.transactions ?? [],
    disclaimer:
      'Generated locally from public Midnight ledger state. Openings were verified in the browser and are not included. Apply a qualified electronic seal or signature (eIDAS) to make this certificate legally effective.'
  };
}
