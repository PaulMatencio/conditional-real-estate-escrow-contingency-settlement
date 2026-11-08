'use client';
import { useCallback, useEffect, useState } from 'react';
import { Building, FileLock2, Send } from 'lucide-react';
import type { CaspIssuerKey } from '@/application/partyPorts';
import { finalizeBlockers } from '@/application/partyService';
import { checkTermsAgainstLedger, createTermsPackage } from '@/application/termsService';
import { friendlyMessage } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { isHex32, shortHex } from '@/domain/hex';
import { sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Mono } from '../ui';
import { VaultGate } from '../party/PartySetup';
import { downloadJson } from '../party/helpers';

const RECIPIENTS = ['buyer', 'seller', 'resolver', 'custodian'] as const;

/**
 * Admin, Phase 2 (§3.1.5, FR-TERMS-01/02/04, FR-DEPLOY-03/04): build the private terms package from the amount and
 * the payout keys the parties sent, commit only the three commitments, distribute encrypted copies, whitelist the
 * CASP, and finalize only when both parties accepted and a backup exists.
 */
export function TermsKycTab() {
  const { t } = useT();
  const app = useApp();
  const esc = useEscrow();
  const [view, setView] = useState<EscrowView | null>(null);
  const [form, setForm] = useState({ amount: '', buyer: '', seller: '' });
  const [recip, setRecip] = useState<Record<(typeof RECIPIENTS)[number], string>>({ buyer: '', seller: '', resolver: '', custodian: '' });
  const [pass, setPass] = useState('');
  const [keys, setKeys] = useState<CaspIssuerKey[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const addr = app.contractAddress;
  const pkg = esc.record.terms;
  const busy = app.progress?.status === 'running';

  // The admin's vault record is the one of the contract loaded in the admin console.
  useEffect(() => {
    if (esc.mode !== 'wallet') esc.setMode('wallet');
    if (addr && esc.contractAddress !== addr) void esc.setContractAddress(addr);
  }, [addr, esc]);

  const reload = useCallback(async () => {
    if (!addr) return;
    try {
      setView(await readPublicView(addr));
    } catch (e) {
      setMsg({ tone: 'bad', text: friendlyMessage(e) });
    }
  }, [addr]);
  useEffect(() => void reload(), [reload, app.state]);
  useEffect(() => {
    void esc.casp.issuerKeys().then((k) => setKeys(k.keys), () => setKeys([]));
  }, [esc.casp]);

  if (!addr) return <Alert tone="warn">{t('contract.title')}: {t('contract.notSet')}</Alert>;
  const check = pkg && view ? checkTermsAgainstLedger(termsCrypto, pkg, view) : null;
  const blockers = view ? finalizeBlockers(view, esc.record, termsCrypto, BigInt(Math.floor(Date.now() / 1000))) : [];

  const generate = async () => {
    try {
      const p = createTermsPackage(termsCrypto, { amount: form.amount, buyerPayout: form.buyer, sellerPayout: form.seller, contractAddress: addr, escrowColor: view?.escrowColor, escrowTicker: view?.escrowTicker });
      await esc.updateRecord((r) => ({ ...r, terms: p }));
      setMsg({ tone: 'ok', text: t('adminTerms.generated') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <VaultGate />
      {msg && <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Card title={t('adminTerms.title')} icon={<FileLock2 size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t('adminTerms.hint')}</p>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field label={`${t('terms.amount')} (${view?.escrowTicker ?? ''})`} htmlFor="t-amount">
            <input id="t-amount" className="input" inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label={t('adminTerms.buyerKey')} htmlFor="t-buyer" hint={t('adminTerms.keyHint')}>
            <input id="t-buyer" className="input mono" value={form.buyer} onChange={(e) => setForm({ ...form, buyer: e.target.value })} spellCheck={false} />
          </Field>
          <Field label={t('adminTerms.sellerKey')} htmlFor="t-seller">
            <input id="t-seller" className="input mono" value={form.seller} onChange={(e) => setForm({ ...form, seller: e.target.value })} spellCheck={false} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={!esc.vaultUnlocked || (!!pkg && !!view?.commitments.amount)} onClick={() => void generate()}>
            {t('adminTerms.generate')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!pkg || busy || view?.status !== 'Initializing'}
            onClick={() => pkg && void app.configure({ amountCommitment: pkg.commitments.amount, buyerPayoutCommitment: pkg.commitments.buyerPayout, sellerPayoutCommitment: pkg.commitments.sellerPayout })}
          >
            {t('adminTerms.commit')}
          </button>
        </div>
        {pkg && (
          <div className="mt-3 space-y-1 text-sm">
            {(['amount', 'buyerPayout', 'sellerPayout'] as const).map((k) => (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-slate-400">{k}</span>
                <span className="mono">{shortHex(pkg.commitments[k], 12, 8)}</span>
                {check && <Badge tone={check[k] === 'match' ? 'ok' : check[k] === 'unset' ? 'muted' : 'bad'}>{check[k]}</Badge>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {pkg && (
        <Card title={t('adminTerms.distribute')} icon={<Send size={16} aria-hidden />}>
          <p className="mb-3 text-sm text-slate-400">{t('adminTerms.distributeHint')}</p>
          {RECIPIENTS.map((r) => (
            <Field key={r} label={`${r} — ${t('terms.myEnvelopeKey')}`} htmlFor={`env-${r}`}>
              <div className="flex gap-2">
                <input id={`env-${r}`} className="input mono" value={recip[r]} onChange={(e) => setRecip({ ...recip, [r]: e.target.value })} spellCheck={false} />
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!recip[r].trim()}
                  onClick={() =>
                    void sealTo(pkg, recip[r].trim(), r).then(
                      async (env) => {
                        downloadJson(`terms-for-${r}.json`, env);
                        if (r === 'custodian') await esc.updateRecord((x) => ({ ...x, backups: [...(x.backups ?? []), { at: Date.now(), kind: 'custodian' }] }));
                      },
                      (e) => setMsg({ tone: 'bad', text: e.message })
                    )
                  }
                >
                  {t('adminTerms.seal')}
                </button>
              </div>
            </Field>
          ))}
          <div className="flex flex-wrap gap-2">
            <input type="password" className="input !w-56" placeholder={t('vault.passphrase')} aria-label={t('vault.passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
            <button
              type="button"
              className="btn-ghost"
              disabled={pass.length < 8}
              onClick={() =>
                void sealWithPassphrase(pkg, pass).then(async (s) => {
                  downloadJson(`terms-backup-${addr.slice(0, 8)}.json`, s);
                  await esc.updateRecord((x) => ({ ...x, backups: [...(x.backups ?? []), { at: Date.now(), kind: 'file' }] }));
                })
              }
            >
              {t('terms.backup')}
            </button>
            <span className="self-center text-xs text-slate-500">
              {t('terms.backups')}: {esc.record.backups?.length ?? 0}
            </span>
          </div>
        </Card>
      )}

      <Card title={t('adminTerms.casp')} tip={t('tip.adminTerms.casp')} icon={<Building size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t('adminTerms.caspHint')}</p>
        {keys.length === 0 && <Alert tone="warn">{t('casp.offline')}</Alert>}
        <ul className="space-y-2 text-sm">
          {keys.map((k) => {
            const on = view?.kycIssuers.some((i) => i.issuerId === k.issuerId);
            return (
              <li key={k.issuerId} className="flex flex-wrap items-center gap-2">
                <Mono value={k.issuerId} />
                <Badge tone={k.status === 'active' ? 'ok' : 'bad'}>{k.status}</Badge>
                {on ? (
                  <button type="button" className="btn-danger !py-1" disabled={busy || view?.status !== 'Initializing'} onClick={() => void app.removeKycIssuer(k.issuerId)}>
                    {t('adminTerms.remove')}
                  </button>
                ) : (
                  <button type="button" className="btn-primary !py-1" disabled={busy || view?.status !== 'Initializing' || k.status !== 'active' || !isHex32(k.issuerId)} onClick={() => void app.addKycIssuer(k.issuerId, k.publicKey)}>
                    {t('adminTerms.add')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-slate-500">{t('adminTerms.versionWarn')}</p>
      </Card>

      {view?.status === 'Initializing' && (
        <Card title={t('init.finalize')}>
          {blockers.length ? blockers.map((b) => <Alert key={b} tone="warn">{b}</Alert>) : <Alert tone="ok">{t('adminTerms.ready')}</Alert>}
          <button type="button" className="btn-danger mt-3" disabled={busy || blockers.length > 0} onClick={() => void app.finalize()}>
            {t('init.finalize')}
          </button>
          <p className="mt-2 text-xs text-slate-500">{t('init.finalizeHint')}</p>
        </Card>
      )}
    </div>
  );
}
