'use client';
import { LOAN_OPENING_KINDS, OPENING_KINDS, fmtRate, type Opening, type WirePrivateTerms } from '@/domain/terms';
import { decimalsOf, formatAmount } from '@/domain/amount';
import { useT, type MessageKey } from '../i18n';
import { downloadJson } from './party/helpers';

/** The openings a package can hand out: the loan ones only in a loan deal. */
export const openingKindsFor = (t: Pick<WirePrivateTerms, 'lenderShare'>): Opening['kind'][] =>
  OPENING_KINDS.filter((k) => BigInt(t.lenderShare) > 0n || !LOAN_OPENING_KINDS.includes(k));

/** FR-TERMS-05: one button per single opening (a third party gets one value with its salt, nothing else). */
export function OpeningButtons({ kinds, make }: { kinds: readonly Opening['kind'][]; make: (k: Opening['kind']) => Opening }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {kinds.map((k) => (
        <button key={k} type="button" className="btn-ghost" onClick={() => downloadJson(`opening-${k}.json`, make(k))}>
          {t(`opening.${k}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

/** Price · buyer deposit · loan, as the terms package states them. */
export function TermsAmounts({ terms, ticker, decimals }: { terms: Pick<WirePrivateTerms, 'price' | 'amount' | 'lenderShare' | 'refundOnLoss' | 'penaltyRate' | 'penalty'>; ticker?: string; decimals?: number }) {
  const { t } = useT();
  const f = (v: string) => formatAmount(v, decimalsOf(decimals));
  const loan = BigInt(terms.lenderShare) > 0n;
  return (
    <p className="text-sm text-slate-300">
      {t('adminTerms.price')}: <strong>{f(terms.price)}</strong> {ticker}
      {loan && (
        <>
          {' '}
          · {t('adminTerms.deposit')}: <strong>{f(terms.amount)}</strong> · {t('adminTerms.loan')}: <strong>{f(terms.lenderShare)}</strong> · {t(terms.refundOnLoss ? 'adminTerms.refundYes' : 'adminTerms.refundNo')}
        </>
      )}
      {BigInt(terms.penaltyRate ?? '0') > 0n && (
        <>
          {' '}
          · {t('cool.penalty')}: <strong>{f(terms.penalty)}</strong> ({fmtRate(terms.penaltyRate)})
        </>
      )}
    </p>
  );
}
