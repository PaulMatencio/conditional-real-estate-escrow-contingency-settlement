'use client';
import { useEffect } from 'react';
import { Fuel, RefreshCw } from 'lucide-react';
import { capFromNight, dustLevel, dustPercent, formatDust, formatNight } from '@/infrastructure/wallet/dust';
import { useApp } from '../providers/AppProvider';
import { useT } from '../i18n';
import { Alert, Badge, Card } from './ui';

/** DUST the connected wallet reports as spendable, checked before a deploy or any transaction. */
export function DustCard() {
  const { t } = useT();
  const { dust, refreshDust, connector } = useApp();
  const connected = connector.status === 'connected';
  useEffect(() => void refreshDust(), [refreshDust]);
  if (!connected) return null;
  const level = dust ? dustLevel(dust) : null;
  const pct = dust ? dustPercent(dust) : null;
  return (
    <Card
      title={t('dust.title')}
      icon={<Fuel size={16} aria-hidden />}
      actions={
        <button type="button" className="btn-ghost !p-1.5" onClick={() => void refreshDust()} aria-label={t('common.refresh')}>
          <RefreshCw size={14} />
        </button>
      }
    >
      {!dust ? (
        <Alert tone="warn">{t('dust.noReport')}</Alert>
      ) : (
        <div className="space-y-2" aria-live="polite">
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-400">{t('dust.balance')}</dt>
              <dd className="font-semibold text-white">{formatDust(dust.balance)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">{t('dust.night')}</dt>
              <dd className="text-white">{dust.night !== null ? formatNight(dust.night) : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">{t('dust.cap')}</dt>
              <dd className="text-white">
                {dust.night !== null ? formatDust(capFromNight(dust.night)) : dust.cap !== null ? formatDust(dust.cap) : '—'}{' '}
                {pct !== null && <Badge tone={level === 'ok' ? 'ok' : level === 'low' ? 'warn' : 'bad'}>{pct} %</Badge>}
              </dd>
            </div>
          </dl>
          {pct !== null && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-midnight-800" role="img" aria-label={`${pct} %`}>
              <div className={`h-full ${level === 'ok' ? 'bg-ok' : level === 'low' ? 'bg-warn' : 'bg-bad'}`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          )}
          {dust.night !== null && dust.walletCap !== capFromNight(dust.night) && <p className="text-xs text-slate-500">{t('dust.walletCapOdd')}</p>}
          {level === 'empty' && <Alert tone="bad">{t('dust.empty')}</Alert>}
          {level === 'low' && <Alert tone="warn">{t('dust.low')}</Alert>}
          <p className="text-xs text-slate-500">{t('dust.hint')}</p>
        </div>
      )}
    </Card>
  );
}

/** Compact DUST indicator for the header. */
export function DustBadge() {
  const { dust } = useApp();
  if (!dust) return null;
  const level = dustLevel(dust);
  const pct = dustPercent(dust);
  return (
    <span title={`${formatDust(dust.balance)}${dust.night !== null ? ` · ${formatNight(dust.night)}` : ''}`}>
      <Badge tone={level === 'ok' ? 'muted' : level === 'low' ? 'warn' : 'bad'}>{formatDust(dust.balance).replace(/\.0 DUST$/, ' DUST')}{pct !== null ? ` · ${pct} %` : ''}</Badge>
    </span>
  );
}
