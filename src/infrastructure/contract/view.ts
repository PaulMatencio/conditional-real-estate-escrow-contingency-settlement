import { bytesToHex } from '@/domain/hex';
import { CONTINGENCIES, FINANCING_MODES, INIT_ATTRIBUTES, STATUS, isZeroHex, type EscrowView, type MaintenanceStatus } from '@/domain/escrowView';
import { InitAttribute, ledger, type Ledger } from './module';

export type LedgerInput = Parameters<typeof ledger>[0];

/** Decodes the contract's public ledger state into the framework-free EscrowView (chain, simulator and notary share it). */
/** Reads committee size, threshold and counter from a ContractState's maintenance authority (any runtime copy). */
export function maintenanceOf(state: unknown): MaintenanceStatus | null {
  const a = (state as { maintenanceAuthority?: { committee: unknown[]; threshold: number; counter: bigint } } | null)?.maintenanceAuthority;
  if (!a) return null;
  return { committeeSize: a.committee.length, threshold: Number(a.threshold), counter: a.counter.toString() };
}

export function toEscrowView(contractAddress: string, data: LedgerInput, maintenance: MaintenanceStatus | null = null): EscrowView {
  const L: Ledger = ledger(data);
  const h = bytesToHex;
  const configured = new Set([...L.configured]);
  const has = (a: keyof typeof InitAttribute) => configured.has(InitAttribute[a]);
  const commit = (b: Uint8Array) => (isZeroHex(h(b)) ? null : h(b));
  return {
    contractAddress,
    maintenance,
    status: STATUS[L.status] ?? 'Initializing',
    lifecycleRound: L.lifecycleRound,
    correctionCount: L.correctionCount,
    disbursed: L.disbursed,
    configVersion: L.configVersion,
    buyerAccepted: L.buyerAccepted,
    sellerAccepted: L.sellerAccepted,
    configured: INIT_ATTRIBUTES.filter((a) => has(a)),
    roles: {
      admin: h(L.adminId),
      buyer: h(L.buyerId),
      seller: h(L.sellerId),
      inspector: has('Inspector') ? h(L.inspectorId) : null,
      lender: has('Lender') ? h(L.lenderId) : null,
      titleAgent: has('TitleAgent') ? h(L.titleAgentId) : null,
      resolver: has('Resolver') ? h(L.resolverId) : null
    },
    escrowColor: h(L.escrowColor),
    escrowTicker: L.escrowTicker,
    commitments: {
      amount: has('EscrowAmount') ? commit(L.amountCommitment) : null,
      buyerPayout: has('BuyerPayout') ? commit(L.buyerPayoutCommitment) : null,
      sellerPayout: has('SellerPayout') ? commit(L.sellerPayoutCommitment) : null,
      price: has('Price') ? commit(L.priceCommitment) : null,
      lenderShare: has('LenderShare') ? commit(L.lenderShareCommitment) : null,
      lenderPayout: has('LenderPayout') ? commit(L.lenderPayoutCommitment) : null,
      loanTerms: has('LoanTerms') ? commit(L.loanTermsCommitment) : null,
      coolingOff: has('CoolingOffTerms') ? commit(L.coolingOffCommitment) : null
    },
    financing: {
      mode: has('Financing') ? (FINANCING_MODES[L.financingMode] ?? null) : null,
      loanOfferExpiry: L.loanOfferExpiry,
      topUpWindow: L.topUpWindow,
      loanHeld: L.loanHeld,
      topUpHeld: L.topUpHeld,
      loanLost: L.loanLost,
      loanWithdrawn: L.loanWithdrawn,
      loanLostRefund: L.loanLostRefund,
      topUpWindowEnd: L.topUpWindowEnd,
      buyerCoinPaid: L.buyerCoinPaid,
      secondCoinPaid: L.secondCoinPaid
    },
    coolingOff: {
      period: L.coolingOffPeriod,
      end: L.coolingOffEnd,
      buyerWithdrew: L.buyerWithdrew,
      penaltyDue: L.penaltyDue,
      penaltyPaid: L.penaltyPaid
    },
    closingDeadline: L.closingDeadline,
    disputeDeadline: L.disputeDeadline,
    kycIssuers: [...L.kycIssuers].map(([id, pk]) => ({ issuerId: h(id), publicKey: { x: pk.x.toString(), y: pk.y.toString() } })),
    revokedKycRefs: [...L.revokedKycRefs].map(h),
    kycPolicy: { minKycLevel: Number(L.kycPolicy.minKycLevel), maxAmlRiskScore: Number(L.kycPolicy.maxAmlRiskScore) },
    buyerKyc: { verified: L.buyerKycVerified, issuerId: h(L.buyerKycIssuer), ref: h(L.buyerKycRef), travelRuleRef: h(L.buyerTravelRuleRef) },
    sellerKyc: {
      verified: L.sellerKycVerified,
      issuerId: h(L.sellerKycIssuer),
      ref: h(L.sellerKycRef),
      travelRuleRef: h(L.sellerTravelRuleRef),
      validUntil: L.sellerKycValidUntil
    },
    contingencies: {
      Inspection: { submitted: L.inspectionSubmitted, passed: L.inspectionPassed, waived: L.inspectionWaived, reportHash: h(L.inspectionReport) },
      Financing: { submitted: L.financingSubmitted, passed: L.financingApproved, waived: L.financingWaived, reportHash: h(L.financingLetter) },
      Title: { submitted: L.titleSubmitted, passed: L.titleCleared, waived: L.titleWaived, reportHash: h(L.titleCommitment) }
    },
    voidedReportHistory: [...L.voidedReportHistory].map(([index, hash]) => ({ index, reportHash: h(hash) })).sort((a, b) => (a.index < b.index ? -1 : 1))
  };
}

export { CONTINGENCIES };
