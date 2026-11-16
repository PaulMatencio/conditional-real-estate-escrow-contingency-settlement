/**
 * Attestor report bundles (FR-ATTEST-02): the report file, its salt and its commitment, exported by the attestor for
 * the buyer, seller and notary. Pure: matching a computed commitment against the ledger.
 */
import type { ContingencyName, EscrowView } from './escrowView';
import { CONTINGENCIES } from './escrowView';

export interface DocumentBundle {
  format: 'EscrowDocumentBundleV1';
  contractAddress?: string;
  contingency: ContingencyName;
  fileName: string;
  /** 64-hex salt of the commitment. */
  salt: string;
  /** The commitment the attestor anchored on-chain. */
  reportHash: string;
  /** The report itself, base64. */
  document: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function isDocumentBundle(x: unknown): x is DocumentBundle {
  const b = x as DocumentBundle | null;
  return (
    !!b &&
    b.format === 'EscrowDocumentBundleV1' &&
    (CONTINGENCIES as readonly string[]).includes(b.contingency) &&
    typeof b.fileName === 'string' &&
    typeof b.salt === 'string' &&
    HEX64.test(b.salt) &&
    typeof b.reportHash === 'string' &&
    HEX64.test(b.reportHash) &&
    typeof b.document === 'string'
  );
}

export type ReportMatch =
  /** The report is the one anchored for this contingency now. */
  | { kind: 'current'; contingency: ContingencyName; submitted: boolean; passed: boolean }
  /** It matches a result the resolver voided during a dispute. */
  | { kind: 'voided'; contingency?: ContingencyName }
  /** It matches nothing on this escrow. */
  | { kind: 'none' };

/**
 * Where `commitment` (recomputed locally from the report bytes and the salt) appears on the ledger. The bundle's own
 * `reportHash` is never trusted: only the recomputed value counts.
 */
export function matchReport(view: Pick<EscrowView, 'contingencies' | 'voidedReportHistory'>, commitment: string, claimed?: ContingencyName): ReportMatch {
  const h = commitment.toLowerCase();
  const order = claimed ? [claimed, ...CONTINGENCIES.filter((c) => c !== claimed)] : [...CONTINGENCIES];
  for (const c of order) {
    const s = view.contingencies[c];
    if (s.reportHash.toLowerCase() === h && !/^0*$/.test(h)) return { kind: 'current', contingency: c, submitted: s.submitted, passed: s.passed };
  }
  if (view.voidedReportHistory.some((v) => v.reportHash.toLowerCase() === h)) return { kind: 'voided', contingency: claimed };
  return { kind: 'none' };
}
