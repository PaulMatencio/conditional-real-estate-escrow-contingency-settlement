'use client';
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import type { DeployProgress, StepState } from '@/application/deployProgress';
import { shortHex } from '@/domain/hex';
import { explorerContractUrl, explorerTxUrl } from '@/infrastructure/config/network';
import { useApp } from '../providers/AppProvider';
import { useT, type MessageKey } from '../i18n';
import { Alert, Badge } from './ui';

const icon = (s: StepState) =>
  s.status === 'done' ? <CheckCircle2 size={16} className="text-ok" aria-hidden /> :
  s.status === 'active' ? <Loader2 size={16} className="animate-spin text-accent" aria-hidden /> :
  s.status === 'error' ? <XCircle size={16} className="text-bad" aria-hidden /> :
  <Circle size={16} className="text-slate-500" aria-hidden />;

/** Deploy / registration progress: one row per stage, live; survives for the whole staged run. */
export function ProgressPanel({ progress }: { progress: DeployProgress }) {
  const { t } = useT();
  const { dismissProgress } = useApp();
  const tone = progress.status === 'success' ? 'ok' : progress.status === 'failed' ? 'bad' : 'accent';
  return (
    <section className="card" aria-live="polite">
      <h2 className="card-title">
        <span className="flex-1">{progress.title ?? t('progress.title')}</span>
        <Badge tone={tone}>{progress.status === 'running' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}{progress.status === 'success' ? t('progress.success') : progress.status === 'failed' ? t('progress.failed') : '…'}</Badge>
      </h2>
      <ol className="space-y-2">
        {progress.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            {icon(s)}
            <div className="flex-1">
              <div className={s.status === 'pending' ? 'text-slate-500' : 'text-slate-200'}>{s.label ?? t(s.labelKey as MessageKey)}</div>
              {s.status === 'active' && s.hintKey && <div className="text-xs text-slate-400">{t(s.hintKey as MessageKey)}</div>}
              {s.error && (
                <div className="mt-1 flex items-start gap-1 text-xs text-bad">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden /> {s.error}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {progress.status === 'success' && (
        <div className="mt-3 space-y-1 text-xs text-slate-400">
          {progress.contractAddress && (
            <div>
              Contract{' '}
              <a className="mono underline" href={explorerContractUrl(progress.contractAddress)} target="_blank" rel="noopener noreferrer">
                {shortHex(progress.contractAddress, 12, 8)}
              </a>
            </div>
          )}
          {progress.txHash && !progress.txHash.startsWith('(') && (
            <div>
              Tx{' '}
              <a className="mono underline" href={explorerTxUrl(progress.txHash)} target="_blank" rel="noopener noreferrer">
                {shortHex(progress.txHash, 12, 8)}
              </a>
            </div>
          )}
        </div>
      )}
      {progress.status !== 'running' && (
        <button type="button" className="btn-ghost mt-3" onClick={dismissProgress}>
          {t('progress.dismiss')}
        </button>
      )}
      {progress.status === 'failed' && <div className="mt-3"><Alert tone="warn">The contract address is saved once the deploy confirms; use “Register remaining circuits” on the Contract tab to resume.</Alert></div>}
    </section>
  );
}
