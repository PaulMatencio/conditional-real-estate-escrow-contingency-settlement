'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Archive, ArchiveRestore, ChevronDown, ClipboardCopy, FileDown, FolderOpen, Pencil, Search } from 'lucide-react';
import { renameMeta, testSummary } from '@/application/escrowDirectory';
import { CASE_ID_MAX, LABEL_MAX, displayLabel, matchesSearch, runLabels, sortEntries, type DirectoryEntry, type EscrowMeta } from '@/domain/escrowMeta';
import { shortHex } from '@/domain/hex';
import { TEST_CASES, testMatrixMarkdown } from '@/domain/testCases';
import { networkConfig } from '@/infrastructure/config/network';
import { readPublicView } from '@/infrastructure/gateway/publicReader';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useEscrow } from '../providers/EscrowProvider';
import { useT } from '../i18n';
import { Badge } from './ui';

/** The page's own role: the default role filter (the buyer page lists the escrows where this vault holds a buyer key). */
const PAGE_ROLE: Record<string, string> = {
  '/admin': 'admin',
  '/buyer': 'buyer',
  '/seller': 'seller',
  '/lender': 'lender',
  '/inspector': 'inspector',
  '/title-agent': 'titleAgent',
  '/resolver': 'resolver'
};
const ROLES = ['admin', 'buyer', 'seller', 'lender', 'inspector', 'titleAgent', 'resolver', 'custodian'];
const ENDED = 'ended';
const UNREADABLE = 'unreadable';

const statusTone = (s: string | undefined) =>
  !s || s === UNREADABLE || s === ENDED
    ? 'muted'
    : s === 'Closed'
      ? 'ok'
      : ['Forfeited', 'Withdrawn', 'Refunded', 'Expired', 'Cancelled'].includes(s)
        ? 'bad'
        : s === 'Disputed'
          ? 'warn'
          : 'accent';

const ago = (ms: number | undefined) => {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'now';
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129_600) return `${Math.round(s / 3600)} h`;
  return new Date(ms).toLocaleDateString();
};

/**
 * Header escrow switcher (every page): the escrows this browser's vault holds, with their name, test case, live status
 * and the roles held here. Picking one opens it everywhere (party pages and the admin console). The vault is the
 * registry: names are local, encrypted, and travel to the other parties only inside the encrypted terms packages.
 */
