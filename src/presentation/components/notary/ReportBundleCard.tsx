'use client';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { ContingencyName, EscrowView } from '@/domain/escrowView';
import { isDocumentBundle, matchReport, type ReportMatch } from '@/domain/report';
import { isEnvelope, isSealedJson, openEnvelope, openWithPassphrase, unb64 } from '@/infrastructure/crypto/aead';
import { documentCommitment } from '@/infrastructure/crypto/escrowCrypto';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card } from '../ui';
import { FilePick, downloadBytes, readJsonFile } from '../party/helpers';

export interface ReportVerdict {
  label: string;
  ok: boolean;
  detail: string;
}

interface Opened {
  fileName: string;
  sealedFor?: string;
  contingency: ContingencyName;
  bytes: Uint8Array;
  match: ReportMatch;
}

/**
 * FR-ATTEST-02 / FR-NOTARY-02, receiving side: opens an attestor's report bundle (sealed with a passphrase or to this
 * browser's envelope key), recomputes the report commitment from the file and the salt, and compares it with the
 * ledger. The bundle's own claimed hash is never trusted. Everything happens in the browser; nothing is uploaded.
 */
export function ReportBundleCard({ view, onVerdict }: { view: EscrowView | null; onVerdict?: (v: ReportVerdict) => void }) {
  const { t } = useT();
  const { identities } = useEscrow();
  const [pass, setPass] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const open = async (f: File) => {
    setErr(null);
    setOpened(null);
    try {
      if (!view) throw new Error(t('report.noEscrow'));
      const raw = await readJsonFile(f);
      let b: unknown = raw;
      if (isEnvelope(raw)) {
        const me = identities.find((k) => k.publicKey === raw.recipient);
        if (!me) throw new Error(identities.length ? t('report.notForMe') : t('report.unlockForEnvelope'));
        b = await openEnvelope(raw, me);
      } else if (isSealedJson(raw)) {
        if (!pass) throw new Error(t('terms.needPass'));
        b = await openWithPassphrase(raw, pass);
      }
      if (!isDocumentBundle(b)) throw new Error(t('report.badFile'));
      if (b.contractAddress && b.contractAddress.toLowerCase() !== view.contractAddress.toLowerCase()) throw new Error(t('terms.otherContract'));
      const bytes = unb64(b.document);
      const match = matchReport(view, await documentCommitment(bytes, b.salt), b.contingency);
      setOpened({ fileName: b.fileName, sealedFor: b.sealedFor, contingency: b.contingency, bytes, match });
      setPass('');
      const ok = match.kind === 'current';
      onVerdict?.({ label: `${t('report.verdictLabel')}: ${b.fileName}`, ok, detail: ok ? `${t('notary.docMatches')} ${match.contingency}` : match.kind === 'voided' ? t('report.voided') : t('notary.docNoMatch') });
    } catch (e) {
      setErr(e instanceof Error && e.message.startsWith('Wrong passphrase') ? t('report.wrongPass') : (e as Error).message);
    }
  };

  const m = opened?.match;
  const contingencyName = (c: ContingencyName) => t(`report.c.${c}` as 'report.c.Inspection');

  return (
    <Card title={t('report.title')} icon={<FileText size={16} aria-hidden />} className="print:hidden">
      <p className="mb-3 text-sm text-slate-400">{t('report.hint')}</p>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input type="password" className="input !w-56" placeholder={t('terms.passOptional')} aria-label={t('terms.passOptional')} value={pass} onChange={(e) => setPass(e.target.value)} />
        <FilePick label={t('report.open')} accept="application/json,.json" onFile={(f) => void open(f)} />
      </div>
      {err && (
        <Alert tone="bad" onClose={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {opened && m && (
        <div className="space-y-2" aria-live="polite">
          {opened.sealedFor && <p className="text-xs text-slate-400">{t('bundle.sealedFor')}: {opened.sealedFor}</p>}
          {m.kind === 'current' && (
            <Alert tone={m.submitted ? 'ok' : 'warn'}>
              {t('report.matches').replace('{file}', opened.fileName).replace('{contingency}', contingencyName(m.contingency))}{' '}
              {m.submitted ? `${t('report.outcome')}: ${t(m.passed ? 'attest.pass' : 'attest.fail')}.` : t('report.notSubmitted')}
              {m.contingency !== opened.contingency && ` ${t('report.otherContingency').replace('{claimed}', contingencyName(opened.contingency))}`}
            </Alert>
          )}
          {m.kind === 'voided' && <Alert tone="warn">{t('report.voidedLong').replace('{file}', opened.fileName)}</Alert>}
          {m.kind === 'none' && <Alert tone="bad">{t('report.noMatch').replace('{file}', opened.fileName).replace('{contingency}', contingencyName(opened.contingency))}</Alert>}
          <button type="button" className="btn-ghost" onClick={() => downloadBytes(opened.fileName, opened.bytes)}>
            {t('report.save')}
          </button>
        </div>
      )}
    </Card>
  );
}
