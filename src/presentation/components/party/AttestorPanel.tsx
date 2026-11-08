'use client';
import { useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import type { ContingencyName } from '@/domain/escrowView';
import { b64, sealWithPassphrase } from '@/infrastructure/crypto/aead';
import { documentCommitment, newSalt } from '@/infrastructure/crypto/escrowCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card, Field, Mono } from '../ui';
import { ConfirmDialog, FilePick, downloadJson, readFileBytes } from './helpers';

const CIRCUIT = { Inspection: 'submitInspection', Financing: 'submitFinancing', Title: 'submitTitle' } as const;
const ROLE = { Inspection: 'inspector', Financing: 'lender', Title: 'titleAgent' } as const;

/**
 * FR-ATTEST-01/02: the attestor selects its report locally; the browser salts and hashes it, anchors only the hash
 * on-chain, and exports an encrypted bundle (document + salt) for the deal participants. Nothing is uploaded.
 */
export function AttestorPanel({ contingency }: { contingency: ContingencyName }) {
  const { t } = useT();
  const { run, busy, updateRecord, view, contractAddress } = useEscrow();
  const [doc, setDoc] = useState<{ name: string; bytes: Uint8Array; salt: string; hash: string } | null>(null);
  const [outcome, setOutcome] = useState<boolean>(true);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState(false);
  const state = view?.contingencies[contingency];

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

  return (
    <Card title={`${t('attest.title')} — ${contingency}`} icon={<FileCheck2 size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">{t('attest.hint')}</p>
      {state?.submitted && <Alert tone="ok">{t('attest.already')}</Alert>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilePick label={t('attest.pick')} onFile={(f) => void pick(f)} />
        {doc && <span className="text-sm text-slate-300">{doc.name} ({doc.bytes.length} B)</span>}
      </div>
      {doc && (
        <>
          <Field label={t('attest.hash')} hint={t('attest.hashHint')}>
            <Mono value={doc.hash} />
          </Field>
          <fieldset className="mb-3 flex gap-4 text-sm">
            <legend className="label">{t('attest.outcome')}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" checked={outcome} onChange={() => setOutcome(true)} /> {t('attest.pass')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={!outcome} onChange={() => setOutcome(false)} /> {t('attest.fail')}
            </label>
          </fieldset>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary" disabled={busy || !!state?.submitted} onClick={() => setConfirm(true)}>
              {t('attest.submit')}
            </button>
            <input type="password" className="input !w-48" placeholder={t('vault.passphrase')} aria-label={t('vault.passphrase')} value={pass} onChange={(e) => setPass(e.target.value)} />
            <button
              type="button"
              className="btn-ghost"
              disabled={pass.length < 8}
              onClick={() =>
                void sealWithPassphrase({ format: 'EscrowDocumentBundleV1', contractAddress, contingency, fileName: doc.name, salt: doc.salt, reportHash: doc.hash, document: b64(doc.bytes) }, pass).then((s) =>
                  downloadJson(`${contingency.toLowerCase()}-bundle.json`, s)
                )
              }
            >
              {t('attest.exportBundle')}
            </button>
          </div>
        </>
      )}
      {confirm && doc && (
        <ConfirmDialog title={t('attest.confirmTitle')} body={`${contingency}: ${outcome ? t('attest.pass') : t('attest.fail')} · #${doc.hash.slice(0, 16)}… ${t('attest.confirmBody')}`} confirmLabel={t('attest.submit')} onCancel={() => setConfirm(false)} onConfirm={() => void submit()} />
      )}
    </Card>
  );
}
