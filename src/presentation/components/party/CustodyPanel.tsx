'use client';
import { useEffect, useState } from 'react';
import { Coins, Receipt } from 'lucide-react';
import { bytesToHex, shortHex } from '@/domain/hex';
import { payoutCoinOf, vaultCoinOf } from '@/infrastructure/crypto/escrowCrypto';
import { networkConfig } from '@/infrastructure/config/network';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card, Field, Mono, Stat } from '../ui';
import { downloadJson } from './helpers';

/** FR-FUND-01/03, FR-WALLET-05/06: the deterministic vault coin, the shielded balance check and vault tracking. */
export function FundingPanel() {
  const { t } = useT();
  const { record, view, gateway, trackVaultIndex, updateRecord, mode } = useEscrow();
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [walletKey, setWalletKey] = useState<string | null>(null);
  const [tx, setTx] = useState('');
  const [manual, setManual] = useState('');
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
      <p className="mb-2 text-sm text-slate-300">
        {t('terms.vaultIndex')}: <strong>{pkg.vaultIndex ?? '—'}</strong> {pkg.depositTxHash && <span className="mono text-slate-500">tx {shortHex(pkg.depositTxHash)}</span>}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex gap-2">
          <input className="input mono" placeholder={t('fund.depositTx')} aria-label={t('fund.depositTx')} value={tx} onChange={(e) => setTx(e.target.value)} />
          <button type="button" className="btn-ghost" onClick={() => void trackVaultIndex(tx.trim() || undefined)}>
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
      <p className="mt-2 text-xs text-slate-500">{t('fund.v2')}</p>
    </Card>
  );
}

/** FR-SETTLE-03/04: the payout coin to import, and receipts (public, and a private one with the amount). */
export function SettlementPanel({ party }: { party: 'buyer' | 'seller' | 'resolver' }) {
  const { t } = useT();
  const { record, view, timeline, sim } = useEscrow();
  const pkg = record.terms;
  if (!view || view.status !== 'Closed' || !pkg?.contractAddress) return null;
  const payout = payoutCoinOf(pkg.contractAddress, view.escrowColor, pkg.terms);
  const last = record.history?.filter((h) => h.circuit === 'releaseToSeller' || h.circuit === 'refundBuyer').at(-1);
  const outcome = sim?.log.some((l) => l.circuit === 'releaseToSeller') || last?.circuit === 'releaseToSeller' ? 'released to seller' : 'refunded to buyer';
  const recipientKey = outcome === 'released to seller' ? pkg.terms.sellerPayout : pkg.terms.buyerPayout;
  const publicReceipt = { format: 'EscrowSettlementReceiptV1', network: networkConfig.networkId, contractAddress: view.contractAddress, outcome, status: view.status, lifecycleRound: view.lifecycleRound.toString(), txHash: last?.txHash, blockHeight: last?.blockHeight, at: new Date().toISOString() };
  return (
    <Card title={t('settle.title')} icon={<Receipt size={16} aria-hidden />}>
      <Alert tone="ok">
        {t('settle.closed')}: {outcome}
      </Alert>
      <div className="mt-3 space-y-2 text-sm">
        <p className="text-slate-400">{t('settle.importHint')}</p>
        <Field label="nonce">
          <Mono value={payout.nonce} />
        </Field>
        <p className="text-slate-300">
          color <span className="mono">{shortHex(payout.color)}</span> · value {payout.value} {view.escrowTicker} · {t('settle.to')} <span className="mono">{shortHex(recipientKey)}</span>
        </p>
        <Alert tone="warn">{t('settle.v1')}</Alert>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" onClick={() => downloadJson('payout-coin.json', { ...payout, recipient: recipientKey, contractAddress: view.contractAddress })}>
            {t('settle.exportCoin')}
          </button>
          <button type="button" className="btn-ghost" onClick={() => downloadJson('settlement-receipt.json', { ...publicReceipt, events: timeline })}>
            {t('settle.receipt')}
          </button>
          {party !== 'resolver' && (
            <button type="button" className="btn-ghost" onClick={() => downloadJson('settlement-receipt-private.json', { ...publicReceipt, private: { amount: pkg.terms.amount, ticker: view.escrowTicker, payoutCoin: payout, recipient: recipientKey } })}>
              {t('settle.privateReceipt')}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
