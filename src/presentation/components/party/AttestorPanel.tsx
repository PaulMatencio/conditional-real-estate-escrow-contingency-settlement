'use client';
import { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { ContingencyName } from '@/domain/escrowView';
import type { DocumentBundle } from '@/domain/report';
import { b64, sealTo, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { documentCommitment, newSalt } from '@/infrastructure/crypto/escrowCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card, Field, Mono } from '../ui';
import { ConfirmDialog, FilePick, downloadJson, fmtTime, readFileBytes } from './helpers';

const CIRCUIT = { Inspection: 'submitInspection', Financing: 'submitFinancing', Title: 'submitTitle' } as const;
const ROLE = { Inspection: 'inspector', Financing: 'lender', Title: 'titleAgent' } as const;

interface Doc {
  name: string;
  bytes: Uint8Array;
  salt: string;
  hash: string;
}

/**
 * Exports the report bundle (report + salt + commitment) for the buyer, seller and notary: sealed to a recipient's
 * envelope key (one file per recipient, no shared secret) or with a passphrase given to them separately.
 */
function BundleExport({ doc, contingency }: { doc: Doc; contingency: ContingencyName }) {
  const { t } = useT();
  const { contractAddress } = useEscrow();
  const [pass, setPass] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const bundle = (): DocumentBundle => ({ format: 'EscrowDocumentBundleV1', contractAddress: contractAddress ?? undefined, contingency, fileName: doc.name, salt: doc.salt, reportHash: doc.hash, document: b64(doc.bytes) });
  const file = `${contingency.toLowerCase()}-bundle.json`;
  const go = (p: Promise<unknown>) => {
    setErr(null);
    void p.then((s) => downloadJson(file, s), (e) => setErr((e as Error).message));
  };
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-midnight-700 p-3">
      <p className="text-sm text-slate-300">{t('attest.exportHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input mono !w-80" placeholder={t('attest.recipientKey')} aria-label={t('attest.recipientKey')} value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
        <button type="button" className="btn-ghost" disabled={!to.trim()} onClick={() => go(sealTo(bundle(), to.trim()))}>
          {t('attest.exportTo')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="password" className="input !w-48" placeholder={t('vault.passphrase')} aria-label={t('vault.passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
        <button type="button" className="btn-ghost" disabled={pass.length < 8} onClick={() => go(sealWithPassphrase(bundle(), pass))}>
          {t('attest.exportBundle')}
        </button>
      </div>
      {err && <Alert tone="bad" onClose={() => setErr(null)}>{err}</Alert>}
    </div>
  );
}

/**
 * FR-ATTEST-01/02: the attestor selects its report locally; the browser salts and hashes it, anchors only the hash
 * on-chain, and exports an encrypted bundle (document + salt) for the deal participants. Nothing is uploaded. Reports
 * already submitted can be exported again at any time: the salt is in the vault, the report file is re-selected and
 * must hash to the anchored commitment.
 */
export function AttestorPanel({ contingency }: { contingency: ContingencyName }) {
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
