/**
 * Builds, seals, opens and applies vault backups (see application/vaultBackup.ts for the merge rules).
 * The file is AES-GCM encrypted with a backup passphrase (PBKDF2-SHA-256); it holds role keys, private terms,
 * attestations, authority keys and the envelope identity, so it must be kept as carefully as the vault itself.
 */
import { ADMIN_RECORD, IDENTITY_RECORD, TXLOG_RECORD, type Vault, type VaultRecord } from '@/application/partyPorts';
import { BACKUP_FORMAT, isVaultBackup, mergeAdmin, mergeIdentity, mergeRecord, mergeTxLogRecord, type RestoreReport, type VaultBackup } from '@/application/vaultBackup';
import { isSealedJson, openWithPassphrase, sealWithPassphrase, type SealedJson } from '../crypto/aead';

export const MIN_BACKUP_PASSPHRASE = 12;

/**
 * Who a backup or restore is for. 'admin' (admin page): everything. 'party' (party and notary pages): never the admin
 * secret key nor contract maintenance-authority keys — those belong on the admin page only, and a party's backup file
 * should not be able to change the contract's rules if it leaks.
 */
export type BackupScope = 'admin' | 'party';

/** Removes the contract authority key (and its history) from an escrow record. */
function withoutAuthorityKeys(r: VaultRecord): VaultRecord {
  const { authorityKey: _k, authorityKeyHistory: _h, ...rest } = r;
  return rest;
}
const holdsAuthorityKey = (r: VaultRecord) => !!r.authorityKey || !!r.authorityKeyHistory?.length;

/** Every vault record. `includeAdminKey: false` leaves out the admin secret key record; scope 'party' also drops authority keys. */
export async function exportVault(vault: Vault, opts: { includeAdminKey?: boolean; contractAddress?: string; scope?: BackupScope } = {}): Promise<VaultBackup> {
  if (!vault.unlocked) throw new Error('Unlock the vault first.');
  const party = opts.scope === 'party';
  const records: Record<string, VaultRecord> = {};
  for (const id of await vault.contracts()) {
    if (id === ADMIN_RECORD && (party || opts.includeAdminKey === false)) continue;
    const r = await vault.load(id);
    records[id] = party ? withoutAuthorityKeys(r) : r;
  }
  return { format: BACKUP_FORMAT, createdAt: new Date().toISOString(), records, admin: opts.contractAddress ? { contractAddress: opts.contractAddress } : undefined };
}

export async function sealBackup(backup: VaultBackup, passphrase: string): Promise<SealedJson & { kind: typeof BACKUP_FORMAT }> {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE) throw new Error(`Use a backup passphrase of at least ${MIN_BACKUP_PASSPHRASE} characters.`);
  return { ...(await sealWithPassphrase(backup, passphrase)), kind: BACKUP_FORMAT };
}

export async function openBackup(file: unknown, passphrase: string): Promise<VaultBackup> {
  if (!isSealedJson(file)) throw new Error('Not an encrypted vault backup file.');
  const b = await openWithPassphrase<unknown>(file, passphrase);
  if (!isVaultBackup(b)) throw new Error('This file is encrypted but is not a vault backup (it may be a terms package backup).');
  return b;
}

/** Merges a backup into the unlocked vault (records re-encrypted with the current vault key). Never deletes. */
export async function restoreVault(vault: Vault, backup: VaultBackup, opts: { scope?: BackupScope } = {}): Promise<RestoreReport> {
  if (!vault.unlocked) throw new Error('Unlock the vault first.');
  if (opts.scope === 'party') {
    // Party / notary page: admin material in the file is left out (and reported), everything else is merged as usual.
    const records: Record<string, VaultRecord> = {};
    let skipped = !!backup.records[ADMIN_RECORD] || !!backup.admin?.secretKey;
    for (const [id, r] of Object.entries(backup.records)) {
      if (id === ADMIN_RECORD) continue;
      if (holdsAuthorityKey(r)) skipped = true;
      records[id] = withoutAuthorityKeys(r);
    }
    const report = await restoreVault(vault, { ...backup, records, admin: undefined });
    return { ...report, adminSkipped: skipped };
  }
  const existing = new Set(await vault.contracts());
  const report: RestoreReport = { contractsAdded: [], contractsMerged: [], added: [], conflicts: [], identity: null, admin: null, txLogAdded: 0 };
  for (const [id, incoming] of Object.entries(backup.records)) {
    if (id === IDENTITY_RECORD || id === ADMIN_RECORD) continue;
    if (!/^[0-9a-f]{64}$/.test(id)) continue; // only escrow records; ignore anything unexpected
    const label = `${id.slice(0, 8)}…`;
    if (!existing.has(id)) {
      await vault.save(id, incoming);
      report.contractsAdded.push(id);
      continue;
    }
    const { record, added, conflicts } = mergeRecord(await vault.load(id), incoming, label);
    await vault.save(id, record);
    report.contractsMerged.push(id);
    report.added.push(...added);
    report.conflicts.push(...conflicts);
  }
  const incomingId = backup.records[IDENTITY_RECORD];
  if (incomingId) {
    const hadEscrows = [...existing].some((id) => id !== IDENTITY_RECORD && id !== ADMIN_RECORD && id !== TXLOG_RECORD);
    const { record, note } = mergeIdentity(await vault.load(IDENTITY_RECORD), incomingId, hadEscrows);
    await vault.save(IDENTITY_RECORD, record);
    report.identity = note;
  }
  if (backup.records[ADMIN_RECORD] || backup.admin?.secretKey) {
    const { record, note } = mergeAdmin(await vault.load(ADMIN_RECORD), backup);
    await vault.save(ADMIN_RECORD, record);
    report.admin = note;
  }
  if (backup.records[TXLOG_RECORD]?.txLog?.length) {
    const { record, added } = mergeTxLogRecord(await vault.load(TXLOG_RECORD), backup.records[TXLOG_RECORD]);
    await vault.save(TXLOG_RECORD, record);
    report.txLogAdded = added;
  }
  return report;
}
