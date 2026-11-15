'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, RefreshCw, X } from 'lucide-react';
import type { InfrastructureReport } from '@/application/checkInfrastructure';
import type { HealthCheckResult, HealthStatus } from '@/domain/health';
import { useApp } from '../providers/AppProvider';
import { useT, type MessageKey } from '../i18n';
import { Badge, Spinner } from './ui';

const TONE: Record<HealthStatus, 'ok' | 'warn' | 'bad' | 'muted'> = { ok: 'ok', degraded: 'warn', down: 'bad', skipped: 'muted' };

/** "What is wrong and what to do", from a check's detail code (+ a hint for some elements when they are down). */
function Explanation({ r }: { r: HealthCheckResult }) {
  const { t } = useT();
  if (!r.detail && r.status === 'ok') return null;
  const hint = r.status !== 'ok' && r.status !== 'skipped' ? (`health.hint.${r.id}` as MessageKey) : null;
  return (
    <p className="mt-1 text-xs text-slate-400">
      {r.detail && t(`health.detail.${r.detail.code}` as MessageKey)}
      {r.detail?.info && <span className="mono ml-1 text-slate-300">({r.detail.info})</span>}
      {hint && <span className="block text-slate-500">{t(hint)}</span>}
    </p>
  );
}

/** Infrastructure health: runs every check when opened, one row per element. Escape or a click outside closes it. */
export function HealthModal({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { checkInfrastructure } = useApp();
  const [report, setReport] = useState<InfrastructureReport | null>(null);
  const [running, setRunning] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setReport(await checkInfrastructure());
    } finally {
      setRunning(false);
    }
  }, [checkInfrastructure]);

  // Check once when the window opens; "Check again" re-runs on demand.
  useEffect(() => {
    void run();
    closeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="health-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card flex max-h-[90vh] w-full max-w-2xl flex-col">
        <div className="mb-3 flex items-center gap-2">
          <Activity size={18} className="text-accent-soft" aria-hidden />
          <h2 id="health-title" className="flex-1 text-lg font-semibold text-white">{t('health.title')}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t('common.close')} className="btn-ghost !p-1.5">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2" aria-live="polite">
          {report && !running ? (
            <>
              <Badge tone={TONE[report.overall]}>{t(`health.overall.${report.overall}` as MessageKey)}</Badge>
              <span className="text-xs text-slate-500">
                {t('health.checkedAt')} {new Date(report.checkedAt).toLocaleTimeString()}
              </span>
            </>
          ) : (
            <span className="flex items-center gap-2 text-sm text-slate-400">
              <Spinner /> {t('health.checking')}
            </span>
          )}
          <button type="button" className="btn-ghost ml-auto !py-1 text-xs" onClick={() => void run()} disabled={running}>
            <RefreshCw size={14} aria-hidden /> {t('health.recheck')}
          </button>
        </div>

        <ul className="-mx-1 space-y-2 overflow-y-auto px-1">
          {report?.results.map((r) => (
            <li key={r.id} className="rounded-xl border border-midnight-700 bg-midnight-900/60 p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-white">{t(`health.id.${r.id}` as MessageKey)}</span>
                {!r.critical && <span className="text-xs text-slate-500">{t('health.informational')}</span>}
                <span className="ml-auto flex items-center gap-2">
                  {r.latencyMs !== undefined && r.status !== 'skipped' && <span className="text-xs text-slate-500">{r.latencyMs} ms</span>}
                  <Badge tone={TONE[r.status]}>{t(`health.status.${r.status}` as MessageKey)}</Badge>
                </span>
              </div>
              <p className="mono mt-1 text-slate-500">{r.target}</p>
              <Explanation r={r} />
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
}
