'use client';
import { Bell, History } from 'lucide-react';
import { nextDeadline } from '@/domain/lifecycle';
import { shortHex } from '@/domain/hex';
import { explorerTxUrl } from '@/infrastructure/config/network';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Card } from '../ui';
import { fmtDuration } from './helpers';

/** FR-AUDIT-01..03: lifecycle changes seen by this browser, the local (encrypted) tx history and deadline alerts. */
export function TimelinePanel() {
  const { t } = useT();
  const { timeline, record, view, now, mode } = useEscrow();
  if (!view) return null;
  const d = nextDeadline(view);
  const left = d ? Number(d.at) - Number(now) : null;
  const history = [...(record.history ?? [])].reverse();
  return (
    <Card title={t('audit.title')} icon={<History size={16} aria-hidden />}>
      {d && left !== null && left < 3 * 86400 && (
        <Alert tone={left <= 0 ? 'bad' : 'warn'}>
          <Bell size={14} className="mr-1 inline" aria-hidden />
          {left <= 0 ? t('audit.deadlinePassed') : t('audit.deadlineSoon')} ({t(`deadline.${d.kind}`)}, {fmtDuration(left)})
        </Alert>
      )}
      <h3 className="label mt-3">{t('audit.events')}</h3>
      <ol className="space-y-1 text-sm">
        {timeline.map((e, i) => (
          <li key={i} className="flex flex-wrap gap-2 text-slate-300">
            <span className="text-slate-500">{new Date(e.at).toLocaleTimeString()}</span>
            <span>
              #{e.round} → <strong>{e.status}</strong>
            </span>
            {e.circuit && <span className="mono text-slate-500">{e.circuit}</span>}
          </li>
        ))}
      </ol>
      <h3 className="label mt-3">{t('audit.mine')}</h3>
      {history.length === 0 ? (
        <p className="text-sm text-slate-500">—</p>
      ) : (
        <ol className="space-y-1 text-sm">
          {history.map((h, i) => (
            <li key={i} className="flex flex-wrap gap-2 text-slate-300">
              <span className="text-slate-500">{new Date(h.at).toLocaleString()}</span>
              <span className="mono">{h.circuit}</span>
              {h.role && <span className="text-slate-500">({h.role})</span>}
              {mode === 'wallet' && h.txHash ? (
                <a className="mono text-accent-soft underline" href={explorerTxUrl(h.txHash)} target="_blank" rel="noopener noreferrer">
                  {shortHex(h.txHash)}
                </a>
              ) : (
                <span className="mono text-slate-500">{h.txHash}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
