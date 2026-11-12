'use client';
import { useEffect, useState } from 'react';
import { Coins, Gavel, Receipt } from 'lucide-react';
import { bytesToHex, shortHex } from '@/domain/hex';
import { hasUsableSellerKyc } from '@/domain/escrowView';
import { availableActions, type PartyCircuit } from '@/domain/lifecycle';
import { loanCoinOf, payoutOfCoin, topUpCoinOf, vaultCoinOf } from '@/infrastructure/crypto/escrowCrypto';
import { networkConfig } from '@/infrastructure/config/network';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Field, Mono, Spinner, Stat } from '../ui';
import { ConfirmDialog, downloadJson } from './helpers';

/** FR-FUND-01/03, FR-WALLET-05/06: the deterministic vault coin, the shielded balance check and vault tracking. */
export function FundingPanel() {
  const { t } = useT();
  const { record, view, gateway, mode } = useEscrow();
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [walletKey, setWalletKey] = useState<string | null>(null);
  const pkg = record.terms;

  useEffect(() => {
    if (!view) return;
    void gateway()
      .then(async (g) => {
        setBalance(await g.shieldedBalance(view.escrowColor));
        setWalletKey(await g.coinPublicKey());
      })
      .catch(() => setBalance(null));
  }, [gateway, view]);

  if (!view || !pkg?.contractAddress) return <Card title={t('fund.title')} icon={<Coins size={16} aria-hidden />}><Alert tone="warn">{t('kyc.needTerms')}</Alert></Card>;
  const coin = vaultCoinOf(pkg.contractAddress, view.escrowColor, pkg.terms);
  const need = BigInt(pkg.terms.amount);
  return (
    <Card title={t('fund.title')} icon={<Coins size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('fund.hint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('fund.amount')} value={`${pkg.terms.amount} ${view.escrowTicker}`} sub={t('fund.private')} />
        <Stat
          label={t('fund.balance')}
          value={balance === undefined ? '…' : balance === null ? '—' : `${balance} ${view.escrowTicker}`}
          sub={balance !== null && balance !== undefined && balance < need ? `${t('fund.shortfall')} ${need - balance}` : mode === 'simulator' ? t('fund.simBalance') : undefined}
        />
        <Stat label={t('fund.nonce')} tip={t('tip.fund.nonce')} value={<span className="mono">{shortHex(bytesToHex(coin.nonce))}</span>} sub={`color ${shortHex(view.escrowColor)}`} />
      </div>
      {walletKey && walletKey !== pkg.terms.buyerPayout && walletKey !== pkg.terms.sellerPayout && <Alert tone="warn">{t('fund.keyDiffers')}</Alert>}
      {walletKey && (
        <Field label={t('fund.walletKey')} hint={t('fund.walletKeyHint')}>
          <Mono value={walletKey} />
        </Field>
      )}

      <h3 className="label mt-4">{t('fund.tracking')}</h3>
      <VaultTracking />
      <p className="mt-2 text-xs text-slate-500">{t('fund.v2')}</p>
    </Card>
  );
}

/**
 * FR-FUND-03: the vault coin's position (index), which every payout or refund needs. Found automatically from the
 * deposit transaction (read from the chain when this browser did not deposit); a hash or the index can also be given.
 */
function VaultTracking() {
  const { t } = useT();
  const { record, trackVaultIndex, updateRecord } = useEscrow();
  const [tx, setTx] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const pkg = record.terms;
  if (!pkg) return null;
  return (
    <>
      <p className="mb-2 text-sm text-slate-300">
        {t('terms.vaultIndex')}: <strong>{pkg.vaultIndex ?? '—'}</strong> {pkg.depositTxHash && <span className="mono text-slate-500">tx {shortHex(pkg.depositTxHash)}</span>}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex gap-2">
          <input className="input mono" placeholder={t('fund.depositTx')} aria-label={t('fund.depositTx')} value={tx} onChange={(e) => setTx(e.target.value)} />
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => (setBusy(true), void trackVaultIndex(tx.trim() || undefined).finally(() => setBusy(false)))}>
            {t('fund.track')}
          </button>
        </div>
        <div className="flex gap-2">
          <input className="input" inputMode="numeric" placeholder={t('fund.manualIndex')} aria-label={t('fund.manualIndex')} value={manual} onChange={(e) => setManual(e.target.value)} />
          <button
            type="button"
            className="btn-ghost"
            disabled={!/^\d+$/.test(manual)}
            onClick={() => void updateRecord((r) => ({ ...r, terms: r.terms && { ...r.terms, vaultIndex: manual } })).then(() => setManual(''))}
          >
            {t('fund.setIndex')}
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">{t('fund.trackHint')}</p>
    </>
  );
}

/** Seller and resolver: the vault tracking on its own, from the deposit onwards (they spend the vault coin to pay out). */
export function VaultTrackingCard() {
  const { t } = useT();
  const { record, view } = useEscrow();
  if (!view || !record.terms || ['Initializing', 'Created', 'Cancelled'].includes(view.status)) return null;
  return (
    <Card title={t('fund.tracking')} icon={<Coins size={16} aria-hidden />}>
      <VaultTracking />
    </Card>
  );
}

/**
 * FR-SETTLE-03/04: the payout coin(s) to import, and receipts (public, and a private one with the amounts). Contract v2:
 * a release pays two coins (buyer deposit + loan or top-up), a refund returns each coin to its depositor, a forfeit
 * pays the buyer deposit to the seller.
 */
export function SettlementPanel({ party }: { party: 'buyer' | 'seller' | 'resolver' }) {
  const { t } = useT();
  const { record, view, timeline, sim } = useEscrow();
  const pkg = record.terms;
  if (!view || view.status !== 'Closed' || !pkg?.contractAddress) return null;
  const f = view.financing;
  const ran = new Set([...(record.history ?? []).map((h) => h.circuit), ...(sim?.log.map((l) => l.circuit) ?? [])]);
  const outcome: 'released' | 'forfeited' | 'refunded' = ran.has('releaseToSeller') ? 'released' : ran.has('claimForfeit') ? 'forfeited' : 'refunded';
  const addr = pkg.contractAddress;
  const coins: { label: string; coin: ReturnType<typeof payoutOfCoin>; to: string }[] = [];
  const buyerTo = outcome === 'refunded' ? pkg.terms.buyerPayout : pkg.terms.sellerPayout;
  coins.push({ label: t('settle.coinDeposit'), coin: payoutOfCoin(vaultCoinOf(addr, view.escrowColor, pkg.terms)), to: buyerTo });
  if (outcome === 'released' && f.loanHeld) coins.push({ label: t('settle.coinLoan'), coin: payoutOfCoin(loanCoinOf(addr, view.escrowColor, pkg.terms)), to: pkg.terms.sellerPayout });
  if (f.topUpHeld && outcome !== 'forfeited') coins.push({ label: t('settle.coinTopUp'), coin: payoutOfCoin(topUpCoinOf(addr, view.escrowColor, pkg.terms)), to: buyerTo });
  if (outcome === 'refunded' && f.loanHeld) coins.push({ label: t('settle.coinLoanBack'), coin: payoutOfCoin(loanCoinOf(addr, view.escrowColor, pkg.terms)), to: pkg.terms.lenderPayout });
  const last = record.history?.filter((h) => ['releaseToSeller', 'refundBuyer', 'claimForfeit', 'refundLender'].includes(h.circuit)).at(-1);
  const publicReceipt = { format: 'EscrowSettlementReceiptV2', network: networkConfig.networkId, contractAddress: view.contractAddress, outcome, status: view.status, lifecycleRound: view.lifecycleRound.toString(), txHash: last?.txHash, blockHeight: last?.blockHeight, at: new Date().toISOString() };
  const mine = coins.filter((c) => c.to === (party === 'seller' ? pkg.terms.sellerPayout : party === 'buyer' ? pkg.terms.buyerPayout : c.to));
  return (
    <Card title={t('settle.title')} icon={<Receipt size={16} aria-hidden />}>
      <Alert tone="ok">
        {t('settle.closed')}: {t(`settle.outcome.${outcome}`)}
      </Alert>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-slate-400">{t('settle.importHint')}</p>
        {coins.map((c) => (
          <div key={c.label} className="rounded-xl border border-midnight-700 p-3">
            <p className="mb-1 font-medium text-slate-200">{c.label}</p>
            <Field label="nonce">
              <Mono value={c.coin.nonce} />
            </Field>
            <p className="text-slate-300">
              color <span className="mono">{shortHex(c.coin.color)}</span> · value {c.coin.value} {view.escrowTicker} · {t('settle.to')} <span className="mono">{shortHex(c.to)}</span>
            </p>
          </div>
        ))}
        <Alert tone="warn">{t('settle.v1')}</Alert>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={mine.length === 0} onClick={() => downloadJson('payout-coins.json', { contractAddress: view.contractAddress, coins: mine.map((c) => ({ ...c.coin, recipient: c.to, label: c.label })) })}>
            {t('settle.exportCoin')}
          </button>
          <button type="button" className="btn-ghost" onClick={() => downloadJson('settlement-receipt.json', { ...publicReceipt, events: timeline })}>
            {t('settle.receipt')}
          </button>
          {party !== 'resolver' && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() =>
                downloadJson('settlement-receipt-private.json', {
                  ...publicReceipt,
                  private: { price: pkg.terms.price, buyerDeposit: pkg.terms.amount, loanAmount: pkg.terms.lenderShare, ticker: view.escrowTicker, payoutCoins: coins.map((c) => ({ ...c.coin, recipient: c.to, label: c.label })) }
                })
              }
            >
              {t('settle.privateReceipt')}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

type ForfeitAction = 'submitSellerKyc' | 'claimForfeit';

/**
 * Seller page, contract v2: the loan was lost with the refund term off and the buyer did not replace it before the
 * closing deadline. The buyer deposit is payable only to the seller; claiming it needs the seller's usable KYC.
 */
export function ForfeitCard() {
  const { t } = useT();
  const { view, now, record, run, busy } = useEscrow();
  const [pending, setPending] = useState<ForfeitAction | null>(null);
  if (!view || view.status !== 'Forfeited') return null;
  const material = { terms: !!record.terms, kycAttestation: !!record.kyc?.seller, vaultCoin: true };
  const acts = Object.fromEntries(availableActions(view, 'seller', now, material).map((a) => [a.circuit, a])) as Partial<Record<PartyCircuit, { enabled: boolean; reason: string | null }>>;
  const kycOk = hasUsableSellerKyc(view, now);
  const amount = record.terms?.terms.amount;
  const button = (a: ForfeitAction, primary: boolean) => {
    const s = acts[a];
    return (
      <div className="flex flex-col gap-1">
        <button type="button" className={primary ? 'btn-primary' : 'btn-ghost'} disabled={busy || !s?.enabled} onClick={() => (a === 'claimForfeit' ? setPending(a) : void run('seller', a, [] as never))}>
          {busy ? <Spinner /> : null} {t(`circuit.${a}` as MessageKey)}
        </button>
        {s?.reason && <span className="text-xs text-warn">{s.reason}</span>}
      </div>
    );
  };
  return (
    <Card title={t('forfeit.title')} icon={<Gavel size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('forfeit.hint')}</p>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Stat label={t('adminTerms.deposit')} value={amount ? `${amount} ${view.escrowTicker}` : '—'} sub={t('fund.private')} />
        <Stat label={t('forfeit.kyc')} value={<span className="text-sm">{t(kycOk ? 'forfeit.kycOk' : 'forfeit.kycMissing')}</span>} />
      </div>
      {view.financing.buyerCoinPaid ? (
        <Alert tone="ok">{t('forfeit.paid')}</Alert>
      ) : (
        <div className="flex flex-wrap gap-3">
          {!kycOk && button('submitSellerKyc', false)}
          {button('claimForfeit', true)}
        </div>
      )}
      {pending && (
        <ConfirmDialog
          title={t('circuit.claimForfeit')}
          body={t('forfeit.confirm').replace('{amount}', amount ? `${amount} ${view.escrowTicker}` : '')}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void run('seller', 'claimForfeit', [] as never);
          }}
        />
      )}
    </Card>
  );
}
