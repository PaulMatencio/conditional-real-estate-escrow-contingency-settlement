'use client';
import { useState } from 'react';
import { Zap } from 'lucide-react';
import type { CircuitArgs } from '@/application/partyPorts';
import { CONTINGENCIES, type ContingencyName } from '@/domain/escrowView';
import { availableActions, type PartyCircuit } from '@/domain/lifecycle';
import type { PartyRole } from '@/domain/roles';
import { sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Spinner } from '../ui';
import { ConfirmDialog, downloadJson } from './helpers';

/** Circuits with their own panel (document hashing) are not repeated here. */
const DEDICATED: PartyCircuit[] = [
  'submitInspection',
  'submitFinancing',
  'submitTitle',
  'revokeKycAttestation',
  'revokeKycIssuer',
  // v2: lender page (Loan card) and buyer page (Top-up card)
  'depositLoan',
  'declineLoan',
  'withdrawLoan',
  'depositTopUp',
  'claimForfeit',
  // cooling-off: buyer page (Withdraw card) and seller page (Penalty card)
  'buyerWithdraw',
  'refundWithdrawal',
  'claimPenalty'
];
/** Permissionless circuits: called as 'anyone'. */
const OPEN: PartyCircuit[] = ['expireEscrow', 'endTopUpWindow'];

/**
 * Role-aware action list (FR-WALLET-03, §3.1.6 AC-1): every circuit this role may call, enabled only when the phase,
 * deadline and local material allow it, with the reason otherwise. Fund-moving and final actions ask for confirmation.
 */
export function ActionsPanel({ role, onlyEnabled = false }: { role: PartyRole; onlyEnabled?: boolean }) {
  const { t } = useT();
  const { view, now, record, run, busy } = useEscrow();
  const [which, setWhich] = useState<ContingencyName>('Inspection');
  const [pending, setPending] = useState<PartyCircuit | null>(null);
  const [evidence, setEvidence] = useState('');
  const [pass, setPass] = useState('');
  if (!view) return null;

  const material = {
    terms: !!record.terms,
    kycAttestation: !!record.kyc?.[role === 'seller' ? 'seller' : 'buyer'],
    vaultCoin: record.terms?.vaultIndex !== undefined || !!record.terms,
    lenderTerms: !!record.lenderTerms || !!record.terms,
    // The second coin's index is located from the chain when needed (see trackSecondCoin).
    secondCoin: true
  };
  const actions = availableActions(view, role, now, material)
    // The resolver has no withdrawal card: it can still trigger the buyer's withdrawal refund from here.
    .filter((a) => !DEDICATED.includes(a.circuit) || (role === 'resolver' && a.circuit === 'refundWithdrawal'))
    .filter((a) => !onlyEnabled || a.enabled);
  const needsWhich = (c: PartyCircuit) => c === 'waiveContingency' || c === 'voidContingencyResult';

  const argsFor = (c: PartyCircuit): CircuitArgs[PartyCircuit] => {
    if (c === 'acceptConfiguration') return [view.configVersion] as CircuitArgs['acceptConfiguration'];
    if (needsWhich(c)) return [which] as CircuitArgs['waiveContingency'];
    return [] as [];
  };

  const execute = async (c: PartyCircuit) => {
    setPending(null);
    if (c === 'openDispute' && evidence.trim() && pass.length >= 8) {
      downloadJson('dispute-evidence.json', await sealWithPassphrase({ format: 'EscrowDisputeEvidenceV1', contractAddress: view.contractAddress, by: role, at: new Date().toISOString(), note: evidence }, pass));
    }
    await run(OPEN.includes(c) ? 'anyone' : role, c as never, argsFor(c) as never, role);
    setEvidence('');
  };

  return (
    <Card title={t('actions.title')} icon={<Zap size={16} aria-hidden />}>
      {actions.some((a) => needsWhich(a.circuit)) && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-slate-400">{t('actions.contingency')}</span>
          <select className="input !w-auto" value={which} onChange={(e) => setWhich(e.target.value as ContingencyName)}>
            {CONTINGENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      {actions.length === 0 && <p className="text-sm text-slate-400">{t('actions.none')}</p>}
      <ul className="space-y-2">
        {actions.map((a) => {
          const reason = needsWhich(a.circuit) ? (availableActions(view, role, now, material, which).find((x) => x.circuit === a.circuit)?.reason ?? null) : a.reason;
          return (
            <li key={a.circuit} className="flex flex-wrap items-center gap-3 rounded-xl border border-midnight-700 bg-midnight-900/60 p-3">
              <button
                type="button"
                className={a.irreversible ? 'btn-danger' : 'btn-primary'}
                disabled={busy || reason !== null}
                onClick={() => (a.irreversible || a.circuit === 'openDispute' ? setPending(a.circuit) : void execute(a.circuit))}
              >
                {busy ? <Spinner /> : null} {t(`circuit.${a.circuit}` as MessageKey) ?? a.circuit}
              </button>
              <span className="mono text-slate-500">{a.circuit}</span>
              {reason && <span className="text-xs text-warn">{reason}</span>}
            </li>
          );
        })}
      </ul>
      {pending && (
        <ConfirmDialog
          title={t(`circuit.${pending}` as MessageKey)}
          body={pending === 'openDispute' ? t('actions.disputeBody') : t('actions.irreversible')}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => void execute(pending)}
        >
          {needsWhich(pending) && <Alert tone="warn">{which}</Alert>}
          {pending === 'openDispute' && (
            <div className="space-y-2">
              <textarea className="input" rows={3} placeholder={t('actions.evidence')} aria-label={t('actions.evidence')} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
              <input type="password" className="input" placeholder={t('vault.passphrase')} aria-label={t('vault.passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
            </div>
          )}
        </ConfirmDialog>
      )}
    </Card>
  );
}
