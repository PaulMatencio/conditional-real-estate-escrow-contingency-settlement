'use client';
import { useCallback, useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { checkTermsAgainstLedger, selectiveOpening } from '@/application/termsService';
import type { VaultRecord } from '@/application/partyPorts';
import type { EscrowView } from '@/domain/escrowView';
import { COMMITMENT_KEYS, isTermsPackage, type Opening, type TermsPackage } from '@/domain/terms';
import { OpeningButtons, TermsAmounts, openingKindsFor } from '../OpeningButtons';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase, sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { termsCrypto } from '@/infrastructure/crypto/termsCrypto';
import { MIN_BACKUP_PASSPHRASE } from '@/infrastructure/storage/vaultBackupStore';
import { sharedVault, vaultSignal } from '@/infrastructure/storage/vaultInstance';
import { withPackageMeta } from '@/application/escrowDirectory';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Mono } from '../ui';
import { VaultGate } from '../party/PartySetup';
import { FilePick, TypedConfirmDialog, downloadJson, readJsonFile } from '../party/helpers';

type Custody = NonNullable<VaultRecord['custody']>;
const HANDOUT_TO = ['buyer', 'seller', 'resolver', 'other'] as const;

/**
 * Custodian of the private terms package (e.g. the notary): an escrowed backup held outside the deal. The custodian has
 * its own vault and envelope key; the admin encrypts `terms-for-custodian.json` to that key. Here the custodian imports
 * it (checked against the on-chain commitments, stored encrypted), and later hands a party a fresh encrypted copy,
 * exports a single opening, or archives it offline. The custodian holds no role key: it can never act on the escrow.
 */
