'use client';
import { usePathname } from 'next/navigation';
import { useApp } from '../providers/AppProvider';
import { useEscrow } from '../providers/EscrowProvider';
import { useT } from '../i18n';
import { Alert } from './ui';

/**
 * One banner, in Wallet Mode only, while the configured indexer is being skipped (circuit breaker open): queries use the
 * wallet's indexer meanwhile and the configured one is retried after the cooldown. Replaces a pair of console errors on
 * every query. The admin console always works in Wallet Mode; party pages follow the Wallet / Simulator switch.
 */
export function IndexerBanner() {
  const { t } = useT();
  const { indexerAvailability, connector } = useApp();
  const { mode } = useEscrow();
  const pathname = usePathname() ?? '';
  const walletMode = connector.status === 'connected' && (mode === 'wallet' || pathname.startsWith('/admin'));
  if (!walletMode || indexerAvailability.status !== 'down') return null;
  return (
    <div className="mx-auto max-w-6xl px-4 pt-3">
      <Alert tone="warn">{t('health.indexerDown')}</Alert>
    </div>
  );
}
