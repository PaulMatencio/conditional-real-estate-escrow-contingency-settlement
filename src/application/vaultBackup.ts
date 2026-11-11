/**
 * Vault backup / restore (admin page → Vault tab). A backup is every vault record (one per escrow plus this browser's
 * envelope identity) and, optionally, the admin secret key, sealed as one passphrase-encrypted file.
 *
 * Restore never deletes and never silently overwrites: records are merged field by field; missing values are filled
 * in, lists are unioned, and when the backup disagrees with what this browser holds the current value is kept and the
 * difference reported (authority keys and envelope identities are kept in their history so nothing is lost).
 */
import type { VaultRecord } from './partyPorts';
import { ADMIN_RECORD, IDENTITY_RECORD, TXLOG_RECORD } from './partyPorts';
import { mergeTxLog } from './txLog';

export const BACKUP_FORMAT = 'EscrowVaultBackupV1';

export interface VaultBackup {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  /** Vault records by id: contract addresses, plus IDENTITY_RECORD for the envelope key pair. */
  records: Record<string, VaultRecord>;
  /** Admin console state (the admin secret key is otherwise kept outside the vault). */
  admin?: { secretKey?: string; contractAddress?: string };
}

export const isVaultBackup = (x: unknown): x is VaultBackup =>
  !!x && (x as VaultBackup).format === BACKUP_FORMAT && typeof (x as VaultBackup).records === 'object' && (x as VaultBackup).records !== null;

export interface BackupSummary {
  createdAt: string;
  contracts: { address: string; terms: boolean; custody: boolean; roleKeys: string[]; kyc: string[]; authorityKey: boolean; renounced: boolean; history: number }[];
  identity: boolean;
  adminKey: boolean;
  adminContract?: string;
  /** Entries in the transaction log. */
  txLog: number;
}

export function summarize(b: VaultBackup): BackupSummary {
  return {
    createdAt: b.createdAt,
    contracts: Object.entries(b.records)
      .filter(([id]) => id !== IDENTITY_RECORD && id !== ADMIN_RECORD && id !== TXLOG_RECORD)
      .map(([address, r]) => ({
        address,
        terms: !!r.terms,
        custody: !!r.custody,
        roleKeys: Object.keys(r.roleKeys ?? {}),
        kyc: Object.keys(r.kyc ?? {}),
        authorityKey: !!r.authorityKey,
        renounced: !!r.authorityRenouncedAt,
        history: r.history?.length ?? 0
      })),
    identity: !!b.records[IDENTITY_RECORD]?.identity,
    adminKey: !!b.records[ADMIN_RECORD]?.adminKey || !!b.admin?.secretKey,
    adminContract: b.admin?.contractAddress,
    txLog: b.records[TXLOG_RECORD]?.txLog?.length ?? 0
  };
}

/** The transaction log: union of both logs (an entry's most recent update wins). Returns how many entries were new. */
export function mergeTxLogRecord(current: VaultRecord, incoming: VaultRecord): { record: VaultRecord; added: number } {
  const before = new Set((current.txLog ?? []).map((e) => e.id));
  const txLog = mergeTxLog(current.txLog, incoming.txLog);
  return { record: { ...current, txLog }, added: txLog.filter((e) => !before.has(e.id)).length };
}