export function CustodianCard({ view, onOpening }: { view: EscrowView; onOpening?: (o: Opening) => void }) {
  const { t } = useT();
  const { vaultUnlocked, identity, identities } = useEscrow();
  const addr = view.contractAddress;
  const [custody, setCustody] = useState<Custody | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [importPass, setImportPass] = useState('');
  const [to, setTo] = useState<(typeof HANDOUT_TO)[number]>('buyer');
  const [toKey, setToKey] = useState('');
  const [archivePass, setArchivePass] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const reload = useCallback(async () => {
    if (!vaultUnlocked) return setCustody(null);
    setCustody((await sharedVault().load(addr)).custody ?? null);
  }, [vaultUnlocked, addr]);
  useEffect(() => void reload(), [reload]);

  const save = async (next: Custody | undefined) => {
    const v = sharedVault();
    const rec = await v.load(addr);
    // The custodian copy may carry the escrow's name: adopt it for the directory (unless renamed here).
    await v.save(addr, withPackageMeta({ ...rec, custody: next }, Date.now()));
    vaultSignal.emit();
    setCustody(next ?? null);
  };

  const importFile = async (f: File) => {
    setMsg(null);
    try {
      const raw = await readJsonFile(f);
      let p: unknown = raw;
      if (isEnvelope(raw)) {
        const me = identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(t('custody.notForMe'));
        p = await openEnvelope(raw, me);
      } else if (isSealedJson(raw)) {
        if (!importPass) throw new Error(t('terms.needPass'));
        p = await openWithPassphrase(raw, importPass);
      }
      if (!isTermsPackage(p)) throw new Error(t('terms.badFile'));
      if (p.contractAddress && p.contractAddress !== addr) throw new Error(t('terms.otherContract'));
      const pkg: TermsPackage = { ...p, contractAddress: addr, escrowColor: view.escrowColor, escrowTicker: view.escrowTicker };
      const check = checkTermsAgainstLedger(termsCrypto, pkg, view);
      // Never keep a copy that does not open the on-chain commitments: it would be a useless (or misleading) backup.
      if (!check.ok && check.amount !== 'unset') throw new Error(`TERMS_COMMITMENT_MISMATCH — ${t('terms.mismatch')}`);
      await save({ terms: pkg, receivedAt: Date.now(), fileName: f.name, handedOut: custody?.handedOut ?? [] });
      setImportPass('');
      setMsg({ tone: 'ok', text: t('custody.imported') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  const handOut = async () => {
    if (!custody) return;
    setMsg(null);
    try {
      const env = await sealTo(custody.terms, toKey.trim(), to);
      downloadJson(`terms-for-${to}.json`, env);
      await save({ ...custody, handedOut: [...(custody.handedOut ?? []), { at: Date.now(), to, kind: 'envelope' }] });
      setToKey('');
      setMsg({ tone: 'ok', text: t('custody.handedOut').replace('{to}', to) });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  const archive = async () => {
    if (!custody) return;
    downloadJson(`terms-custody-${addr.slice(0, 8)}.json`, await sealWithPassphrase(custody.terms, archivePass));
    await save({ ...custody, handedOut: [...(custody.handedOut ?? []), { at: Date.now(), to: 'archive', kind: 'passphrase' }] });
    setArchivePass('');
    setMsg({ tone: 'ok', text: t('custody.archived') });
  };

  const check = custody ? checkTermsAgainstLedger(termsCrypto, custody.terms, view) : null;

  return (
    <Card title={t('custody.title')} icon={<Archive size={16} aria-hidden />} tip={t('tip.custody.title')} className="print:hidden">
      <p className="mb-3 text-sm text-slate-400">{t('custody.hint')}</p>
      {!vaultUnlocked ? (
        <VaultGate />
      ) : (
        <div className="space-y-3">
          {identity ? (
            <Field label={t('custody.myKey')} hint={t('custody.myKeyHint')}>
              <Mono value={identity.publicKey} />
            </Field>
          ) : (
            <Alert tone="warn">{t('terms.noIdentity')}</Alert>
          )}
          {msg && (
            <Alert tone={msg.tone} onClose={() => setMsg(null)}>
              {msg.text}
            </Alert>
          )}

          {!custody ? (
            <div className="flex flex-wrap items-end gap-2">
              <FilePick label={t('custody.import')} accept="application/json,.json" onFile={(f) => void importFile(f)} />
              <input type="password" className="input !w-56" placeholder={t('terms.passOptional')} aria-label={t('terms.passOptional')} value={importPass} onChange={(e) => setImportPass(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="ok">{t('custody.held')}</Badge>
                <span className="text-slate-400">
                  {new Date(custody.receivedAt).toLocaleString()} · {custody.fileName}
                </span>
                {check &&
                  COMMITMENT_KEYS.map((k) => (
                    <Badge key={k} tone={check[k] === 'match' ? 'ok' : check[k] === 'unset' ? 'muted' : 'bad'}>
                      {k}: {check[k]}
                    </Badge>
                  ))}
              </div>
              <TermsAmounts terms={custody.terms.terms} ticker={view.escrowTicker} decimals={custody.terms.escrowDecimals} />

              <Field label={t('custody.handOut')} hint={t('custody.handOutHint')} htmlFor="custody-to-key">
                <div className="flex flex-wrap gap-2">
                  <select className="input !w-auto" aria-label={t('custody.recipient')} value={to} onChange={(e) => setTo(e.target.value as (typeof HANDOUT_TO)[number])}>
                    {HANDOUT_TO.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <input id="custody-to-key" className="input mono flex-1" placeholder={t('terms.myEnvelopeKey')} value={toKey} onChange={(e) => setToKey(e.target.value)} spellCheck={false} />
                  <button type="button" className="btn-ghost" disabled={!toKey.trim()} onClick={() => void handOut()}>
                    {t('adminTerms.seal')}
                  </button>
                </div>
              </Field>

              <div>
                <span className="label">{t('custody.openings')}</span>
                <OpeningButtons kinds={openingKindsFor(custody.terms.terms)} make={(k) => selectiveOpening(custody.terms, k)} />
                {onOpening && (
                  <button
                    type="button"
                    className="btn-primary mt-2"
                    onClick={() => openingKindsFor(custody.terms.terms).filter((k) => k === 'price' || k === 'amount' || k === 'lenderShare' || k === 'loanTerms' || k === 'coolingOff').forEach((k) => onOpening(selectiveOpening(custody.terms, k)))}
                  >
                    {t('custody.verifyPrice')}
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  className="input !w-56"
                  placeholder={t('vaultBackup.pass')}
                  aria-label={t('vaultBackup.pass')}
                  value={archivePass}
                  onChange={(e) => setArchivePass(e.target.value)}
                  autoComplete="new-password"
                />
                <button type="button" className="btn-ghost" disabled={archivePass.length < MIN_BACKUP_PASSPHRASE} onClick={() => void archive()}>
                  {t('custody.archive')}
                </button>
              </div>

              {!!custody.handedOut?.length && (
                <div>
                  <span className="label">{t('custody.history')}</span>
                  <ul className="space-y-0.5 text-xs text-slate-400">
                    {[...custody.handedOut].reverse().map((h, i) => (
                      <li key={i}>
                        {new Date(h.at).toLocaleString()} → {h.to} ({h.kind})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button type="button" className="btn-danger" onClick={() => setConfirmRemove(true)}>
                {t('custody.remove')}
              </button>
            </>
          )}
        </div>
      )}
      {confirmRemove && (
        <TypedConfirmDialog
          title={t('custody.removeTitle')}
          phrase={t('confirm.phraseRemove')}
          alsoAccept={['REMOVE']}
          body={<p className="text-warn">{t('custody.removeBody')}</p>}
          confirmLabel={t('custody.remove')}
          cancelLabel={t('confirm.keepData')}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => void save(undefined).then(() => setConfirmRemove(false))}
        />
      )}
    </Card>
  );
}
