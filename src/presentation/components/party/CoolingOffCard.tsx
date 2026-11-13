'use client';
import { useState } from 'react';
import { DoorOpen, HandCoins } from 'lucide-react';
import { shortHex } from '@/domain/hex';
import { hasUsableSellerKyc, insideCoolingOff } from '@/domain/escrowView';
import { availableActions, refundableFailure, type PartyCircuit } from '@/domain/lifecycle';
import { fmtRate } from '@/domain/terms';
import { withdrawalCoinsOf } from '@/infrastructure/crypto/escrowCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Field, Mono, Spinner, Stat } from '../ui';
import { ConfirmDialog, Countdown, fmtTime } from './helpers';

type Acts = Partial<Record<PartyCircuit, { enabled: boolean; reason: string | null }>>;
const LIVE = ['Funded', 'ContingenciesPending', 'ReadyToClose', 'Disputed'];

/** One action button with its disabled reason underneath. */
function ActionButton({ circuit, acts, danger, onClick, busy, label }: { circuit: PartyCircuit; acts: Acts; danger?: boolean; onClick: () => void; busy: boolean; label?: MessageKey }) {
  const { t } = useT();
  const s = acts[circuit];
  return (
    <div className="flex flex-col gap-1">
      <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || !s?.enabled} onClick={onClick}>
        {busy ? <Spinner /> : null} {t(label ?? (`circuit.${circuit}` as MessageKey))}
      </button>
      {s?.reason && <span className="text-xs text-warn">{s.reason}</span>}
    </div>
  );
}

/** A payout coin the recipient imports into its wallet. */
function CoinBox({ label, coin, to, ticker }: { label: string; coin: { nonce: string; color: string; value: string }; to: string; ticker: string }) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-midnight-700 p-3 text-sm">
      <p className="mb-1 font-medium text-slate-200">{label}</p>
      <Field label="nonce">
        <Mono value={coin.nonce} />
      </Field>
      <p className="text-slate-300">
        color <span className="mono">{shortHex(coin.color)}</span> · value {coin.value} {ticker} · {t('settle.to')} <span className="mono">{shortHex(to)}</span>
      </p>
    </div>
  );
}

/**
 * Buyer page: walk away from the purchase. Inside the cooling-off period the deposit comes back minus the committed
 * penalty (Withdrawn); after it, or with no cooling-off period, withdrawing forfeits the deposit to the seller. A failed
 * contingency always gives a full refund instead (cancel and refund).
 */
export function WithdrawCard() {
  const { t } = useT();
  const { view, now, record, run, busy } = useEscrow();
  const [pending, setPending] = useState<'buyerWithdraw' | 'refundWithdrawal' | null>(null);
  if (!view || !(LIVE.includes(view.status) || view.status === 'Withdrawn')) return null;
  const pkg = record.terms;
  const c = view.coolingOff;
  const ticker = view.escrowTicker;
  const inside = insideCoolingOff(view, now);
  const deposit = pkg ? BigInt(pkg.terms.amount) : null;
  const penalty = pkg ? BigInt(pkg.terms.penalty) : null;
  const material = { terms: !!pkg, kycAttestation: false, vaultCoin: true };
  const acts = Object.fromEntries(availableActions(view, 'buyer', now, material).map((a) => [a.circuit, a])) as Acts;
  const amt = (v: bigint | null) => (v === null ? '—' : `${v} ${ticker}`);

  if (view.status === 'Withdrawn') {
    const coins = pkg?.contractAddress ? withdrawalCoinsOf(pkg.contractAddress, view.escrowColor, pkg.terms) : null;
    return (
      <Card title={t('cool.withdrawTitle')} tip={t('tip.cool.withdraw')} icon={<DoorOpen size={16} aria-hidden />}>
        <Alert tone="warn">{t('cool.st.withdrawn')}</Alert>
        <div className="my-3 grid gap-3 sm:grid-cols-2">
          <Stat label={t('cool.refund')} value={deposit !== null && penalty !== null ? amt(deposit - penalty) : '—'} sub={t('fund.private')} />
          <Stat label={t('cool.penalty')} value={amt(penalty)} sub={pkg ? fmtRate(pkg.terms.penaltyRate) : undefined} />
        </div>
        {view.financing.buyerCoinPaid ? (
          coins && <CoinBox label={t('cool.refundCoin')} coin={coins.buyerRefund} to={pkg!.terms.buyerPayout} ticker={ticker} />
        ) : (
          <ActionButton circuit="refundWithdrawal" acts={acts} busy={busy} onClick={() => setPending('refundWithdrawal')} />
        )}
        {view.financing.topUpHeld && !view.financing.secondCoinPaid && <p className="mt-2 text-xs text-slate-500">{t('cool.topUpBack')}</p>}
        {pending && (
          <ConfirmDialog
            title={t('circuit.refundWithdrawal')}
            body={t('cool.confirmRefund').replace('{amount}', deposit !== null && penalty !== null ? amt(deposit - penalty) : '')}
            confirmLabel={t('actions.confirm')}
            onCancel={() => setPending(null)}
            onConfirm={() => {
              setPending(null);
              void run('buyer', 'refundWithdrawal', [] as never);
            }}
          />
        )}
      </Card>
    );
  }

  const failed = refundableFailure(view);
  const status = failed
    ? { tone: 'ok' as const, text: t('cool.st.failed') }
    : c.period === 0n
      ? { tone: 'bad' as const, text: t('cool.st.off').replace('{amount}', amt(deposit)) }
      : inside
        ? { tone: 'warn' as const, text: t('cool.st.inside').replace('{penalty}', amt(penalty)) }
        : { tone: 'bad' as const, text: t('cool.st.after').replace('{amount}', amt(deposit)) };
  return (
    <Card title={t('cool.withdrawTitle')} tip={t('tip.cool.withdraw')} icon={<DoorOpen size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('cool.withdrawHint')}</p>
      <div className="mb-3">
        <Alert tone={status.tone}>{status.text}</Alert>
      </div>
      {c.period > 0n && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          {inside ? <Countdown to={c.end} now={now} label={t('cool.ends')} /> : <Stat label={t('cool.ends')} value={<span className="text-sm">{fmtTime(c.end)}</span>} />}
          <Stat label={t('cool.penalty')} value={amt(penalty)} sub={pkg ? fmtRate(pkg.terms.penaltyRate) : t('fund.private')} />
          <Stat label={t('cool.refund')} value={deposit !== null && penalty !== null ? amt(inside ? deposit - penalty : 0n) : '—'} sub={t('fund.private')} />
        </div>
      )}
      {!failed && <ActionButton circuit="buyerWithdraw" acts={acts} danger busy={busy} onClick={() => setPending('buyerWithdraw')} />}
      {pending && (
        <ConfirmDialog
          title={t('circuit.buyerWithdraw')}
          body={(inside ? t('cool.confirmInside').replace('{penalty}', amt(penalty)).replace('{refund}', deposit !== null && penalty !== null ? amt(deposit - penalty) : '') : t('cool.confirmForfeit').replace('{amount}', amt(deposit))) + (view.financing.loanHeld ? ` ${t('cool.loanBack')}` : '')}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void run('buyer', 'buyerWithdraw', [] as never);
          }}
        />
      )}
    </Card>
  );
}

