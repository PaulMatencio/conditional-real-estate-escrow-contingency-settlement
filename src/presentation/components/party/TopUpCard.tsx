'use client';
import { useEffect, useState } from 'react';
import { PiggyBank } from 'lucide-react';
import { availableActions, type PartyCircuit } from '@/domain/lifecycle';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { useAmount } from '../useAmount';
import { Alert, Card, Spinner, Stat } from '../ui';
import { ConfirmDialog, Countdown, fmtTime } from './helpers';

type TopUpAction = 'depositTopUp' | 'cancelAndRefund' | 'endTopUpWindow';

/**
 * Buyer page, contract v2 (loan mode): the buyer can deposit the loan amount itself while no loan or top-up is held,
 * and keep the deal alive. After a refused or withdrawn loan: with the refund term on, a top-up window runs (top up,
 * give up early, or let anyone end it for the refund); with the term off, the buyer must top up before the closing
 * deadline or the seller keeps its deposit.
 */
export function TopUpCard() {
  const { t } = useT();
  const { view, now, record, run, busy, gateway, mode } = useEscrow();
  const { fmt } = useAmount();
  const [pending, setPending] = useState<TopUpAction | null>(null);
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);

  useEffect(() => {
    if (!view) return;
    void gateway().then((g) => g.shieldedBalance(view.escrowColor)).then(setBalance, () => setBalance(null));
  }, [gateway, view]);

  if (!view || view.financing.mode !== 'Deposited') return null;
  const f = view.financing;
  const pkg = record.terms;
  const need = pkg ? BigInt(pkg.terms.lenderShare) : null;
  const inReview = view.status === 'ContingenciesPending';
  const windowed = f.loanLost && f.loanLostRefund && !f.topUpHeld;
  const forfeitRisk = f.loanLost && !f.loanLostRefund && !f.topUpHeld;
  const material = { terms: !!pkg, kycAttestation: !!record.kyc?.buyer, vaultCoin: true, lenderTerms: !!pkg, secondCoin: true };
  const acts = Object.fromEntries(availableActions(view, 'buyer', now, material).map((a) => [a.circuit, a])) as Partial<Record<PartyCircuit, { enabled: boolean; reason: string | null }>>;

  const status = f.topUpHeld
    ? { tone: 'ok' as const, text: t('topup.st.done') }
    : f.loanHeld
      ? { tone: 'ok' as const, text: t('topup.st.loanIn') }
      : windowed
        ? { tone: 'warn' as const, text: t(f.loanWithdrawn ? 'topup.st.withdrawnOn' : 'topup.st.refusedOn') }
        : forfeitRisk
          ? { tone: 'bad' as const, text: t(f.loanWithdrawn ? 'topup.st.withdrawnOff' : 'topup.st.refusedOff') }
          : { tone: 'warn' as const, text: t(inReview ? 'topup.st.waiting' : 'topup.st.notYet') };

  const execute = async (a: TopUpAction) => {
    setPending(null);
    await run(a === 'endTopUpWindow' ? 'anyone' : 'buyer', a as never, [] as never, 'buyer');
  };

  const button = (a: TopUpAction, danger: boolean, label?: MessageKey) => {
    const s = acts[a];
    return (
      <div className="flex flex-col gap-1">
        <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || !s?.enabled} onClick={() => (a === 'endTopUpWindow' ? void execute(a) : setPending(a))}>
          {busy ? <Spinner /> : null} {t(label ?? (`circuit.${a}` as MessageKey))}
        </button>
        {s?.reason && <span className="text-xs text-warn">{s.reason}</span>}
      </div>
    );
  };

  return (
    <Card title={t('topup.title')} tip={t('tip.topup.title')} icon={<PiggyBank size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('topup.hint')}</p>
      <div className="mb-3">
        <Alert tone={status.tone}>{status.text}</Alert>
      </div>
      {!f.topUpHeld && !f.loanHeld && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Stat label={t('topup.amount')} value={need === null ? '—' : fmt(need)} sub={t('fund.private')} />
          <Stat
            label={t('fund.balance')}
            value={balance === undefined ? '…' : balance === null ? '—' : fmt(balance)}
            sub={need !== null && balance !== null && balance !== undefined && balance < need ? `${t('fund.shortfall')} ${fmt(need - balance)}` : mode === 'simulator' ? t('fund.simBalance') : undefined}
          />
          {inReview &&
            (windowed ? (
              now < f.topUpWindowEnd ? <Countdown to={f.topUpWindowEnd} now={now} label={t('topup.windowEnds')} /> : <Stat label={t('topup.windowEnds')} value={<span className="text-sm">{t('topup.windowOver')}</span>} />
            ) : (
              <Countdown to={view.closingDeadline} now={now} label={t(forfeitRisk ? 'topup.forfeitAt' : 'deadline.closing')} />
            ))}
        </div>
      )}
      {!pkg && <Alert tone="warn">{t('kyc.needTerms')}</Alert>}
      {inReview && !f.topUpHeld && !f.loanHeld && (
        <div className="flex flex-wrap gap-3">
          {(!windowed || now < f.topUpWindowEnd) && button('depositTopUp', false)}
          {windowed && now < f.topUpWindowEnd && button('cancelAndRefund', true, 'topup.giveUp')}
          {windowed && now >= f.topUpWindowEnd && button('endTopUpWindow', false)}
        </div>
      )}
      {windowed && inReview && <p className="mt-2 text-xs text-slate-500">{t('topup.windowNote').replace('{end}', fmtTime(f.topUpWindowEnd))}</p>}
      {pending && (
        <ConfirmDialog
          title={t(pending === 'cancelAndRefund' ? 'topup.giveUp' : (`circuit.${pending}` as MessageKey))}
          body={t(pending === 'depositTopUp' ? 'topup.confirmDeposit' : 'topup.confirmGiveUp').replace('{amount}', need === null ? '' : fmt(need))}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => void execute(pending)}
        />
      )}
    </Card>
  );
}
