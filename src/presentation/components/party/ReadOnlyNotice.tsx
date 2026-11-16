'use client';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert } from '../ui';

/**
 * Wallet Mode without a wallet: the escrow is read from the indexer. Says when the indexer is not answering (midnight-js
 * keeps retrying, so a dead indexer would otherwise just look like "no escrow loaded") or the last read failed.
 */
export function ReadOnlyNotice() {
  const { t } = useT();
  const { readOnly, publicRead, view } = useEscrow();
  if (!readOnly) return null;
  if (publicRead.error) return <Alert tone="bad">{t('compliance.readFailed')} ({publicRead.error})</Alert>;
  if (publicRead.slow && !view) return <Alert tone="warn">{t('compliance.indexerSlow')}</Alert>;
  return null;
}