const unionBy = <T,>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string): T[] | undefined => {
  if (!a?.length && !b?.length) return a ?? b;
  const seen = new Map<string, T>();
  for (const x of [...(a ?? []), ...(b ?? [])]) if (!seen.has(key(x))) seen.set(key(x), x);
  return [...seen.values()];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Merges one backed-up record into the current one. Returns the merged record and what was kept or added. */
export function mergeRecord(current: VaultRecord, incoming: VaultRecord, label: string): { record: VaultRecord; added: string[]; conflicts: string[] } {
  const added: string[] = [];
  const conflicts: string[] = [];
  const out: VaultRecord = { ...current };

  if (incoming.terms) {
    if (!current.terms) (out.terms = incoming.terms), added.push('terms package');
    else if (!same(current.terms.terms, incoming.terms.terms) || current.terms.contractAddress !== incoming.terms.contractAddress) conflicts.push('terms package differs (kept the current one)');
    else if (current.terms.vaultIndex === undefined && incoming.terms.vaultIndex !== undefined) {
      out.terms = { ...current.terms, vaultIndex: incoming.terms.vaultIndex, depositTxHash: current.terms.depositTxHash ?? incoming.terms.depositTxHash };
      added.push('vault index');
    }
  }

  for (const [role, key] of Object.entries(incoming.roleKeys ?? {})) {
    const have = current.roleKeys?.[role];
    if (!have) (out.roleKeys = { ...(out.roleKeys ?? {}), [role]: key }), added.push(`${role} role key`);
    else if (have !== key) conflicts.push(`${role} role key differs (kept the current one)`);
  }

  for (const [role, bundle] of Object.entries(incoming.kyc ?? {}) as ['buyer' | 'seller', NonNullable<VaultRecord['kyc']>['buyer']][]) {
    if (!bundle) continue;
    const have = current.kyc?.[role];
    if (!have) (out.kyc = { ...(out.kyc ?? {}), [role]: bundle }), added.push(`${role} KYC attestation`);
    else if (have.reference !== bundle.reference) conflicts.push(`${role} KYC attestation differs (kept the current one)`);
  }

  if (incoming.authorityKey) {
    if (!current.authorityKey && !current.authorityRenouncedAt) (out.authorityKey = incoming.authorityKey), added.push('contract authority key');
    else if (current.authorityKey && current.authorityKey !== incoming.authorityKey) {
      conflicts.push('authority key differs (kept the current one, the backup copy is in the key history)');
      out.authorityKeyHistory = unionBy(out.authorityKeyHistory, [{ key: incoming.authorityKey, replacedAt: Date.now() }], (h) => h.key);
    }
  }
  out.authorityKeyHistory = unionBy(out.authorityKeyHistory, incoming.authorityKeyHistory, (h) => h.key);
  if (incoming.authorityRenouncedAt && !current.authorityRenouncedAt) out.authorityRenouncedAt = incoming.authorityRenouncedAt;

  if (incoming.custody) {
    if (!current.custody) (out.custody = incoming.custody), added.push('custodian copy of the terms');
    else if (!same(current.custody.terms.terms, incoming.custody.terms.terms)) conflicts.push('custodian copy differs (kept the current one)');
    else out.custody = { ...current.custody, handedOut: unionBy(current.custody.handedOut, incoming.custody.handedOut, (h) => `${h.at}:${h.to}`) };
  }

  out.roleKeyHistory = unionBy(current.roleKeyHistory, incoming.roleKeyHistory, (h) => `${h.role}:${h.key}`);
  out.backups = unionBy(current.backups, incoming.backups, (b) => `${b.at}:${b.kind}`);
  out.documents = unionBy(current.documents, incoming.documents, (d) => d.reportHash);
  out.history = unionBy(current.history, incoming.history, (h) => `${h.txHash}:${h.circuit}`)?.sort((a, b) => a.at - b.at);
  const histAdded = (out.history?.length ?? 0) - (current.history?.length ?? 0);
  if (histAdded > 0) added.push(`${histAdded} history entr${histAdded > 1 ? 'ies' : 'y'}`);

  return { record: out, added: added.map((a) => `${label}: ${a}`), conflicts: conflicts.map((c) => `${label}: ${c}`) };
}

/**
 * The envelope identity (X25519 key pair). A backup's identity replaces the current one only when the current one has
 * never been used (no escrow records yet), e.g. right after creating a vault in a new browser; otherwise the current
 * one is kept and the backup's goes to `identityHistory`, which is still tried when opening envelopes.
 */
export function mergeIdentity(current: VaultRecord, incoming: VaultRecord, currentHasEscrows: boolean): { record: VaultRecord; note: string | null } {
  const inc = incoming.identity;
  if (!inc) return { record: current, note: null };
  const cur = current.identity;
  if (!cur) return { record: { ...current, identity: inc }, note: 'envelope key restored' };
  if (cur.publicKey === inc.publicKey) return { record: current, note: null };
  if (!currentHasEscrows) {
    return { record: { ...current, identity: inc, identityHistory: unionBy(current.identityHistory, [cur], (k) => k.publicKey) }, note: 'envelope key restored (the one created in this browser is kept as a previous key)' };
  }
  return { record: { ...current, identityHistory: unionBy(current.identityHistory, [inc], (k) => k.publicKey) }, note: 'kept this browser’s envelope key; the backup’s is kept as a previous key and still opens envelopes sent to it' };
}

/**
 * The admin secret key (ADMIN_RECORD). Restored when this browser has none; otherwise the current key is kept and the
 * backup's goes to the history. Backups made before the key moved into the vault carry it in `admin.secretKey`.
 */
export function mergeAdmin(current: VaultRecord, backup: VaultBackup): { record: VaultRecord; note: string | null } {
  const inc = backup.records[ADMIN_RECORD];
  const incomingKeys = [inc?.adminKey, backup.admin?.secretKey].filter((k): k is string => !!k).map((k) => k.toLowerCase());
  const history = unionBy(current.adminKeyHistory, inc?.adminKeyHistory, (h) => h.key);
  if (!incomingKeys.length) return { record: { ...current, adminKeyHistory: history }, note: null };
  const [primary, ...others] = incomingKeys;
  if (!current.adminKey) {
    const extra = others.filter((k) => k !== primary).map((key) => ({ key, replacedAt: Date.now() }));
    return { record: { ...current, adminKey: primary, adminKeyHistory: unionBy(history, extra, (h) => h.key) }, note: 'admin secret key restored' };
  }
  const differing = incomingKeys.filter((k) => k !== current.adminKey).map((key) => ({ key, replacedAt: Date.now() }));
  if (!differing.length) return { record: { ...current, adminKeyHistory: history }, note: null };
  return {
    record: { ...current, adminKeyHistory: unionBy(history, differing, (h) => h.key) },
    note: 'the backup\u2019s admin key differs from this browser\u2019s: kept the current one (the backup\u2019s is in the admin key history)'
  };
}

export interface RestoreReport {
  contractsAdded: string[];
  contractsMerged: string[];
  added: string[];
  conflicts: string[];
  identity: string | null;
  admin: string | null;
  /** Transaction-log entries added from the backup. */
  txLogAdded: number;
}
