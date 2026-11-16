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
  /** Who it was sealed for ('buyer', 'seller', 'notary', 'resolver' or a name), inside the encrypted part. */
  sealedFor?: string;
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

// ---------------------------------------------------------------- recipients of a report bundle (attestor side)

/** The usual recipients; the attestor can add others ("other:<slug>"). */
export const DEFAULT_BUNDLE_RECIPIENTS = ['buyer', 'seller', 'notary', 'resolver'] as const;

export interface BundleRecipient {
  /** 'buyer' | 'seller' | 'notary' | 'resolver' | `other:<slug>` */
  id: string;
  /** Display name for `other:` recipients (the defaults are translated by the UI). */
  label?: string;
  /** Envelope public key (base64 of a raw 32-byte X25519 key). Public: safe to keep in the vault. */
  key: string;
}

/** One bundle file produced for one recipient (the attestor's delivery record). */
export interface BundleExport {
  reportHash: string;
  recipient: string;
  at: number;
}

/** A base64 raw 32-byte X25519 public key, as shown on the recipients' cards. */
export const isEnvelopeKey = (s: string): boolean => /^[A-Za-z0-9+/]{43}=$/.test(s.trim());

/** Another recipient already saved with this key (pasting the seller's key into the buyer row, for example). */
export function recipientConflict(list: readonly BundleRecipient[], id: string, key: string): BundleRecipient | null {
  const k = key.trim();
  return (k && list.find((r) => r.id !== id && r.key === k)) || null;
}

export const recipientSlug = (label: string): string =>
  label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'recipient';

/** `title-bundle-for-buyer.json`, `inspection-bundle-for-bank-x.json`. */
export const bundleFileName = (contingency: ContingencyName, recipientId: string): string =>
  `${contingency.toLowerCase()}-bundle-for-${recipientId.startsWith('other:') ? recipientId.slice(6) : recipientId}.json`;

/** Saves or replaces one recipient's key, keeping the list order (defaults first, then others as added). */
export function upsertRecipient(list: readonly BundleRecipient[], r: BundleRecipient): BundleRecipient[] {
  const i = list.findIndex((x) => x.id === r.id);
  if (i < 0) return [...list, r];
  const next = list.slice();
  next[i] = r;
  return next;
}

/** The latest export of `reportHash` to each recipient. */
export function lastExports(exports: readonly BundleExport[] | undefined, reportHash: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of exports ?? []) if (e.reportHash === reportHash && (out[e.recipient] ?? 0) < e.at) out[e.recipient] = e.at;
  return out;
}
