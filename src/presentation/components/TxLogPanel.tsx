'use client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CloudDownload, ScrollText } from 'lucide-react';
import { importChainHistory } from '@/application/chainHistory';
import { displayStatus, toCsv, type TxLogEntry } from '@/application/txLog';
import { shortHex } from '@/domain/hex';
import { explorerTxUrl, indexerHttpUrl, networkConfig } from '@/infrastructure/config/network';
import { IndexerChainHistory } from '@/infrastructure/indexer/chainHistorySource';
import { sharedTxLog } from '@/infrastructure/storage/txLogStore';
import { formatDust } from '@/infrastructure/wallet/dust';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useT } from '../i18n';
import { Alert, Badge, Card, Spinner } from './ui';

const PAGE = 50;
const isHash = (h?: string) => !!h && /^[0-9a-f]{64}$/i.test(h);
const EMPTY: readonly TxLogEntry[] = [];

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The persistent transaction log (encrypted in the vault): every transaction built in this browser, newest first,
 * with its outcome. `contractAddress` scopes it to one escrow (party pages); the admin Log tab shows everything.
 * `importAddress` (a deployed escrow) enables "Import history from chain".
 */
export function TxLogPanel({ contractAddress, importAddress, embedded = false }: { contractAddress?: string | null; importAddress?: string | null; embedded?: boolean }) {
  const { t } = useT();
  const log = sharedTxLog();
  const [importing, setImporting] = useState<number | null>(null);
  const [importMsg, setImportMsg] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const importFromChain = async () => {
    if (!importAddress) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setImporting(0);
    setImportMsg(null);
    try {
      const source = new IndexerChainHistory(indexerHttpUrl(), networkConfig.indexerWS);
      const { actions, complete } = await source.contractActions(importAddress, { signal: ac.signal, onProgress: (n) => setImporting(n) });
      const r = await log.transform((current) => importChainHistory(current, actions, { contractAddress: importAddress, network: networkConfig.networkId }));
      const text = t('txlog.importDone')
        .replace('{found}', String(actions.length))
        .replace('{added}', String(r.added))
        .replace('{matched}', String(r.matched));
      setImportMsg({ tone: complete ? 'ok' : 'warn', text: complete ? text : `${text} ${t('txlog.importPartial')}` });
    } catch (e) {
      setImportMsg({ tone: (e as Error).name === 'AbortError' ? 'warn' : 'bad', text: (e as Error).name === 'AbortError' ? t('txlog.importCancelled') : `${t('txlog.importFailed')} ${(e as Error).message}` });
    } finally {
      setImporting(null);
      abortRef.current = null;
    }
  };
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot, () => EMPTY);
  const [scope, setScope] = useState<'contract' | 'all'>(contractAddress ? 'contract' : 'all');
  // An escrow loaded after the panel appeared: show its transactions.
  useEffect(() => {
    if (contractAddress) setScope('contract');
  }, [contractAddress]);
  const [mode, setMode] = useState<'any' | 'wallet' | 'simulator'>('any');
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(
    () =>
      [...entries]
        .filter((e) => scope === 'all' || !contractAddress || e.contractAddress === contractAddress)
        .filter((e) => mode === 'any' || e.mode === mode)
        .reverse(),
    [entries, scope, mode, contractAddress]
  );
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const body = (
    <>
      <p className="mb-3 text-sm text-slate-400">{t('txlog.hint')}</p>
      {!sharedVault().unlocked && <p className="mb-3 text-sm text-warn">{t('txlog.locked')}</p>}
      {importAddress && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {importing === null ? (
            <button type="button" className="btn-ghost" disabled={!sharedVault().unlocked} onClick={() => void importFromChain()} title={t('txlog.importHint')}>
              <CloudDownload size={16} aria-hidden /> {t('txlog.import')}
            </button>
          ) : (
            <>
              <Spinner />
              <span aria-live="polite">
                {t('txlog.importing')} {importing}
              </span>
              <button type="button" className="btn-ghost" onClick={() => abortRef.current?.abort()}>
                {t('keys.replaceCancel')}
              </button>
            </>
          )}
          <span className="text-xs text-slate-500">
            {t('txlog.importFor')} <span className="mono">{shortHex(importAddress)}</span>
          </span>
        </div>
      )}
      {importMsg && (
        <div className="mb-3">
          <Alert tone={importMsg.tone} onClose={() => setImportMsg(null)}>
            {importMsg.text}
          </Alert>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {contractAddress && (
          <select className="input !w-auto" aria-label={t('txlog.scope')} value={scope} onChange={(e) => setScope(e.target.value as 'contract' | 'all')}>
            <option value="contract">{t('txlog.thisEscrow')}</option>
            <option value="all">{t('txlog.allEscrows')}</option>
          </select>
        )}
        <select className="input !w-auto" aria-label={t('txlog.mode')} value={mode} onChange={(e) => setMode(e.target.value as 'any' | 'wallet' | 'simulator')}>
          <option value="any">{t('txlog.anyMode')}</option>
          <option value="wallet">{t('party.mode.wallet')}</option>
          <option value="simulator">{t('party.mode.simulator')}</option>
        </select>
        <span className="text-slate-500">
          {filtered.length} / {entries.length}
        </span>
        <span className="flex-1" />
        <button type="button" className="btn-ghost" disabled={filtered.length === 0} onClick={() => download(`transactions-${stamp}.csv`, toCsv([...filtered].reverse(), log.session), 'text/csv')}>
          {t('txlog.exportCsv')}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={filtered.length === 0}
          onClick={() => download(`transactions-${stamp}.json`, JSON.stringify([...filtered].reverse().map((e) => ({ ...e, status: displayStatus(e, log.session) })), null, 2), 'application/json')}
        >
          {t('txlog.exportJson')}
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-slate-500">{t('txlog.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('txlog.when')}</th>
                <th className="py-1 pr-3 font-medium">{t('txlog.action')}</th>
                <th className="py-1 pr-3 font-medium">{t('txlog.actor')}</th>
                {(scope === 'all' || !contractAddress) && <th className="py-1 pr-3 font-medium">{t('txlog.contract')}</th>}
                <th className="py-1 pr-3 font-medium">{t('txlog.status')}</th>
                <th className="py-1 pr-3 font-medium">{t('txlog.tx')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, shown).map((e) => (
                <Row key={e.id} e={e} session={log.session} showContract={scope === 'all' || !contractAddress} />
              ))}
            </tbody>
          </table>
          {filtered.length > shown && (
            <button type="button" className="btn-ghost mt-2" onClick={() => setShown((n) => n + PAGE)}>
              {t('txlog.more')} ({filtered.length - shown})
            </button>
          )}
        </div>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <Card title={t('txlog.title')} icon={<ScrollText size={16} aria-hidden />} tip={t('tip.txlog.title')}>
      {body}
    </Card>
  );
}