/**
 * Seller page: the cooling-off period seen from the seller. While it runs, no release; after a withdrawal inside it,
 * the buyer is refunded (either party can trigger it) and the seller claims the penalty with a usable KYC.
 */
export function PenaltyCard() {
  const { t } = useT();
  const { view, now, record, run, busy } = useEscrow();
  const [pending, setPending] = useState<'claimPenalty' | null>(null);
  if (!view || view.coolingOff.period === 0n) return null;
  const pkg = record.terms;
  const c = view.coolingOff;
  const ticker = view.escrowTicker;
  const inside = insideCoolingOff(view, now);
  const penalty = pkg ? BigInt(pkg.terms.penalty) : null;
  const amt = (v: bigint | null) => (v === null ? '—' : `${v} ${ticker}`);

  if (view.status !== 'Withdrawn') {
    if (!LIVE.includes(view.status) || !inside) return null;
    return (
      <Card title={t('cool.title')} tip={t('tip.cool.seller')} icon={<HandCoins size={16} aria-hidden />}>
        <Alert tone="warn">{t('cool.st.sellerInside').replace('{end}', fmtTime(c.end))}</Alert>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Countdown to={c.end} now={now} label={t('cool.ends')} />
          <Stat label={t('cool.penalty')} value={amt(penalty)} sub={pkg ? fmtRate(pkg.terms.penaltyRate) : t('fund.private')} />
        </div>
      </Card>
    );
  }

  const material = { terms: !!pkg, kycAttestation: !!record.kyc?.seller, vaultCoin: true, penaltyCoin: true };
  const acts = Object.fromEntries(availableActions(view, 'seller', now, material).map((a) => [a.circuit, a])) as Acts;
  const kycOk = hasUsableSellerKyc(view, now);
  const coins = pkg?.contractAddress ? withdrawalCoinsOf(pkg.contractAddress, view.escrowColor, pkg.terms) : null;
  return (
    <Card title={t('cool.penaltyTitle')} tip={t('tip.cool.seller')} icon={<HandCoins size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('cool.penaltyHint')}</p>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Stat label={t('cool.penalty')} value={amt(penalty)} sub={pkg ? fmtRate(pkg.terms.penaltyRate) : t('fund.private')} />
        <Stat label={t('forfeit.kyc')} value={<span className="text-sm">{t(kycOk ? 'forfeit.kycOk' : 'forfeit.kycMissing')}</span>} />
      </div>
      {!view.financing.buyerCoinPaid ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-300">{t('cool.refundFirst')}</p>
          <ActionButton circuit="refundWithdrawal" acts={acts} busy={busy} onClick={() => void run('seller', 'refundWithdrawal', [] as never)} />
        </div>
      ) : !c.penaltyDue ? (
        <Alert tone="ok">{t('cool.noPenalty')}</Alert>
      ) : c.penaltyPaid ? (
        coins?.sellerPenalty && <CoinBox label={t('cool.penaltyCoin')} coin={coins.sellerPenalty} to={pkg!.terms.sellerPayout} ticker={ticker} />
      ) : (
        <div className="flex flex-wrap gap-3">
          {!kycOk && <ActionButton circuit="submitSellerKyc" acts={acts} busy={busy} onClick={() => void run('seller', 'submitSellerKyc', [] as never)} />}
          <ActionButton circuit="claimPenalty" acts={acts} busy={busy} onClick={() => setPending('claimPenalty')} />
        </div>
      )}
      {pending && (
        <ConfirmDialog
          title={t('circuit.claimPenalty')}
          body={t('cool.confirmClaim').replace('{amount}', amt(penalty))}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void run('seller', 'claimPenalty', [] as never);
          }}
        />
      )}
    </Card>
  );
}
