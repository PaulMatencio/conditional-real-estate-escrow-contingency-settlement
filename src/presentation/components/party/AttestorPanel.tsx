'use client';
import { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { DEFAULT_BUNDLE_RECIPIENTS, bundleFileName, isEnvelopeKey, lastExports, recipientConflict, recipientSlug, upsertRecipient, type BundleRecipient, type DocumentBundle } from '@/domain/report';
import { b64, sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { documentCommitment, newSalt } from '@/infrastructure/crypto/escrowCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT, type MessageKey } from '../../i18n';
import { Alert, Card, Field, Mono } from '../ui';
import { ConfirmDialog, FilePick, downloadJson, fmtTime, readFileBytes } from './helpers';

/**
 * Attested contingencies. Financing is attested only in a contract v2 cash deal (by the lender); from v3 the deposit
 * clears it, and in a loan the lender's deposit does.
 */
type Attested = 'Inspection' | 'Title' | 'Financing';
const CIRCUIT = { Inspection: 'submitInspection', Title: 'submitTitle', Financing: 'submitFinancing' } as const;
const ROLE = { Inspection: 'inspector', Title: 'titleAgent', Financing: 'lender' } as const;

interface Doc {
  name: string;
  bytes: Uint8Array;
  salt: string;
  hash: string;
}

/**
 * Exports the report bundle (report + salt + commitment) for the buyer, seller, notary, resolver or anyone else: one
 * file per recipient sealed to their envelope key, named after them (`title-bundle-for-seller.json`) and saying inside
 * who it is for. Recipients' keys are remembered in this escrow's vault record (they are public keys), with the date
 * each one last received this report. A passphrase file remains for recipients without an envelope key.
 */
function BundleExport({ doc, contingency }: { doc: Doc; contingency: Attested }) {
  const { t } = useT();
  const { contractAddress, record, updateRecord, vaultUnlocked } = useEscrow();
  const saved = record.bundleRecipients ?? [];
  const [keys, setKeys] = useState<Record<string, string>>(() => Object.fromEntries(saved.map((r) => [r.id, r.key])));
  const [others, setOthers] = useState<BundleRecipient[]>(() => saved.filter((r) => r.id.startsWith('other:')));
  const [newName, setNewName] = useState('');
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const exported = lastExports(record.bundleExports, doc.hash);

  const rows: BundleRecipient[] = [...DEFAULT_BUNDLE_RECIPIENTS.map((id) => ({ id, key: '' })), ...others].map((r) => ({ ...r, key: (keys[r.id] ?? '').trim() }));
  const nameOf = (r: BundleRecipient) => (r.id.startsWith('other:') ? (r.label ?? r.id.slice(6)) : t(`bundle.to.${r.id}` as MessageKey));
  const bundle = (sealedFor?: string): DocumentBundle => ({ format: 'EscrowDocumentBundleV1', contractAddress: contractAddress ?? undefined, contingency, fileName: doc.name, salt: doc.salt, reportHash: doc.hash, document: b64(doc.bytes), ...(sealedFor ? { sealedFor } : {}) });

  /** Checks a row's key: well formed, and not the key already saved for someone else. */
  const problem = (r: BundleRecipient, list: BundleRecipient[]): string | null => {
    if (!isEnvelopeKey(r.key)) return t('bundle.badKey').replace('{who}', nameOf(r));
    const other = recipientConflict(list, r.id, r.key);
    return other ? t('bundle.sameKey').replace('{who}', nameOf(r)).replace('{other}', nameOf(other)) : null;
  };

  /** Seals for each given row, downloads the files, then records the keys and deliveries in the vault. */
  const exportFor = async (targets: BundleRecipient[]) => {
    setMsg(null);
    const list = rows.filter((r) => r.key);
    for (const r of targets) {
      const p = problem(r, list);
      if (p) return setMsg({ tone: 'bad', text: p });
    }
    try {
      for (const r of targets) downloadJson(bundleFileName(contingency, r.id), await sealTo(bundle(nameOf(r)), r.key, nameOf(r)));
      if (vaultUnlocked) {
        const at = Date.now();
        await updateRecord((rec) => ({
          ...rec,
          bundleRecipients: targets.reduce((acc, r) => upsertRecipient(acc, { id: r.id, key: r.key, ...(r.label ? { label: r.label } : {}) }), rec.bundleRecipients ?? []),
          bundleExports: [...(rec.bundleExports ?? []), ...targets.map((r) => ({ reportHash: doc.hash, recipient: r.id, at }))]
        }));
      }
      setMsg({ tone: 'ok', text: t('bundle.exported').replace('{who}', targets.map(nameOf).join(', ')) });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  };

  const addOther = () => {
    const label = newName.trim();
    if (!label) return;
    const id = `other:${recipientSlug(label)}`;
    if (rows.some((r) => r.id === id)) return setMsg({ tone: 'warn', text: t('bundle.exists').replace('{who}', label) });
    setOthers((o) => [...o, { id, label, key: '' }]);
    setNewName('');
  };

  const ready = rows.filter((r) => r.key);
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-midnight-700 p-3">
      <p className="text-sm text-slate-300">{t('attest.exportHint')}</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-center">
            <label htmlFor={`bk-${contingency}-${r.id}`} className="text-sm font-medium text-white">
              {nameOf(r)}
            </label>
            <input
              id={`bk-${contingency}-${r.id}`}
              className="input mono"
              placeholder={t('attest.recipientKey')}
              value={keys[r.id] ?? ''}
              onChange={(e) => setKeys((k) => ({ ...k, [r.id]: e.target.value }))}
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost" disabled={!r.key} onClick={() => void exportFor([r])}>
                {t('bundle.exportOne')}
              </button>
              <span className="text-xs text-slate-500">{exported[r.id] ? `${t('bundle.sentAt')} ${fmtTime(Math.floor(exported[r.id] / 1000))}` : t('bundle.notSent')}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input !w-56" placeholder={t('bundle.otherName')} aria-label={t('bundle.otherName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="btn-ghost" disabled={!newName.trim()} onClick={addOther}>
          {t('bundle.addOther')}
        </button>
        <button type="button" className="btn-primary ml-auto" disabled={ready.length < 2} onClick={() => void exportFor(ready)}>
          {t('bundle.exportAll').replace('{n}', String(ready.length))}
        </button>
      </div>
      {!vaultUnlocked && <p className="text-xs text-warn">{t('bundle.notRemembered')}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-midnight-700 pt-3">
        <span className="text-sm text-slate-400">{t('bundle.orPassphrase')}</span>
        <input type="password" className="input !w-48" placeholder={t('vault.passphrase')} aria-label={t('vault.passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
        <button
          type="button"
          className="btn-ghost"
          disabled={pass.length < 8}
          onClick={() => void sealWithPassphrase(bundle(), pass).then((x) => downloadJson(`${contingency.toLowerCase()}-bundle.json`, x), (e) => setMsg({ tone: 'bad', text: (e as Error).message }))}
        >
          {t('attest.exportBundle')}
        </button>
      </div>
      {msg && (
        <Alert tone={msg.tone} onClose={() => setMsg(null)}>
          {msg.text}
        </Alert>
      )}
    </div>
  );
}

/**
 * FR-ATTEST-01/02: the attestor selects its report locally; the browser salts and hashes it, anchors only the hash
 * on-chain, and exports an encrypted bundle (document + salt) for the deal participants. Nothing is uploaded. Reports
 * already submitted can be exported again at any time: the salt is in the vault, the report file is re-selected and
 * must hash to the anchored commitment.
 */
export function AttestorPanel({ contingency }: { contingency: Attested }) {
  const { t } = useT();
  const { run, busy, updateRecord, view, record } = useEscrow();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [outcome, setOutcome] = useState<boolean>(true);
  const [confirm, setConfirm] = useState(false);
  const [again, setAgain] = useState<{ hash: string; doc: Doc | null; err: string | null } | null>(null);
  const state = view?.contingencies[contingency];
  const submittedDocs = (record.documents ?? []).filter((d) => d.contingency === contingency).slice().reverse();

  const pick = async (f: File) => {
    const bytes = await readFileBytes(f);
    const salt = newSalt();
    setDoc({ name: f.name, bytes, salt, hash: await documentCommitment(bytes, salt) });
  };

  const submit = async () => {
    if (!doc) return;
    setConfirm(false);
    const r = await run(ROLE[contingency], CIRCUIT[contingency], [outcome, doc.hash]);
    if (r) await updateRecord((rec) => ({ ...rec, documents: [...(rec.documents ?? []), { contingency, reportHash: doc.hash, salt: doc.salt, fileName: doc.name, at: Date.now() }] }));
  };

  /** Re-export: the re-selected file must hash, with the stored salt, to the committed report. */
  const reselect = async (d: (typeof submittedDocs)[number], f: File) => {
    const bytes = await readFileBytes(f);
    const hash = await documentCommitment(bytes, d.salt);
    setAgain(hash === d.reportHash ? { hash: d.reportHash, doc: { name: d.fileName, bytes, salt: d.salt, hash }, err: null } : { hash: d.reportHash, doc: null, err: t('attest.notSameFile') });
  };

  return (
    <Card title={`${t('attest.title')} — ${contingency}`} icon={<FileCheck2 size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('attest.hint')}</p>
      {state?.submitted && <Alert tone="ok">{t('attest.already')}</Alert>}
      {!state?.submitted && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <FilePick label={t('attest.pick')} onFile={(f) => void pick(f)} />
          {doc && <span className="text-sm text-slate-300">{doc.name} ({doc.bytes.length} B)</span>}
        </div>
      )}
      {/* Right after submitting, the selected report stays here so its bundle can be exported without re-selecting it. */}
      {doc && (!state?.submitted || state.reportHash === doc.hash) && (
        <>
          <Field label={t('attest.hash')} tip={t('tip.attest.hash')} hint={t('attest.hashHint')}>
            <Mono value={doc.hash} />
          </Field>
          {!state?.submitted && (
            <>
              <fieldset className="mb-3 flex gap-4 text-sm">
                <legend className="label">{t('attest.outcome')}</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={outcome} onChange={() => setOutcome(true)} /> {t('attest.pass')}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!outcome} onChange={() => setOutcome(false)} /> {t('attest.fail')}
                </label>
              </fieldset>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => setConfirm(true)}>
                {t('attest.submit')}
              </button>
            </>
          )}
          <BundleExport doc={doc} contingency={contingency} />
        </>
      )}

      {submittedDocs.length > 0 && (
        <div className="mt-4">
          <h3 className="label">{t('attest.submittedReports')}</h3>
          <ul className="space-y-2">
            {submittedDocs.map((d) => (
              <li key={`${d.reportHash}-${d.at}`} className="rounded-xl border border-midnight-700 bg-midnight-900/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{d.fileName}</span>
                  <span className="text-xs text-slate-500">{fmtTime(Math.floor(d.at / 1000))}</span>
                  {state?.reportHash === d.reportHash ? <span className="text-xs text-ok">{t('attest.onChain')}</span> : <span className="text-xs text-slate-500">{t('attest.notCurrent')}</span>}
                </div>
                <Field label={t('attest.salt')} hint={t('attest.saltHint')}>
                  <Mono value={d.salt} />
                </Field>
                <FilePick label={t('attest.reexport')} onFile={(f) => void reselect(d, f)} />
                {again?.hash === d.reportHash && again.err && <div className="mt-2"><Alert tone="bad">{again.err}</Alert></div>}
                {again?.hash === d.reportHash && again.doc && <BundleExport doc={again.doc} contingency={contingency} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirm && doc && (
        <ConfirmDialog title={t('attest.confirmTitle')} body={`${contingency}: ${outcome ? t('attest.pass') : t('attest.fail')} · #${doc.hash.slice(0, 16)}… ${t('attest.confirmBody')}`} confirmLabel={t('attest.submit')} onCancel={() => setConfirm(false)} onConfirm={() => void submit()} />
      )}
    </Card>
  );
}
