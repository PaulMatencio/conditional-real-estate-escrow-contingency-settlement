'use client';
import { useState } from 'react';
import { Landmark } from 'lucide-react';
import { DEFAULT_COOLING_OFF_DAYS, DEFAULT_TOP_UP_DAYS } from '@/domain/escrow';
import { useApp } from '../../providers/AppProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field } from '../ui';

const DAY = 86_400;
const fmtDate = (s: bigint) => (s > 0n ? new Date(Number(s) * 1000).toLocaleString() : '—');

/**
 * Admin → Initialize (contract v2): how the financing contingency is met. Cash deal: the lender only attests (v1
 * behaviour). Loan: the lender deposits its committed share; after the loan offer expiry it may withdraw a deposit
 * still waiting in review; with the refund term on, a lost loan gives the buyer a top-up window before the refund.
 * The four financing commitments (price, loan amount, lender key, refund term) come from the Terms & KYC tab.
 */
export function FinancingCard() {
  const { t } = useT();
  const { state, configureFinancing, progress } = useApp();
  const current = state?.financing;
  const [mode, setMode] = useState<'attested' | 'deposited'>(current?.mode ?? 'deposited');
  const [expiry, setExpiry] = useState('');
  const [days, setDays] = useState(String(DEFAULT_TOP_UP_DAYS));
  // Cooling-off period: off (0) unless the admin sets it, for cash and loan deals alike.
  const [coolDays, setCoolDays] = useState(current?.coolingOff ? String(Number(current.coolingOff / BigInt(DAY))) : String(DEFAULT_COOLING_OFF_DAYS));
  const [err, setErr] = useState<string | null>(null);
  const busy = progress?.status === 'running';
  if (!state || state.status !== 0) return null;

  const loan = mode === 'deposited';
  const expiryNum = /^\d+$/.test(expiry.trim()) ? BigInt(expiry.trim()) : null;
  const daysNum = /^\d+$/.test(days.trim()) ? Number(days.trim()) : null;
  const coolNum = /^\d+$/.test(coolDays.trim()) ? Number(coolDays.trim()) : null;

  const apply = () => {
    setErr(null);
    if (loan) {
      if (expiryNum === null) return setErr(t('financing.needExpiry'));
      if (state.closingDeadline > 0n && expiryNum > state.closingDeadline) return setErr(t('financing.expiryAfterClosing'));
      if (!daysNum || daysNum < 1) return setErr(t('financing.needWindow'));
    }
    if (coolNum === null) return setErr(t('cool.needDays'));
    // A cash deal does not use the dates; the contract still counts them as configured, so zeros are committed.
    void configureFinancing({
      mode,
      loanOfferExpiry: loan ? expiryNum! : 0n,
      topUpWindow: loan ? BigInt(daysNum! * DAY) : 0n,
      coolingOff: BigInt(coolNum * DAY)
    });
  };

  return (
    <Card title={t('financing.title')} tip={t('tip.financing.title')} icon={<Landmark size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('financing.hint')}</p>
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-300">
        {t('financing.onChain')}:{' '}
        {current?.mode ? <Badge tone="accent">{t(current.mode === 'deposited' ? 'financing.modeLoan' : 'financing.modeCash')}</Badge> : <Badge tone="warn">{t('financing.unset')}</Badge>}
        {current?.mode === 'deposited' && (
          <span className="text-slate-400">
            {t('financing.expiry')}: {fmtDate(current.loanOfferExpiry)} · {t('financing.window')}: {Number(current.topUpWindow / BigInt(DAY))} {t('financing.days')}
          </span>
        )}
        {current?.coolingOff !== null && current?.coolingOff !== undefined && (
          <Badge tone={current.coolingOff > 0n ? 'accent' : 'muted'}>
            {t('cool.title')}: {current.coolingOff > 0n ? `${Number(current.coolingOff / BigInt(DAY))} ${t('financing.days')}` : t('cool.off')}
          </Badge>
        )}
      </p>
      <fieldset className="mb-3">
        <legend className="label">{t('financing.mode')}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="fin-mode" checked={mode === 'attested'} onChange={() => setMode('attested')} /> {t('financing.modeCash')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="fin-mode" checked={mode === 'deposited'} onChange={() => setMode('deposited')} /> {t('financing.modeLoan')}
          </label>
        </div>
        <p className="mt-1 text-xs text-slate-500">{t(loan ? 'financing.modeLoanHint' : 'financing.modeCashHint')}</p>
      </fieldset>
      {loan && (
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label={t('financing.expiryField')} hint={expiryNum !== null ? fmtDate(expiryNum) : t('financing.expiryHint')} htmlFor="fin-expiry">
            <input id="fin-expiry" inputMode="numeric" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder={state.closingDeadline > 0n ? String(state.closingDeadline) : ''} />
          </Field>
          <Field label={t('financing.windowField')} hint={t('financing.windowHint')} htmlFor="fin-window">
            <input id="fin-window" inputMode="numeric" className="input" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label={t('cool.daysField')} hint={t('cool.daysHint')} htmlFor="fin-cool">
        <input id="fin-cool" inputMode="numeric" className="input !w-32" value={coolDays} onChange={(e) => setCoolDays(e.target.value)} />
      </Field>
      {err && (
        <div className="mb-3">
          <Alert tone="bad" onClose={() => setErr(null)}>
            {err}
          </Alert>
        </div>
      )}
      <p className="mb-3 text-xs text-slate-500">{t('financing.commitmentsHint')}</p>
      <button type="button" className="btn-primary" disabled={busy} onClick={apply}>
        {t('financing.apply')}
      </button>
    </Card>
  );
}
