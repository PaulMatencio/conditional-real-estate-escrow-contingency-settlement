'use client';
/**
 * Contract-update safety net (CLAUDE.md "Contract updates must not break the dApp"), shown under the header on every
 * page:
 *  - the page's code was built against another contract than the one the dApp server serves (restart and reload);
 *  - the current escrow was deployed with an older contract version: what still makes sense (archive, explorer).
 * The rest of the app keeps working in both cases.
 */
import { useEffect, useState } from 'react';
import { Archive, ExternalLink, RefreshCw } from 'lucide-react';
import { explorerContractUrl } from '@/infrastructure/config/network';
import { ZK_ASSET_PATH } from '@/infrastructure/contract/compiled';
import { bundleDrift, driftText, proofCircuitsOf } from '@/infrastructure/contract/compat';
import { useEscrow } from '../providers/EscrowProvider';
import { useT } from '../i18n';
import { Alert } from './ui';

/** Compares this bundle's circuits with the server's compiled contract, once per page load. */
function useBundleDrift(): string | null {
  const [drift, setDrift] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${ZK_ASSET_PATH}/compiler/contract-info.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        const server = proofCircuitsOf(info);
        if (!alive || !server) return; // not compiled: the Health window reports it
        const d = bundleDrift(server);
        setDrift(d.added.length || d.removed.length ? driftText(d) : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return drift;
}

export function CompatBanner() {
  const { t } = useT();
  const { incompatible, contractAddress, mode, vaultUnlocked, saveMeta, directory } = useEscrow();
  const drift = useBundleDrift();
  const [msg, setMsg] = useState<string | null>(null);
  const archived = !!directory.find((e) => e.address === contractAddress)?.meta?.archived;

  if (!drift && !(incompatible && contractAddress && mode === 'wallet')) return null;
  return (
    <div className="mx-auto grid max-w-6xl gap-2 px-4 pb-3">
      {drift && (
        <Alert tone="warn">
          <p className="font-semibold">{t('compat.staleTitle')}</p>
          <p>{t('compat.staleBody')}</p>
          <p className="mono mt-1 text-xs opacity-80">{drift}</p>
          <button type="button" className="btn-ghost mt-2 !px-2 !py-1 text-xs" onClick={() => window.location.reload()}>
            <RefreshCw size={12} aria-hidden /> {t('compat.reload')}
          </button>
        </Alert>
      )}
      {incompatible && contractAddress && mode === 'wallet' && (
        <Alert tone="warn">
          <p className="font-semibold">{t('compat.olderTitle')}</p>
          <p>{t('compat.olderBody')}</p>
          <p className="mt-1 text-xs opacity-80">{incompatible}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {vaultUnlocked && !archived && (
              <button
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={() =>
                  void saveMeta(contractAddress, (m) => ({ ...(m ?? { label: '', createdAt: Date.now(), source: 'manual' as const }), archived: true })).then(
                    () => setMsg(t('compat.archived')),
                    (e) => setMsg((e as Error).message)
                  )
                }
              >
                <Archive size={12} aria-hidden /> {t('dir.archive')}
              </button>
            )}
            <a className="btn-ghost !px-2 !py-1 text-xs" href={explorerContractUrl(contractAddress)} target="_blank" rel="noreferrer">
              <ExternalLink size={12} aria-hidden /> {t('compat.explorer')}
            </a>
          </div>
          {msg && <p className="mt-1 text-xs">{msg}</p>}
        </Alert>
      )}
    </div>
  );
}
