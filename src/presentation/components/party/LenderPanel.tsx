'use client';
import { useEffect, useState } from 'react';
import { HandCoins, Landmark } from 'lucide-react';
import { checkLenderPackage, lenderOpening } from '@/application/termsService';
import { LENDER_COMMITMENT_KEYS, LENDER_OPENING_KINDS, isLenderPackage, isTermsPackage, type LenderPackage } from '@/domain/terms';
import { availableActions, type PartyCircuit } from '@/domain/lifecycle';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase } from '@/infrastructure/crypto/aead';
import { documentCommitment, loanCoinOf, newSalt, payoutOfCoin } from '@/infrastructure/crypto/escrowCrypto';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { useAmount } from '../useAmount';
import { Alert, Badge, Card, Field, Mono, Spinner, Stat } from '../ui';
import { ConfirmDialog, Countdown, FilePick, TypedConfirmDialog, downloadJson, fmtTime, readFileBytes, readJsonFile } from './helpers';
import { OpeningButtons } from '../OpeningButtons';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { OtherEscrowPrompt, type PendingImport } from './OtherEscrowPrompt';

/**
 * Lender page, contract v2 (loan mode). The lender receives only its part of the terms (the lender package: price,
 * loan amount, its payout key, the refund term), checks it against the four on-chain commitments, then funds the loan
 * (that deposit IS its approval), refuses it, withdraws it after the loan offer expiry, or claims it back on an unwind.
 */
