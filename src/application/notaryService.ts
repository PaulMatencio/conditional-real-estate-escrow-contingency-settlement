/**
 * Notary & Land Registry Verification (FR-NOTARY-01..03): read-only, no wallet. Builds the EU notarial escrow
 * certificate as a JSON proof bundle (the printable page is rendered by the presentation layer). Openings are
 * verified locally and only their verdicts — never the salts — go into the bundle.
 */
import { CONTINGENCIES, authorityLevel, fundsLocked, type EscrowView } from '@/domain/escrowView';
import type { Opening } from '@/domain/terms';
import { verifyOpening, type TermsCrypto } from './termsService';

export interface NotaryCertificate {
  format: 'EuNotarialEscrowCertificateV1';
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
  if (fundsLocked(v)) {
    return {
      locked: true,
      statement: `The contract only accepts a deposit coin equal to the committed amount (depositToEscrow asserts ERROR_DEPOSIT_COIN_MISMATCH otherwise). Status ${v.status} with disbursed = false proves the committed amount is locked in the contract.`
    };
  }
  if (v.status === 'Refunded' || v.status === 'Expired') return { locked: true, statement: `Funds are still held but are only payable back to the buyer (status ${v.status}).` };
  if (v.status === 'Closed') return { locked: false, statement: 'Funds were disbursed; the escrow is closed.' };
  return { locked: false, statement: `No funds are locked (status ${v.status}).` };
}

export function buildCertificate(
  crypto: TermsCrypto,
  view: EscrowView,
  input: { network: string; openings: Opening[]; transactions?: NotaryCertificate['transactions']; blockHeight?: number; blockHash?: string; stateRoot?: string; now?: Date }
): NotaryCertificate {
  return {
    format: 'EuNotarialEscrowCertificateV1',
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
