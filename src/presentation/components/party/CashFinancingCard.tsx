'use client';
import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { cashFinancingWaiver } from '@/domain/lifecycle';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Card, Spinner } from '../ui';
import { ConfirmDialog } from './helpers';

/**
 * Cash deal, buyer page: the Financing contingency is redundant (the deposit already locks the full price) but contract
 * v2 still needs it cleared. One click waives it once the contingency review is open. Hidden in loan deals and once
 * Financing is cleared.
 */
export function CashFinancingCard() {
  const { t } = useT();
  const { view, run, busy } = useEscrow();
  const [confirm, setConfirm] = useState(false);
  if (!view) return null;
  const state = cashFinancingWaiver(view);
  if (state === 'hidden') return null;

  return (
    <Card title={t('cashFin.title')} icon={<Banknote size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-300">{t('cashFin.body')}</p>
      {state === 'later' ? (
        <p className="text-sm text-slate-400">{t('cashFin.later')}</p>
      ) : (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => setConfirm(true)}>
          {busy && <Spinner />} {t('cashFin.waive')}
        </button>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('cashFin.waive')}
          body={t('cashFin.confirmBody')}
          confirmLabel={t('cashFin.waive')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void run('buyer', 'waiveContingency', ['Financing'], 'buyer');
          }}
        />
      )}
    </Card>
  );
}
