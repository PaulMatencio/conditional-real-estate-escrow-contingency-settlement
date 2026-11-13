/**
 * Escrow directory metadata: a human name, a test case and a description for each escrow this browser knows. Kept in
 * the encrypted vault record (never on-chain, never sent to a server) and carried, optionally, inside the encrypted
 * terms packages so every party's vault shows the same name. Not part of any commitment.
 */
/** What travels inside a terms package, lender package or custodian copy. */
export interface WireMeta {
  label: string;
  caseId?: string;
  description?: string;
  tags?: string[];
}

export type MetaSource = 'deployed' | 'package' | 'manual';
export type MetaNetwork = 'preview' | 'preprod' | 'simulator' | string;

/** Stored on each vault record (VaultRecord.meta). */
export interface EscrowMeta extends WireMeta {
  network?: MetaNetwork;
  /** First seen in this vault (ms). */
  createdAt: number;
  source: MetaSource;
  /** The owner of this vault renamed it: a later package import keeps the local name. */
  renamed?: boolean;
  /** Hidden from the switcher's active list; the record and its keys stay in the vault. */
  archived?: boolean;
  /** Status read the last time the switcher refreshed (public ledger), for the list. */
  lastStatus?: string;
  lastOpenedAt?: number;
}

export const LABEL_MAX = 80;
export const CASE_ID_MAX = 16;
export const DESCRIPTION_MAX = 1000;
export const TAG_MAX = 24;
export const TAGS_MAX = 8;

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Normalizes user or package input: trims, caps lengths, drops control characters and duplicate tags. */
export function normalizeWireMeta(m: Partial<WireMeta> | undefined | null): WireMeta | null {
  if (!m || typeof m !== 'object') return null;
  const label = clean(m.label, LABEL_MAX);
  if (!label) return null;
  const caseId = clean(m.caseId, CASE_ID_MAX).toUpperCase() || undefined;
  const description = (m.description ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, DESCRIPTION_MAX) || undefined;
  const tags = Array.isArray(m.tags)
    ? [...new Set(m.tags.map((t) => clean(String(t), TAG_MAX).toLowerCase()).filter(Boolean))].slice(0, TAGS_MAX)
    : undefined;
  return { label, caseId, description, tags: tags?.length ? tags : undefined };
}

/** The part of the local metadata that goes into a package. */
export const wireMetaOf = (m: EscrowMeta | undefined): WireMeta | undefined => (m ? (normalizeWireMeta(m) ?? undefined) : undefined);

/**
 * A package was imported: adopt its name unless this vault's owner renamed the escrow. Fills in a missing local
 * record (source "package"); keeps archived / status / timestamps.
 */
export function mergeImportedMeta(current: EscrowMeta | undefined, incoming: Partial<WireMeta> | undefined, now: number): EscrowMeta | undefined {
  const wire = normalizeWireMeta(incoming);
  if (!wire) return current;
  if (current?.renamed) return current;
  if (current && current.label === wire.label && current.caseId === wire.caseId && current.description === wire.description && JSON.stringify(current.tags) === JSON.stringify(wire.tags)) return current;
  return { ...(current ?? { createdAt: now, source: 'package' as const }), ...wire };
}

/** The name shown for an escrow, also when it has no metadata. */
export const displayLabel = (address: string, m?: EscrowMeta): string => m?.label || `Unnamed escrow ${address.slice(0, 4)}…${address.slice(-4)}`;

export interface DirectoryEntry {
  address: string;
  meta?: EscrowMeta;
  /** Roles whose secret key this vault holds for the escrow (admin when it deployed or holds the authority key). */
  roles: string[];
  hasTerms: boolean;
}

/** "T07 · run 2" when the same case ID was deployed more than once (runs ordered by first-seen time). */
export function runLabels(entries: DirectoryEntry[]): Record<string, string> {
  const byCase = new Map<string, DirectoryEntry[]>();
  for (const e of entries) {
    const c = e.meta?.caseId;
    if (c) byCase.set(c, [...(byCase.get(c) ?? []), e]);
  }
  const out: Record<string, string> = {};
  for (const [c, list] of byCase) {
    const sorted = [...list].sort((a, b) => (a.meta?.createdAt ?? 0) - (b.meta?.createdAt ?? 0));
    sorted.forEach((e, i) => (out[e.address] = sorted.length > 1 ? `${c} · run ${i + 1}` : c));
  }
  return out;
}

/** Free-text search over label, case, tags, description and address. */
export function matchesSearch(e: DirectoryEntry, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const m = e.meta;
  return [m?.label, m?.caseId, m?.description, ...(m?.tags ?? []), e.address].some((v) => v?.toLowerCase().includes(s));
}

/** Most recently opened first, then most recently created. */
export const sortEntries = (a: DirectoryEntry, b: DirectoryEntry): number =>
  (b.meta?.lastOpenedAt ?? 0) - (a.meta?.lastOpenedAt ?? 0) || (b.meta?.createdAt ?? 0) - (a.meta?.createdAt ?? 0) || a.address.localeCompare(b.address);
