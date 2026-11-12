'use client';
import { useState } from 'react';
import type { PartyRole } from '@/domain/roles';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert } from '../ui';
import { ProgressPanel } from '../ProgressPanel';
import { useApp } from '../../providers/AppProvider';
import { ActionsPanel } from './ActionsPanel';
import { AttestorPanel } from './AttestorPanel';
import { FundingPanel, SettlementPanel, VaultTrackingCard } from './CustodyPanel';
import { KycPanel } from './KycPanel';
import { ModeBar, PayoutKeyCard, RoleKeyCard, VaultGate } from './PartySetup';
import { StatusOverview } from './StatusOverview';
import { TermsPanel } from './TermsPanel';
import { TimelinePanel } from './TimelinePanel';
import { TxLogPanel } from '../TxLogPanel';
import { VaultBackupSection, backupEscrows } from '../vault/VaultBackup';

/**
 * One page per role (plan.md, primary goal 2). Same shell everywhere — mode, vault, role key, status, actions,
 * timeline — plus the panels that role needs. Roles that share a key can switch without leaving the page.
 */
export function PartyWorkspace({ role: initial }: { role: Exclude<PartyRole, 'admin'> }) {
  const { t } = useT();
  const { view, now, error, setError, vaultUnlocked, contractAddress, setContractAddress, mode } = useEscrow();
  const { progress } = useApp();
  const [role, setRole] = useState<PartyRole>(initial);

  return (
    <main id="main" className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-white">{t(`page.${initial}.title` as MessageKey)}</h1>
          <p className="text-sm text-slate-400">{t(`page.${initial}.subtitle` as MessageKey)}</p>
        </div>
      </div>
      <VaultGate whenMissing={<Alert tone="warn">{t('vaultBackup.orRestore')}</Alert>} />
      <VaultBackupSection
        contractAddress={contractAddress}
        onRestored={async (b) => {
          // A backup of a single escrow on a page with none loaded: open it.
          const ids = backupEscrows(b);
          if (!contractAddress && ids.length === 1) await setContractAddress(ids[0]);
        }}
      />
      <ModeBar />
      {error && (
        <Alert tone="bad" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {progress && <ProgressPanel progress={progress} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <RoleKeyCard role={role} onRoleChange={setRole} />
          {(role === 'buyer' || role === 'seller') && <PayoutKeyCard party={role} />}
          {view && <ActionsPanel role={role} onlyEnabled={role === 'resolver'} />}
          {view && role === 'inspector' && <AttestorPanel contingency="Inspection" />}
          {view && role === 'lender' && <AttestorPanel contingency="Financing" />}
          {view && role === 'titleAgent' && <AttestorPanel contingency="Title" />}
          {vaultUnlocked && (role === 'buyer' || role === 'seller' || role === 'resolver') && <TermsPanel />}
          {view && vaultUnlocked && (role === 'buyer' || role === 'seller') && <KycPanel party={role} />}
          {view && vaultUnlocked && role === 'buyer' && view.status !== 'Initializing' && <FundingPanel />}
          {view && vaultUnlocked && (role === 'seller' || role === 'resolver') && <VaultTrackingCard />}
          {view && (role === 'buyer' || role === 'seller' || role === 'resolver') && <SettlementPanel party={role} />}
        </div>
        <div className="space-y-4">
          {view ? <StatusOverview view={view} now={now} /> : <Alert tone="warn">{t('party.noEscrow')}</Alert>}
          <TimelinePanel />
        </div>
      </div>
      {vaultUnlocked && <TxLogPanel contractAddress={contractAddress} importAddress={mode === 'wallet' ? contractAddress : null} />}
    </main>
  );
}
