'use client';
import { useCallback, useEffect, useState } from 'react';
import { Building, FileLock2, RefreshCw, Send } from 'lucide-react';
import type { CaspIssuerKey } from '@/application/partyPorts';
import { finalizeBlockers } from '@/application/partyService';
import { checkTermsAgainstLedger, createTermsPackage, lenderPackageOf } from '@/application/termsService';
import { friendlyMessage } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { isHex32, shortHex } from '@/domain/hex';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase, sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { COMMITMENT_KEYS, TERMS_PRE_COOLING_OFF_MESSAGE, TERMS_V1_MESSAGE, fmtRate, isPreCoolingOffPackage, isTermsPackage, isV1TermsPackage, penaltyOf, type TermsPackage } from '@/domain/terms';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { wireMetaOf } from '@/domain/escrowMeta';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { decimalsOf, formatAmount, parseAmount } from '@/domain/amount';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Mono } from '../ui';
import { VaultGate } from '../party/PartySetup';
import { PresetButton } from './usePreset';
import { FilePick, downloadJson, readJsonFile } from '../party/helpers';

const RECIPIENTS = ['buyer', 'seller', 'resolver', 'custodian', 'lender'] as const;
type Recipient = (typeof RECIPIENTS)[number];

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
  const [form, setForm] = useState({ price: '', deposit: '', buyer: '', seller: '', lender: '', refund: true, rate: '0' });
  const [recip, setRecip] = useState<Record<Recipient, string>>({ buyer: '', seller: '', resolver: '', custodian: '', lender: '' });
  const [pass, setPass] = useState('');
  const [restorePass, setRestorePass] = useState('');
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
  // The parties accept from their own pages: poll the chain so acceptances (and other changes) show up here.
  useEffect(() => {
    if (!addr) return;
    const id = setInterval(() => void reload(), 15_000);
    return () => clearInterval(id);
  }, [addr, reload]);
  useEffect(() => {
    void esc.casp.issuerKeys().then((k) => setKeys(k.keys), () => setKeys([]));
  }, [esc.casp]);

  if (!addr) return <Alert tone="warn">{t('contract.title')}: {t('contract.notSet')}</Alert>;
  const check = pkg && view ? checkTermsAgainstLedger(termsCrypto, pkg, view) : null;
  const blockers = view ? finalizeBlockers(view, esc.record, termsCrypto, BigInt(Math.floor(Date.now() / 1000))) : [];

  const mode = view?.financing.mode ?? null;
  const loanMode = mode === 'Deposited';
  // Amounts are typed in whole tokens and committed in base units (decimals chosen at deploy, default 6).
  const decimals = decimalsOf(esc.record.meta?.decimals, esc.record.terms?.escrowDecimals);
  const fmt = (v: bigint | string) => formatAmount(v, decimals);
  const priceBase = parseAmount(form.price, decimals);
  const depositBase = loanMode ? parseAmount(form.deposit, decimals) : priceBase;
  const loanAmount = (() => {
    if (!loanMode) return null;
    if (priceBase === null || depositBase === null) return null;
    return priceBase - depositBase;
  })();

  // Cooling-off: the period is public (Financing card); the penalty, a rate of the price, is a private term.
  const coolingOff = view?.coolingOff.period ?? null;
  const coolOn = !!coolingOff && coolingOff > 0n;
  /** "1.5" (%) → "150" (basis points); null when not a number with at most two decimals. */
  const rateBps = (() => {
    const v = form.rate.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
    const [i, d = ''] = v.split('.');
    return (BigInt(i) * 100n + BigInt((d + '00').slice(0, 2))).toString();
  })();
  const penaltyPreview = (() => {
    if (!coolOn || rateBps === null || priceBase === null) return null;
    return penaltyOf(priceBase, BigInt(rateBps));
  })();

  /** The escrow's name as saved in the vault (not the possibly older copy held in memory). */
  const currentName = async () => (addr && esc.vaultUnlocked ? wireMetaOf((await sharedVault().load(addr)).meta) : wireMetaOf(esc.record.meta));

  const generate = async () => {
    try {
      if (!mode) throw new Error(t('adminTerms.needMode'));
      if (coolingOff === null) throw new Error(t('cool.needFinancing'));
      if (coolOn && rateBps === null) throw new Error(t('cool.badRate'));
      if (priceBase === null || depositBase === null) throw new Error(t('amount.bad').replace('{decimals}', String(decimals)));
      const p = createTermsPackage(termsCrypto, {
        price: priceBase.toString(),
        buyerDeposit: depositBase.toString(),
        buyerPayout: form.buyer,
        sellerPayout: form.seller,
        lenderPayout: loanMode ? form.lender : undefined,
        refundOnLoss: loanMode ? form.refund : true,
        penaltyRate: coolOn ? rateBps! : '0',
        coolingOff: coolOn,
        mode: loanMode ? 'deposited' : 'attested',
        contractAddress: addr,
        escrowColor: view?.escrowColor,
        escrowTicker: view?.escrowTicker,
        escrowDecimals: decimals
      });
      // The deployment's name travels with the package (encrypted), so every party's vault shows the same label.
      // Read from the vault itself, so a name saved a moment ago (right after the deploy) is never missed.
      const meta = await currentName();
      await esc.updateRecord((r) => ({ ...r, terms: meta ? { ...p, meta } : p }));
      setMsg({ tone: 'ok', text: t('adminTerms.generated') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  /**
   * Brings the package back into this vault from the admin's passphrase backup (terms-backup-….json), from an envelope
   * addressed to this browser, or from a plain package. It must open the commitments already on-chain: a package that
   * does not would mean configuring again (and both parties accepting again).
   */
  const restorePackage = async (f: File) => {
    setMsg(null);
    try {
      const raw = await readJsonFile(f);
      if (isV1TermsPackage(raw)) throw new Error(TERMS_V1_MESSAGE);
      let p: unknown = raw;
      if (isEnvelope(raw)) {
        const me = esc.identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(t('custody.notForMe'));
        p = await openEnvelope(raw, me);
      } else if (isSealedJson(raw)) {
        if (!restorePass) throw new Error(t('terms.needPass'));
        p = await openWithPassphrase(raw, restorePass);
      }
      if (isV1TermsPackage(p)) throw new Error(TERMS_V1_MESSAGE);
      if (isPreCoolingOffPackage(p)) throw new Error(TERMS_PRE_COOLING_OFF_MESSAGE);
      if (!isTermsPackage(p)) throw new Error(t('terms.badFile'));
      if (p.contractAddress && p.contractAddress !== addr) throw new Error(t('terms.otherContract'));
      const bound: TermsPackage = { ...p, contractAddress: addr, escrowColor: view?.escrowColor ?? p.escrowColor, escrowTicker: view?.escrowTicker ?? p.escrowTicker };
      if (view) {
        const c = checkTermsAgainstLedger(termsCrypto, bound, view);
        if (!c.ok && c.amount !== 'unset') throw new Error(`TERMS_COMMITMENT_MISMATCH — ${t('terms.mismatch')}`);
      }
      // The backup the admin just used counts as a confirmed backup (finalize needs one).
      await esc.updateRecord((r) => ({ ...r, terms: bound, backups: r.backups?.length ? r.backups : [{ at: Date.now(), kind: 'file', note: f.name }] }));
      setRestorePass('');
      setMsg(view ? { tone: 'ok', text: t('adminTerms.restored') } : { tone: 'warn', text: t('adminTerms.restoredUnchecked') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };
  const committedButMissing = !pkg && !!view?.commitments.amount;

  /** The eight commitments go on-chain in two transactions: configure (3) and configureFinancing (5). */
  const commit = async (p: TermsPackage) => {
    await app.configure({ amountCommitment: p.commitments.amount, buyerPayoutCommitment: p.commitments.buyerPayout, sellerPayoutCommitment: p.commitments.sellerPayout });
    await app.configureFinancing({
      priceCommitment: p.commitments.price,
      lenderShareCommitment: p.commitments.lenderShare,
      lenderPayoutCommitment: p.commitments.lenderPayout,
      loanTermsCommitment: p.commitments.loanTerms,
      coolingOffCommitment: p.commitments.coolingOff
    });
    await reload();
  };

  /** Recipients this escrow needs: the lender only in a loan deal (and it gets the lender package, not the full terms). */
  const recipients = RECIPIENTS.filter((r) => r !== 'lender' || loanMode);
  /** Each copy carries the escrow's current name (a rename after generating the package is picked up here). */
  const named = async (p: TermsPackage): Promise<TermsPackage> => {
    const meta = await currentName();
    return meta ? { ...p, meta } : p;
  };
  const sealFor = async (r: Recipient, p: TermsPackage) => (r === 'lender' ? sealTo(lenderPackageOf(await named(p)), recip[r].trim(), r) : sealTo(await named(p), recip[r].trim(), r));

  return (
    <div className="space-y-4">
      <VaultGate />
      {msg && <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Card title={t('adminTerms.title')} icon={<FileLock2 size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t('adminTerms.hint')}</p>
        {!pkg && esc.vaultUnlocked && (
          <div className="mb-4 rounded-xl border border-midnight-700 p-3">
            {committedButMissing && (
              <div className="mb-2">
                <Alert tone="warn">{t('adminTerms.missingPkg')}</Alert>
              </div>
            )}
            <p className="mb-2 text-sm text-slate-300">{t('adminTerms.restoreHint')}</p>
            <div className="flex flex-wrap items-end gap-2">
              <input type="password" className="input !w-56" placeholder={t('terms.passOptional')} aria-label={t('terms.passOptional')} value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
              <FilePick label={t('adminTerms.restore')} accept="application/json,.json" onFile={(f) => void restorePackage(f)} />
            </div>
          </div>
        )}
        {!mode && (
          <div className="mb-3">
            <Alert tone="warn">{t('adminTerms.needMode')}</Alert>
          </div>
        )}
        {mode && (
          <p className="mb-3 text-sm text-slate-300">
            {t('financing.mode')}: <Badge tone="accent">{t(loanMode ? 'financing.modeLoan' : 'financing.modeCash')}</Badge>
          </p>
        )}
        <PresetButton onApply={(v) => setForm((f) => ({ ...f, price: v.price, deposit: v.deposit, refund: v.refundOnLoss, rate: v.penaltyPct }))} />
        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field label={`${t('adminTerms.price')} (${view?.escrowTicker ?? ''})`} hint={t(loanMode ? 'adminTerms.priceHint' : 'adminTerms.priceCashHint')} htmlFor="t-price">
            <input id="t-price" className="input" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          {loanMode && (
            <>
              <Field label={`${t('adminTerms.deposit')} (${view?.escrowTicker ?? ''})`} hint={t('adminTerms.depositHint')} htmlFor="t-deposit">
                <input id="t-deposit" className="input" inputMode="decimal" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} />
              </Field>
              <Field label={`${t('adminTerms.loan')} (${view?.escrowTicker ?? ''})`} hint={t('adminTerms.loanHint')}>
                <p className={`input !border-transparent ${loanAmount !== null && loanAmount <= 0n ? 'text-bad' : ''}`} aria-live="polite">
                  {loanAmount === null ? '—' : fmt(loanAmount)}
                </p>
              </Field>
            </>
          )}
        </div>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field label={t('adminTerms.buyerKey')} htmlFor="t-buyer" hint={t('adminTerms.keyHint')}>
            <input id="t-buyer" className="input mono" value={form.buyer} onChange={(e) => setForm({ ...form, buyer: e.target.value })} spellCheck={false} />
          </Field>
          <Field label={t('adminTerms.sellerKey')} htmlFor="t-seller">
            <input id="t-seller" className="input mono" value={form.seller} onChange={(e) => setForm({ ...form, seller: e.target.value })} spellCheck={false} />
          </Field>
          {loanMode && (
            <Field label={t('adminTerms.lenderKey')} hint={t('adminTerms.lenderKeyHint')} htmlFor="t-lender">
              <input id="t-lender" className="input mono" value={form.lender} onChange={(e) => setForm({ ...form, lender: e.target.value })} spellCheck={false} />
            </Field>
          )}
        </div>
        {coolOn && (
          <div className="grid gap-x-4 sm:grid-cols-3">
            <Field label={t('cool.rateField')} hint={t('cool.rateHint')} htmlFor="t-rate">
              <input id="t-rate" className="input" inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            </Field>
            <Field label={`${t('cool.penalty')} (${view?.escrowTicker ?? ''})`} hint={t('cool.penaltyFieldHint')}>
              <p
                className={`input !border-transparent ${penaltyPreview !== null && depositBase !== null && penaltyPreview >= depositBase ? 'text-bad' : ''}`}
                aria-live="polite"
              >
                {penaltyPreview === null ? '—' : fmt(penaltyPreview)}
              </p>
            </Field>
          </div>
        )}
        {coolingOff === 0n && <p className="mb-3 text-xs text-slate-500">{t('cool.offHint')}</p>}
        {loanMode && (
          <label className="mb-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.refund} onChange={(e) => setForm({ ...form, refund: e.target.checked })} />
            <span>
              <strong>{t('adminTerms.refund')}</strong>
              <span className="block text-xs text-slate-400">{t(form.refund ? 'adminTerms.refundOn' : 'adminTerms.refundOff')}</span>
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={!esc.vaultUnlocked || !mode || (!!pkg && !!view?.commitments.amount)} onClick={() => void generate()}>
            {t('adminTerms.generate')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!pkg || busy || view?.status !== 'Initializing'}
            onClick={() => pkg && void commit(pkg)}
          >
            {t('adminTerms.commit')}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">{t('adminTerms.commitHint')}</p>
        {pkg && (
          <div className="mt-3 space-y-1 text-sm">
            <p className="text-slate-300">
              {t('adminTerms.price')}: <strong>{fmt(pkg.terms.price)}</strong> · {t('adminTerms.deposit')}: <strong>{fmt(pkg.terms.amount)}</strong> · {t('adminTerms.loan')}: <strong>{fmt(pkg.terms.lenderShare)}</strong> {view?.escrowTicker}
              {BigInt(pkg.terms.lenderShare) > 0n && <> · {t(pkg.terms.refundOnLoss ? 'adminTerms.refundYes' : 'adminTerms.refundNo')}</>}
              {BigInt(pkg.terms.penaltyRate) > 0n && (
                <>
                  {' '}
                  · {t('cool.penalty')}: <strong>{fmt(pkg.terms.penalty)}</strong> ({fmtRate(pkg.terms.penaltyRate)})
                </>
              )}
            </p>
            {COMMITMENT_KEYS.map((k) => (
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
          {recipients.map((r) => (
            <Field key={r} label={t('adminTerms.envKey').replace('{who}', r)} hint={t(r === 'custodian' ? 'adminTerms.envFromCustodian' : r === 'lender' ? 'adminTerms.envFromLender' : 'adminTerms.envFromParty').replace('{who}', r)} htmlFor={`env-${r}`}>
              <div className="flex gap-2">
                <input id={`env-${r}`} className="input mono" value={recip[r]} onChange={(e) => setRecip({ ...recip, [r]: e.target.value })} spellCheck={false} />
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!recip[r].trim()}
                  onClick={() =>
                    void sealFor(r, pkg).then(
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
                void named(pkg).then((n) => sealWithPassphrase(n, pass)).then(async (s) => {
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
        <Card
          title={t('init.finalize')}
          actions={
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs normal-case tracking-normal" onClick={() => void reload()}>
              <RefreshCw size={12} aria-hidden /> {t('common.refresh')}
            </button>
          }
        >
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
            <span className="text-slate-400">
              {t('adminTerms.acceptance')} (v{String(view.configVersion)}):
            </span>
            <Badge tone={view.buyerAccepted ? 'ok' : 'muted'}>buyer {view.buyerAccepted ? '✓' : '—'}</Badge>
            <Badge tone={view.sellerAccepted ? 'ok' : 'muted'}>seller {view.sellerAccepted ? '✓' : '—'}</Badge>
          </div>
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
