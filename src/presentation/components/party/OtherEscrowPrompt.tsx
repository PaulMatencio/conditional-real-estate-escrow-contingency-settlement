'use client';
import { useState } from 'react';
import { displayLabel } from '@/domain/escrowMeta';
import type { WireMeta } from '@/domain/escrowMeta';
import { shortHex } from '@/domain/hex';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Spinner } from '../ui';

/** A package whose contract address is not the escrow open on this page, waiting for the user's choice. */
export interface PendingImport {
  address: string;
  meta?: WireMeta;
  /** Stores the package in `address`'s vault record (and checks it first, if needed). */
  store: () => Promise<void>;
}

const label = (address: string, meta?: WireMeta, dirLabel?: string) => `${dirLabel ?? (meta?.label || displayLabel(address))} (${shortHex(address, 6, 4)})`;

/**
 * "This package is for escrow B, the page shows escrow A": store it in B's vault record and open B on every page
 * (the same switch as the header's escrow switcher), or cancel. Nothing is written before the user confirms.
 */
export function OtherEscrowPrompt({ pending, onDone, onCancel }: { pending: PendingImport; onDone: (text: string) => void; onCancel: () => void }) {
  const { t } = useT();
  const { contractAddress, directory, switchEscrow } = useEscrow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const known = directory.find((d) => d.address === pending.address);
  const current = contractAddress ? directory.find((d) => d.address === contractAddress) : undefined;
  const target = label(pending.address, pending.meta, known?.meta?.label);
  const open = current ? `${label(current.address, undefined, current.meta?.label)}${current.meta?.archived ? ` — ${t('terms.otherEscrow.archived')}` : ''}` : contractAddress ? shortHex(contractAddress, 6, 4) : '—';

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await pending.store();
      await switchEscrow(pending.address);
      onDone(t('terms.otherEscrow.done').replace('{escrow}', target));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alertdialog" aria-live="polite" className="mb-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
      <p>{t('terms.otherEscrow.ask').replace('{escrow}', target).replace('{open}', open)}</p>
      {err && <p className="mt-1 text-bad">{err}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void confirm()}>
          {busy && <Spinner />} {t('terms.otherEscrow.switch')}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>
          {t('terms.otherEscrow.cancel')}
        </button>
      </div>
    </div>
  );
}
