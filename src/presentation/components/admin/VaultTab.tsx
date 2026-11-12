'use client';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert } from '../ui';
import { RestoreIntoNewVault, VaultBackupCards } from '../vault/VaultBackup';
import type { VaultBackup } from '@/application/vaultBackup';

/**
 * Vault backup / restore (admin page). Backup: every vault record (all escrows, the envelope identity) and optionally
 * the admin secret key, sealed with a separate backup passphrase. Restore: decrypt, preview, then merge — never deletes.
 */
export function VaultTab() {
  const { t } = useT();
  const { adminKey, contractAddress, loadContract } = useApp();
  const { vaultUnlocked, vaultExists } = useEscrow();
  const reopen = async (b: VaultBackup) => {
    if (!contractAddress && b.admin?.contractAddress) await loadContract(b.admin.contractAddress);
  };
  return (
    <div className="space-y-4">
      {/* The vault is created / unlocked with the card at the top of the admin page; here only when none exists yet. */}
      {vaultExists === false && <RestoreIntoNewVault scope="admin" onRestored={reopen} />}
      {vaultExists && !vaultUnlocked && <Alert tone="warn">{t('vaultBackup.unlockFirst')}</Alert>}
      <VaultBackupCards scope="admin" contractAddress={contractAddress} adminKey={!!adminKey} onRestored={reopen} />
    </div>
  );
}