export function LenderTermsCard() {
  const { t } = useT();
  const { record, updateRecord, updateRecordAt, switchEscrow, view, identity, identities, contractAddress } = useEscrow();
  const { fmt } = useAmount();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [pass, setPass] = useState('');
  const [remove, setRemove] = useState(false);
  const pkg = record.lenderTerms;
  const check = pkg && view ? checkLenderPackage(termsCrypto, pkg, view) : null;

  const importFile = async (f: File) => {
    setMsg(null);
    setPending(null);
    try {
      const raw = await readJsonFile(f);
      let p: unknown = raw;
      if (isEnvelope(raw)) {
        const me = identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(identities.length ? t('lender.notForMe') : t('terms.noIdentity'));
        p = await openEnvelope(raw, me);
      } else if (isSealedJson(raw)) {
        if (!pass) throw new Error(t('terms.needPass'));
        p = await openWithPassphrase(raw, pass);
      }
      // The lender gets the lender package; the full terms are for the buyer, seller and resolver.
      if (isTermsPackage(p)) throw new Error(t('lender.fullPackage'));
      if (!isLenderPackage(p)) throw new Error(t('lender.badFile'));
      // A package for another escrow: offer to store it there (after the same commitment check, against that escrow's
      // public ledger) and open that escrow; with no escrow open, just do it.
      if (p.contractAddress && p.contractAddress !== contractAddress) {
        const pkgFor = p;
        const address = p.contractAddress;
        const store = async () => {
          const c = checkLenderPackage(termsCrypto, pkgFor, await readPublicView(address));
          if (!c.ok) throw new Error(`TERMS_COMMITMENT_MISMATCH — ${t('lender.mismatch')}`);
          await updateRecordAt(address, (r) => ({ ...r, lenderTerms: pkgFor }));
        };
        if (contractAddress) return setPending({ address, meta: p.meta, store });
        await store();
        await switchEscrow(address);
        setPass('');
        setMsg({ tone: 'ok', text: t('lender.imported') });
        return;
      }
      const bound: LenderPackage = { ...p, contractAddress: contractAddress ?? p.contractAddress, escrowColor: view?.escrowColor ?? p.escrowColor, escrowTicker: view?.escrowTicker ?? p.escrowTicker };
      if (view) {
        const c = checkLenderPackage(termsCrypto, bound, view);
        if (!c.ok) throw new Error(`TERMS_COMMITMENT_MISMATCH — ${t('lender.mismatch')}`);
      }
      await updateRecord((r) => ({ ...r, lenderTerms: bound }));
      setPass('');
      setMsg({ tone: 'ok', text: t('lender.imported') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <Card title={t('lender.termsTitle')} tip={t('tip.lender.terms')} icon={<Landmark size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('lender.termsHint')}</p>
      {identity ? (
        <Field label={t('terms.myEnvelopeKey')} hint={t('lender.envelopeHint')}>
          <Mono value={identity.publicKey} />
        </Field>
      ) : (
        <Alert tone="warn">{t('terms.noIdentity')}</Alert>
      )}
      {pending && (
        <OtherEscrowPrompt
          pending={pending}
          onCancel={() => setPending(null)}
          onDone={(text) => {
            setPending(null);
            setPass('');
            setMsg({ tone: 'ok', text: `${t('lender.imported')} ${text}` });
          }}
        />
      )}
      {msg && (
        <div className="mb-3">
          <Alert tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Alert>
        </div>
      )}
      {!pkg ? (
        <div className="flex flex-wrap items-end gap-2">
          <FilePick label={t('lender.import')} accept="application/json,.json" onFile={(f) => void importFile(f)} />
          <input type="password" className="input !w-56" placeholder={t('terms.passOptional')} aria-label={t('terms.passOptional')} value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t('adminTerms.price')} value={fmt(pkg.price)} />
            <Stat label={t('adminTerms.loan')} value={fmt(pkg.lenderShare)} sub={t('lender.youDeposit')} />
            <Stat label={t('lender.refundTerm')} value={<span className="text-sm">{t(pkg.refundOnLoss ? 'adminTerms.refundYes' : 'adminTerms.refundNo')}</span>} />
          </div>
          {view && view.financing.mode === 'Deposited' && (
            <p className="text-sm text-slate-300">
              {t('financing.expiryField').replace(' (unix s)', '')}: <strong>{fmtTime(view.financing.loanOfferExpiry)}</strong> · {t('deadline.closing')}: {fmtTime(view.closingDeadline)}
            </p>
          )}
          <Field label={t('adminTerms.lenderKey')} hint={t('lender.payoutHint')}>
            <Mono value={pkg.lenderPayout} />
          </Field>
          {check && (
            <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
              <span className="text-slate-400">{t('terms.check')}:</span>
              {LENDER_COMMITMENT_KEYS.map((k) => (
                <Badge key={k} tone={check[k] === 'match' ? 'ok' : check[k] === 'unset' ? 'muted' : 'bad'}>
                  {k}: {check[k]}
                </Badge>
              ))}
            </div>
          )}
          {check && !check.ok && <Alert tone="bad">TERMS_COMMITMENT_MISMATCH — {t('lender.mismatch')}</Alert>}
          <div>
            <span className="label">{t('custody.openings')}</span>
            <OpeningButtons kinds={LENDER_OPENING_KINDS} make={(k) => lenderOpening(pkg, k as (typeof LENDER_OPENING_KINDS)[number])} />
          </div>
          <button type="button" className="btn-danger" onClick={() => setRemove(true)}>
            {t('lender.remove')}
          </button>
        </div>
      )}
      {remove && (
        <TypedConfirmDialog
          title={t('lender.removeTitle')}
          phrase={t('confirm.phraseRemove')}
          alsoAccept={['REMOVE']}
          body={<p className="text-warn">{t('lender.removeBody')}</p>}
          confirmLabel={t('lender.remove')}
          cancelLabel={t('confirm.keepData')}
          onCancel={() => setRemove(false)}
          onConfirm={() => void updateRecord(({ lenderTerms: _drop, ...rest }) => rest).then(() => setRemove(false))}
        />
      )}
    </Card>
  );
}

type LoanAction = 'depositLoan' | 'declineLoan' | 'withdrawLoan' | 'refundLender';

export function LoanCard() {
  const { t } = useT();
  const { view, now, record, run, busy, gateway, mode, updateRecord } = useEscrow();
  const { fmt } = useAmount();
  const [doc, setDoc] = useState<{ name: string; salt: string; hash: string } | null>(null);
  const [pending, setPending] = useState<LoanAction | null>(null);
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const pkg = record.lenderTerms;

  useEffect(() => {
    if (!view) return;
    void gateway().then((g) => g.shieldedBalance(view.escrowColor)).then(setBalance, () => setBalance(null));
  }, [gateway, view]);

  if (!view || view.financing.mode !== 'Deposited') return null;
  const f = view.financing;
  const material = { terms: !!record.terms, kycAttestation: false, vaultCoin: true, lenderTerms: !!pkg, secondCoin: true };
  const actions = Object.fromEntries(availableActions(view, 'lender', now, material).map((a) => [a.circuit, a])) as Partial<Record<PartyCircuit, { enabled: boolean; reason: string | null }>>;
  const need = pkg ? BigInt(pkg.lenderShare) : null;

  const pick = async (file: File) => {
    const bytes = await readFileBytes(file);
    const salt = newSalt();
    setDoc({ name: file.name, salt, hash: await documentCommitment(bytes, salt) });
  };

  const execute = async (a: LoanAction) => {
    setPending(null);
    const args = a === 'depositLoan' || a === 'declineLoan' ? [doc!.hash] : [];
    const r = await run('lender', a as never, args as never);
    if (r && doc && (a === 'depositLoan' || a === 'declineLoan')) {
      // Keep the letter's salt: the hash on-chain only proves the letter to someone given both.
      await updateRecord((rec) => ({ ...rec, documents: [...(rec.documents ?? []), { contingency: 'Financing', reportHash: doc.hash, salt: doc.salt, fileName: doc.name, at: Date.now() }] }));
      setDoc(null);
    }
  };

  const status = f.topUpHeld
    ? { tone: 'ok' as const, text: t('lender.st.toppedUp') }
    : f.loanHeld
      ? { tone: 'ok' as const, text: t(f.secondCoinPaid ? 'lender.st.paidOut' : 'lender.st.deposited') }
      : f.loanWithdrawn
        ? { tone: 'warn' as const, text: t('lender.st.withdrawn') }
        : f.loanLost
          ? { tone: 'warn' as const, text: t('lender.st.refused') }
          : { tone: 'warn' as const, text: t(view.status === 'ContingenciesPending' ? 'lender.st.waiting' : 'lender.st.notYet') };

  const button = (a: LoanAction, danger: boolean, needsDoc = false) => {
    const s = actions[a];
    const reason = s?.reason ?? (needsDoc && !doc ? t('lender.needLetter') : null);
    return (
      <div className="flex flex-col gap-1">
        <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || !s?.enabled || (needsDoc && !doc)} onClick={() => setPending(a)}>
          {busy ? <Spinner /> : null} {t(`circuit.${a}` as MessageKey)}
        </button>
        {reason && <span className="text-xs text-warn">{reason}</span>}
      </div>
    );
  };

  return (
    <Card title={t('lender.loanTitle')} tip={t('tip.lender.loan')} icon={<HandCoins size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('lender.loanHint')}</p>
      <div className="mb-3">
        <Alert tone={status.tone}>{status.text}</Alert>
      </div>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Stat label={t('adminTerms.loan')} value={need === null ? '—' : fmt(need)} />
        <Stat
          label={t('fund.balance')}
          value={balance === undefined ? '…' : balance === null ? '—' : fmt(balance)}
          sub={need !== null && balance !== null && balance !== undefined && balance < need ? `${t('fund.shortfall')} ${fmt(need - balance)}` : mode === 'simulator' ? t('fund.simBalance') : undefined}
        />
        {f.loanHeld && !f.secondCoinPaid && view.status === 'ContingenciesPending' ? (
          now < f.loanOfferExpiry ? <Countdown to={f.loanOfferExpiry} now={now} label={t('lender.withdrawFrom')} /> : <Stat label={t('lender.withdrawFrom')} value={<span className="text-sm">{t('lender.withdrawOpen')}</span>} />
        ) : (
          view.status === 'ContingenciesPending' && !f.loanLost && !f.topUpHeld && <Countdown to={f.loanOfferExpiry} now={now} label={t('lender.offerExpires')} />
        )}
      </div>
      {!pkg && <Alert tone="warn">{t('lender.needPackage')}</Alert>}

      {view.status === 'ContingenciesPending' && !f.loanHeld && !f.loanLost && !f.topUpHeld && (
        <div className="space-y-3">
          <Field label={t('lender.letter')} hint={t('lender.letterHint')}>
            <div className="flex flex-wrap items-center gap-2">
              <FilePick label={t('attest.pick')} onFile={(file) => void pick(file)} />
              {doc && <span className="text-sm text-slate-300">{doc.name}</span>}
            </div>
          </Field>
          {doc && (
            <Field label={t('attest.hash')} hint={t('attest.hashHint')}>
              <Mono value={doc.hash} />
            </Field>
          )}
          <div className="flex flex-wrap gap-3">
            {button('depositLoan', false, true)}
            {button('declineLoan', true, true)}
          </div>
        </div>
      )}
      {f.loanHeld && !f.secondCoinPaid && view.status === 'ContingenciesPending' && <div className="mt-2">{button('withdrawLoan', true)}</div>}
      {f.loanHeld && !f.secondCoinPaid && ['Refunded', 'Expired', 'Withdrawn', 'Forfeited'].includes(view.status) && <div className="mt-2">{button('refundLender', false)}</div>}
      {pkg && view.contractAddress && (f.loanWithdrawn || (f.loanHeld && f.secondCoinPaid)) && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-400">{t(f.loanWithdrawn ? 'lender.repaidWithdrawn' : 'lender.repaidMaybe')}</p>
          {(() => {
            const coin = payoutOfCoin(loanCoinOf(view.contractAddress, view.escrowColor, pkg));
            return (
              <>
                <Field label="nonce">
                  <Mono value={coin.nonce} />
                </Field>
                <p className="text-slate-300">
                  {fmt(coin.value)} · {t('settle.to')} <span className="mono">{pkg.lenderPayout.slice(0, 12)}…</span>
                </p>
                <button type="button" className="btn-ghost" onClick={() => downloadJson('loan-repayment-coin.json', { ...coin, recipient: pkg.lenderPayout, contractAddress: view.contractAddress })}>
                  {t('settle.exportCoin')}
                </button>
              </>
            );
          })()}
        </div>
      )}

      {pending && (
        <ConfirmDialog
          title={t(`circuit.${pending}` as MessageKey)}
          body={t(`lender.confirm.${pending}` as MessageKey).replace('{amount}', need === null ? '' : fmt(need)).replace('{term}', t(pkg?.refundOnLoss ? 'adminTerms.refundYes' : 'adminTerms.refundNo'))}
          confirmLabel={t('actions.confirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => void execute(pending)}
        />
      )}
    </Card>
  );
}