export function EscrowSwitcher() {
  const { t } = useT();
  const path = usePathname() ?? '/';
  const { directory, vaultUnlocked, contractAddress, view, sim, switchEscrow, saveMeta, mode } = useEscrow();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [role, setRole] = useState<string>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ label: '', caseId: '', description: '', tags: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setRole(PAGE_ROLE[path] ?? 'all'), [path]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Live status when the list opens: one public-ledger read per escrow, cached on its record for next time.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const e of directory) {
      if (e.meta?.archived && !showArchived) continue;
      const read: Promise<string> =
        e.meta?.network === 'simulator'
          ? Promise.resolve(sim?.contractAddress === e.address ? sim.view().status : ENDED)
          : readPublicView(e.address).then((v) => v.status as string, () => UNREADABLE);
      void read.then((s) => {
        if (!alive) return;
        setStatuses((x) => (x[e.address] === s ? x : { ...x, [e.address]: s }));
        if (e.meta && e.meta.lastStatus !== s && s !== UNREADABLE) void saveMeta(e.address, (m) => (m ? { ...m, lastStatus: s } : m)).catch(() => undefined);
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showArchived]);

  const runs = useMemo(() => runLabels(directory), [directory]);
  const current = directory.find((e) => e.address === contractAddress);
  const archivedCount = directory.filter((e) => e.meta?.archived).length;
  const list = directory
    .filter((e) => showArchived || !e.meta?.archived)
    .filter((e) => role === 'all' || e.roles.includes(role))
    .filter((e) => matchesSearch(e, q))
    .sort(sortEntries);
  const statusOf = (e: DirectoryEntry) => (e.address === contractAddress && view ? view.status : (statuses[e.address] ?? e.meta?.lastStatus));

  const guard = async (fn: () => Promise<void>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const pick = (a: string) =>
    guard(async () => {
      await switchEscrow(a);
      setOpen(false);
    });
  const openByAddress = () =>
    guard(async () => {
      const a = addr.trim().toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/.test(a)) throw new Error(t('dir.badAddress'));
      // A record so the escrow shows in the list ("Unnamed", renamable).
      if (vaultUnlocked) await saveMeta(a, (m) => m ?? { label: '', createdAt: Date.now(), source: 'manual', network: networkConfig.networkId, lastOpenedAt: Date.now() });
      await switchEscrow(a);
      setAddr('');
      setOpen(false);
    });
  const startEdit = (e: DirectoryEntry) => {
    setEditing(e.address);
    setForm({ label: e.meta?.label ?? '', caseId: e.meta?.caseId ?? '', description: e.meta?.description ?? '', tags: (e.meta?.tags ?? []).join(', ') });
  };
  const saveEdit = (a: string) =>
    guard(async () => {
      await saveMeta(a, (m) => renameMeta(m, { label: form.label, caseId: form.caseId || undefined, description: form.description || undefined, tags: form.tags.split(',') }, Date.now()));
      setEditing(null);
    });
  const toggleArchive = (e: DirectoryEntry) =>
    guard(() => saveMeta(e.address, (m) => ({ ...(m ?? ({ label: '', createdAt: Date.now(), source: 'manual' } as EscrowMeta)), archived: !m?.archived })));
  const copySummary = (e: DirectoryEntry) =>
    guard(async () => {
      const r = await sharedVault().load(e.address);
      await navigator.clipboard.writeText(testSummary(e.address, r, statusOf(e) ?? null, e.meta?.network ?? networkConfig.networkId));
      setMsg(t('dir.copied'));
    });
  const exportMatrix = () => {
    const blob = new Blob([`# Escrow v2 test matrix\n\n${testMatrixMarkdown()}\n`], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'escrow-test-matrix.md';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const label = current ? displayLabel(current.address, current.meta) : contractAddress ? displayLabel(contractAddress) : t('dir.choose');
  const caseChip = current ? runs[current.address] : undefined;

  return (
    <div className="relative" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="btn-ghost max-w-[22rem] !py-1.5" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        {caseChip && <span className="mono rounded bg-accent/20 px-1.5 text-xs text-accent">{caseChip}</span>}
        <span className="truncate">{mode === 'simulator' && !current ? t('dir.simulation') : label}</span>
        {view && contractAddress && <Badge tone={statusTone(view.status)}>{view.status}</Badge>}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label={t('dir.title')} className="absolute right-0 z-50 mt-2 w-[min(46rem,calc(100vw-2rem))] space-y-3 rounded-2xl border border-midnight-600 bg-midnight-900 p-4 shadow-glow">
          {!vaultUnlocked && <p className="text-sm text-warn">{t('dir.unlock')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">{t('dir.search')}</span>
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
              <input className="input !pl-8" placeholder={t('dir.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            </label>
            <label className="flex items-center gap-1 text-sm">
              <span className="sr-only">{t('dir.role')}</span>
              <select className="input !w-auto" value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('dir.role')}>
                <option value="all">{t('dir.allRoles')}</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('dir.showArchived')} ({archivedCount})
            </label>
          </div>

          <ul className="max-h-[50vh] space-y-1 overflow-y-auto" aria-label={t('dir.title')}>
            {list.length === 0 && <li className="p-3 text-sm text-slate-400">{vaultUnlocked ? t('dir.empty') : '—'}</li>}
            {list.map((e) => {
              const st = statusOf(e);
              const active = e.address === contractAddress;
              return (
                <li key={e.address} className={`rounded-xl border p-2 ${active ? 'border-accent bg-accent/10' : 'border-transparent hover:border-midnight-700'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left" onClick={() => void pick(e.address)} aria-current={active ? 'true' : undefined}>
                      <span className="mono w-20 shrink-0 text-xs text-accent">{runs[e.address] ?? '—'}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm font-medium ${e.meta?.label ? 'text-white' : 'text-slate-300'}`}>{displayLabel(e.address, e.meta)}</span>
                        <span className="mono block truncate text-xs text-slate-500">
                          {shortHex(e.address, 6, 4)} · {e.meta?.network ?? '—'}
                          {e.meta?.tags?.length ? ` · ${e.meta.tags.join(', ')}` : ''}
                        </span>
                      </span>
                      <Badge tone={statusTone(st)}>{st === ENDED ? t('dir.ended') : st === UNREADABLE ? t('dir.unreadable') : (st ?? '…')}</Badge>
                      <span className="hidden w-28 truncate text-xs text-slate-400 sm:inline">{e.roles.join(', ') || '—'}</span>
                      <span className="hidden w-16 text-right text-xs text-slate-500 sm:inline">{ago(e.meta?.lastOpenedAt)}</span>
                    </button>
                    <div className="flex gap-1">
                      <button type="button" className="btn-ghost !p-2" onClick={() => startEdit(e)} aria-label={t('dir.rename')} title={t('dir.rename')} disabled={!vaultUnlocked}>
                        <Pencil size={14} aria-hidden />
                      </button>
                      <button type="button" className="btn-ghost !p-2" onClick={() => void copySummary(e)} aria-label={t('dir.copySummary')} title={t('dir.copySummary')} disabled={!vaultUnlocked}>
                        <ClipboardCopy size={14} aria-hidden />
                      </button>
                      <button type="button" className="btn-ghost !p-2" onClick={() => void toggleArchive(e)} aria-label={t(e.meta?.archived ? 'dir.unarchive' : 'dir.archive')} title={t(e.meta?.archived ? 'dir.unarchive' : 'dir.archive')} disabled={!vaultUnlocked}>
                        {e.meta?.archived ? <ArchiveRestore size={14} aria-hidden /> : <Archive size={14} aria-hidden />}
                      </button>
                    </div>
                  </div>
                  {editing === e.address && (
                    <form
                      className="mt-2 grid gap-2 rounded-lg border border-midnight-700 p-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void saveEdit(e.address);
                      }}
                    >
                      <label className="text-xs text-slate-400">
                        {t('dir.case')}
                        <input className="input mono" list="dir-cases" maxLength={CASE_ID_MAX} value={form.caseId} onChange={(x) => setForm({ ...form, caseId: x.target.value })} />
                      </label>
                      <label className="text-xs text-slate-400">
                        {t('dir.label')}
                        <input className="input" maxLength={LABEL_MAX} value={form.label} onChange={(x) => setForm({ ...form, label: x.target.value })} required />
                      </label>
                      <label className="text-xs text-slate-400 sm:col-span-2">
                        {t('dir.description')}
                        <textarea className="input" rows={2} value={form.description} onChange={(x) => setForm({ ...form, description: x.target.value })} />
                      </label>
                      <label className="text-xs text-slate-400 sm:col-span-2">
                        {t('dir.tags')}
                        <input className="input" value={form.tags} onChange={(x) => setForm({ ...form, tags: x.target.value })} />
                      </label>
                      <p className="text-xs text-slate-500 sm:col-span-2">{t('dir.renameLocal')}</p>
                      <div className="flex gap-2 sm:col-span-2">
                        <button type="submit" className="btn-primary">
                          {t('dir.save')}
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                          {t('common.close')}
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <datalist id="dir-cases">
            {TEST_CASES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </datalist>

          {msg && <p className="text-sm text-slate-300" aria-live="polite">{msg}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-midnight-700 pt-3">
            <label className="min-w-56 flex-1">
              <span className="sr-only">{t('dir.openByAddress')}</span>
              <input className="input mono" placeholder={t('dir.addressPlaceholder')} value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
            </label>
            <button type="button" className="btn-primary" onClick={() => void openByAddress()} disabled={!addr.trim()}>
              <FolderOpen size={14} aria-hidden /> {t('dir.openByAddress')}
            </button>
            <button type="button" className="btn-ghost" onClick={exportMatrix}>
              <FileDown size={14} aria-hidden /> {t('dir.exportMatrix')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