function Row({ e, session, showContract }: { e: TxLogEntry; session: string; showContract: boolean }) {
  const { t } = useT();
  const st = displayStatus(e, session);
  const tone = st === 'confirmed' ? 'ok' : st === 'failed' ? 'bad' : st === 'interrupted' ? 'warn' : 'accent';
  return (
    <tr className="border-t border-midnight-700 align-top text-slate-300">
      <td className="whitespace-nowrap py-1.5 pr-3 text-slate-400" title={new Date(e.at).toISOString()}>
        {new Date(e.at).toLocaleString()}
      </td>
      <td className="py-1.5 pr-3">
        <span className="mono">{e.action}</span>
        {e.circuits && e.action !== 'deploy' && <div className="mono text-xs text-slate-500">{e.circuits.join(', ')}</div>}
        {e.mode === 'simulator' && (
          <span className="ml-1">
            <Badge tone="muted">{t('party.mode.simulator')}</Badge>
          </span>
        )}
        {e.source === 'chain' && (
          <span className="ml-1">
            <Badge tone="muted">{t('txlog.fromChain')}</Badge>
          </span>
        )}
        {e.source === 'both' && (
          <span className="ml-1">
            <Badge tone="ok">{t('txlog.onChain')}</Badge>
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3" title={e.actor.includes('|') || e.actor === 'unknown' ? t('txlog.actorInferred') : undefined}>
        {e.actor.includes('|') ? e.actor.split('|').join(' / ') + ' ?' : e.actor}
      </td>
      {showContract && <td className="mono py-1.5 pr-3 text-slate-400">{e.contractAddress ? shortHex(e.contractAddress) : '—'}</td>}
      <td className="py-1.5 pr-3">
        <Badge tone={tone}>{t(`txlog.st.${st}`)}</Badge>
        {e.error && (
          <div className="mt-1 max-w-xs break-words text-xs text-bad" title={e.error}>
            {e.error.length > 140 ? `${e.error.slice(0, 140)}…` : e.error}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-3">
        {isHash(e.txHash) && e.mode === 'wallet' ? (
          <a className="mono text-accent-soft underline" href={explorerTxUrl(e.txHash!)} target="_blank" rel="noopener noreferrer">
            {shortHex(e.txHash!)}
          </a>
        ) : (
          <span className="mono text-xs text-slate-500">{e.txHash ?? '—'}</span>
        )}
        {e.blockHeight !== undefined && <div className="text-xs text-slate-500">#{e.blockHeight}</div>}
        {e.fee && /^\d+$/.test(e.fee) && <div className="text-xs text-slate-500">{formatDust(BigInt(e.fee))}</div>}
      </td>
    </tr>
  );
}
