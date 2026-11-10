'use client';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { ScrollText } from 'lucide-react';
import { displayStatus, toCsv, type TxLogEntry } from '@/application/txLog';
import { shortHex } from '@/domain/hex';
import { explorerTxUrl } from '@/infrastructure/config/network';
import { sharedTxLog } from '@/infrastructure/storage/txLogStore';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useT } from '../i18n';
import { Badge, Card } from './ui';

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
 */
export function TxLogPanel({ contractAddress, embedded = false }: { contractAddress?: string | null; embedded?: boolean }) {
  const { t } = useT();
  const log = sharedTxLog();
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot, () => EMPTY);
  const [scope, setScope] = useState<'contract' | 'all'>(contractAddress ? 'contract' : 'all');
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
      </td>
      <td className="py-1.5 pr-3">{e.actor}</td>
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
      </td>
    </tr>
  );
}
