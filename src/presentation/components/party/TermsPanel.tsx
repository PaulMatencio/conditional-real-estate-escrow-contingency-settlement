'use client';
import { useState } from 'react';
import { FileLock2 } from 'lucide-react';
import { checkTermsAgainstLedger, selectiveOpening } from '@/application/termsService';
import { isTermsPackage, type TermsPackage } from '@/domain/terms';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Mono } from '../ui';
import { FilePick, TypedConfirmDialog, downloadJson, readJsonFile } from './helpers';

/**
 * Private Terms Vault for one party (FR-TERMS-03..06): import the package (plain, passphrase-sealed or an X25519
 * envelope addressed to this browser), check it against the ledger, back it up, hand out single openings, erase.
 */
export function TermsPanel({ canBackup = true }: { canBackup?: boolean }) {
  const { t } = useT();
  const { record, updateRecord, view, identity, identities, eraseLocal, contractAddress } = useEscrow();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [pass, setPass] = useState('');
  const [erase, setErase] = useState(false);
  const pkg = record.terms;
  const check = pkg && view ? checkTermsAgainstLedger(termsCrypto, pkg, view) : null;

  const importFile = async (f: File) => {
    try {
      const raw = await readJsonFile(f);
      let p: unknown = raw;
      if (isEnvelope(raw)) {
        // The envelope may be addressed to the current key or to an earlier one (restored from a vault backup).
        const me = identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(identities.length ? 'This envelope is addressed to another key.' : t('terms.noIdentity'));
        p = await openEnvelope(raw, me);
      } else if (isSealedJson(raw)) {
        if (!pass) throw new Error(t('terms.needPass'));
        p = await openWithPassphrase(raw, pass);
      }
      if (!isTermsPackage(p)) throw new Error(t('terms.badFile'));
      if (p.contractAddress && contractAddress && p.contractAddress !== contractAddress) throw new Error(t('terms.otherContract'));
      const bound: TermsPackage = { ...p, contractAddress: contractAddress ?? p.contractAddress, escrowColor: view?.escrowColor ?? p.escrowColor, escrowTicker: view?.escrowTicker ?? p.escrowTicker };
      await updateRecord((r) => ({ ...r, terms: { ...bound, vaultIndex: bound.vaultIndex ?? r.terms?.vaultIndex } }));
      setMsg({ tone: 'ok', text: t('terms.imported') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  return (
    <Card title={t('terms.title')} icon={<FileLock2 size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('terms.hint')}</p>
      {identity && (
        <Field label={t('terms.myEnvelopeKey')} hint={t('terms.myEnvelopeKeyHint')}>
          <Mono value={identity.publicKey} />
        </Field>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <FilePick label={t('terms.import')} accept="application/json,.json" onFile={(f) => void importFile(f)} />
        <input type="password" className="input !w-56" placeholder={t('terms.passOptional')} aria-label={t('terms.passOptional')} value={pass} onChange={(e) => setPass(e.target.value)} />
      </div>
      {msg && <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      {pkg && (
        <div className="mt-3 space-y-3">
          {check && (
            <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
              <span className="text-slate-400">{t('terms.check')}:</span>
              {(['amount', 'buyerPayout', 'sellerPayout'] as const).map((k) => (
                <Badge key={k} tone={check[k] === 'match' ? 'ok' : check[k] === 'unset' ? 'muted' : 'bad'}>
                  {k}: {check[k]}
                </Badge>
              ))}
            </div>
          )}
          {check && !check.ok && check.amount !== 'unset' && <Alert tone="bad">TERMS_COMMITMENT_MISMATCH — {t('terms.mismatch')}</Alert>}
          <p className="text-sm text-slate-300">
            {t('terms.amount')}: <strong>{pkg.terms.amount}</strong> {pkg.escrowTicker ?? view?.escrowTicker} · {t('terms.vaultIndex')}: {pkg.vaultIndex ?? '—'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={() => downloadJson('opening-amount.json', selectiveOpening(pkg, 'amount'))}>
              {t('terms.openingAmount')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => downloadJson('opening-buyer-payout.json', selectiveOpening(pkg, 'buyerPayout'))}>
              {t('terms.openingBuyer')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => downloadJson('opening-seller-payout.json', selectiveOpening(pkg, 'sellerPayout'))}>
              {t('terms.openingSeller')}
            </button>
          </div>
          {canBackup && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={pass.length < 8}
                onClick={() =>
                  void sealWithPassphrase(pkg, pass).then(async (s) => {
                    downloadJson(`terms-backup-${(contractAddress ?? 'escrow').slice(0, 8)}.json`, s);
                    await updateRecord((r) => ({ ...r, backups: [...(r.backups ?? []), { at: Date.now(), kind: 'file' }] }));
                    setMsg({ tone: 'ok', text: t('terms.backedUp') });
                  })
                }
              >
                {t('terms.backup')}
              </button>
              <span className="text-xs text-slate-500">
                {t('terms.backups')}: {record.backups?.length ?? 0}
              </span>
            </div>
          )}
          <button type="button" className="btn-danger" onClick={() => setErase(true)}>
            {t('terms.erase')}
          </button>
        </div>
      )}
      {erase && (
        <TypedConfirmDialog
          title={t('terms.eraseTitle')}
          phrase={t('confirm.phraseErase')}
          alsoAccept={['ERASE']}
          cancelLabel={t('confirm.keepData')}
          body={
            <>
              <p>{t('terms.eraseBody')}</p>
              <p className="text-warn">{t('roleKey.eraseWarn')}</p>
            </>
          }
          confirmLabel={t('terms.eraseConfirm')}
          onCancel={() => setErase(false)}
          onConfirm={() => void eraseLocal().then(() => setErase(false))}
        />
      )}
    </Card>
  );
}
