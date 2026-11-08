/**
 * Builds, seals, opens and applies vault backups (see application/vaultBackup.ts for the merge rules).
 * The file is AES-GCM encrypted with a backup passphrase (PBKDF2-SHA-256); it holds role keys, private terms,
 * attestations, authority keys and the envelope identity, so it must be kept as carefully as the vault itself.
 */
import { IDENTITY_RECORD, type Vault, type VaultRecord } from '@/application/partyPorts';
import { BACKUP_FORMAT, isVaultBackup, mergeIdentity, mergeRecord, type RestoreReport, type VaultBackup } from '@/application/vaultBackup';
import { isSealedJson, openWithPassphrase, sealWithPassphrase, type SealedJson } from '../crypto/aead';

export const MIN_BACKUP_PASSPHRASE = 12;

export async function exportVault(vault: Vault, admin?: VaultBackup['admin']): Promise<VaultBackup> {
  if (!vault.unlocked) throw new Error('Unlock the vault first.');
  const records: Record<string, VaultRecord> = {};
  for (const id of await vault.contracts()) records[id] = await vault.load(id);
  return { format: BACKUP_FORMAT, createdAt: new Date().toISOString(), records, admin: admin && (admin.secretKey || admin.contractAddress) ? admin : undefined };
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
export async function restoreVault(vault: Vault, backup: VaultBackup): Promise<Omit<RestoreReport, 'admin'>> {
  if (!vault.unlocked) throw new Error('Unlock the vault first.');
  const existing = new Set(await vault.contracts());
  const report: Omit<RestoreReport, 'admin'> = { contractsAdded: [], contractsMerged: [], added: [], conflicts: [], identity: null };
  for (const [id, incoming] of Object.entries(backup.records)) {
    if (id === IDENTITY_RECORD) continue;
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
    const hadEscrows = [...existing].some((id) => id !== IDENTITY_RECORD);
    const { record, note } = mergeIdentity(await vault.load(IDENTITY_RECORD), incomingId, hadEscrows);
    await vault.save(IDENTITY_RECORD, record);
    report.identity = note;
  }
  return report;
}
