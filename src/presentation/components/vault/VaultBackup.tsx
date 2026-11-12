'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArchiveRestore, DatabaseBackup, DownloadCloud, FolderInput } from 'lucide-react';
import { summarize, type BackupSummary, type RestoreReport, type VaultBackup } from '@/application/vaultBackup';
import { shortHex } from '@/domain/hex';
import { MIN_BACKUP_PASSPHRASE, exportVault, openBackup, restoreVault, sealBackup, type BackupScope } from '@/infrastructure/storage/vaultBackupStore';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Spinner } from '../ui';
import { FilePick, downloadJson, readJsonFile } from '../party/helpers';

const LAST_BACKUP = 'escrow:vault:lastBackupAt';

function readLast(): number | null {
  try {
    const v = localStorage.getItem(LAST_BACKUP);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function Summary({ s, showAdmin = true }: { s: BackupSummary; showAdmin?: boolean }) {
  const { t } = useT();
  return (
    <div className="space-y-2 text-sm">
      <p className="text-slate-400">
        {t('vaultBackup.escrows')}: <strong className="text-white">{s.contracts.length}</strong> · {t('vaultBackup.identity')}: {s.identity ? '✓' : '—'} · {showAdmin && <>{t('vaultBackup.adminKey')}: {s.adminKey ? '✓' : '—'} · </>}{t('txlog.entries')}: <strong className="text-white">{s.txLog}</strong>
      </p>
      <ul className="space-y-1">
        {s.contracts.map((c) => (
          <li key={c.address} className="flex flex-wrap items-center gap-1.5">
            <span className="mono text-slate-300">{shortHex(c.address)}</span>
            {c.terms && <Badge tone="accent">{t('vaultBackup.terms')}</Badge>}
            {c.custody && <Badge tone="accent">{t('custody.badge')}</Badge>}
            {c.lenderTerms && <Badge tone="accent">{t('lender.termsTitle')}</Badge>}
            {c.roleKeys.map((r) => (
              <Badge key={r} tone="muted">{r}</Badge>
            ))}
            {c.kyc.map((r) => (
              <Badge key={`kyc-${r}`} tone="muted">KYC {r}</Badge>
            ))}
            {c.authorityKey && <Badge tone="warn">{t('vaultBackup.authorityKey')}</Badge>}
            {c.renounced && <Badge tone="ok">{t('vaultBackup.renounced')}</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * No vault on this address yet (e.g. the dApp moved from localhost:3000 to admin.localhost:3000: every address has its
 * own browser storage). Instead of starting empty, create the vault FROM a backup: decrypt and preview it first, then
 * choose the new vault's passphrase; the vault is created and the backup merged into it in one step. The backup's
 * envelope key replaces the one generated for the empty vault, so terms envelopes sent to it still open.
 */
export function RestoreIntoNewVault({ scope, onRestored }: { scope: BackupScope; onRestored?: (b: VaultBackup) => Promise<void> }) {
  const { t } = useT();
  const { unlockVault, reloadVault } = useEscrow();
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [bpass, setBpass] = useState('');
  const [opened, setOpened] = useState<VaultBackup | null>(null);
  const [vpass, setVpass] = useState('');
  const [vpass2, setVpass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);

  const decrypt = async () => {
    setMsg(null);
    if (!file) return;
    setBusy(true);
    try {
      setOpened(await openBackup(file.data, bpass));
    } catch (e) {
      setOpened(null);
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const createAndRestore = async () => {
    setMsg(null);
    if (!opened) return;
    if (vpass.length < 8) return setMsg({ tone: 'bad', text: t('vault.tooShort') });
    if (vpass !== vpass2) return setMsg({ tone: 'bad', text: t('vaultBackup.passMismatch') });
    setBusy(true);
    try {
      const problem = await unlockVault(vpass); // creates the (empty) vault on this address
      if (problem) throw new Error(problem);
      const r = await restoreVault(sharedVault(), opened, { scope });
      await onRestored?.(opened);
      await reloadVault(); // re-reads the restored envelope key (and, on the admin page, the admin key)
      if (r.adminSkipped) setMsg({ tone: 'warn', text: t('vaultBackup.adminSkipped') });
      setOpened(null);
      setFile(null);
      setBpass('');
      setVpass('');
      setVpass2('');
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('vaultBackup.newTitle')} icon={<FolderInput size={16} aria-hidden />}>
      <p className="mb-3 text-sm text-slate-400">
        {t(scope === 'admin' ? 'vaultBackup.newHint' : 'vaultBackup.partyNewHint').replace('{origin}', typeof location !== 'undefined' ? location.origin : '')}
      </p>
      {msg && (
        <div className="mb-3">
          <Alert tone={msg.tone} onClose={() => setMsg(null)}>
            {msg.text}
          </Alert>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FilePick
          label={t('vaultBackup.choose')}
          accept="application/json,.json"
          onFile={(f) =>
            void readJsonFile(f).then(
              (data) => (setFile({ name: f.name, data }), setOpened(null), setMsg(null)),
              () => setMsg({ tone: 'bad', text: t('vaultBackup.badFile') })
            )
          }
        />
        {file && <span className="text-sm text-slate-300">{file.name}</span>}
      </div>
      {file && !opened && (
        <div className="mt-3 flex gap-2">
          <input type="password" className="input" placeholder={t('vaultBackup.pass')} aria-label={t('vaultBackup.pass')} value={bpass} onChange={(e) => setBpass(e.target.value)} />
          <button type="button" className="btn-ghost" disabled={busy || !bpass} onClick={() => void decrypt()}>
            {busy ? <Spinner /> : null} {t('vaultBackup.decrypt')}
          </button>
        </div>
      )}
      {opened && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-300">
            {t('vaultBackup.createdAt')}: {new Date(opened.createdAt).toLocaleString()}
          </p>
          <Summary s={summarize(opened)} />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label={t('vaultBackup.newPass')} htmlFor="nv-pass" hint={t('vaultBackup.newPassHint')}>
              <input id="nv-pass" type="password" className="input" value={vpass} onChange={(e) => setVpass(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label={t('vaultBackup.newPass2')} htmlFor="nv-pass2">
              <input id="nv-pass2" type="password" className="input" value={vpass2} onChange={(e) => setVpass2(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <button type="button" className="btn-primary" disabled={busy || !vpass || !vpass2} onClick={() => void createAndRestore()}>
            {busy ? <Spinner /> : <ArchiveRestore size={16} aria-hidden />} {t('vaultBackup.newRestore')}
          </button>
        </div>
      )}
    </Card>
  );
}

/**
 * Backup and restore cards. Backup: every vault record, sealed with a separate backup passphrase — on the admin page
 * optionally with the admin secret key; on party / notary pages ('party' scope) never with admin or authority keys.
 * Restore: decrypt, preview, then merge — never deletes.
 */
export function VaultBackupCards({
  scope,
  contractAddress,
  adminKey,
  onRestored
}: {
  scope: BackupScope;
  /** Remembered in the file so a restore on a fresh address can reopen the same escrow. */
  contractAddress?: string | null;
  /** Admin page only: whether an admin secret key exists (shown in the summary when included). */
  adminKey?: boolean;
  onRestored?: (b: VaultBackup) => Promise<void>;
}) {
  const { t } = useT();
  const { vaultUnlocked, reloadVault } = useEscrow();
  const isAdmin = scope === 'admin';
  const [current, setCurrent] = useState<BackupSummary | null>(null);
  const [includeAdmin, setIncludeAdmin] = useState(true);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [rpass, setRpass] = useState('');
  const [opened, setOpened] = useState<VaultBackup | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);

  useEffect(() => setLast(readLast()), []);
  useEffect(() => {
    if (!vaultUnlocked) return setCurrent(null);
    void exportVault(sharedVault(), { scope }).then((b) => setCurrent(summarize(b)), () => setCurrent(null));
  }, [vaultUnlocked, report, scope]);

  const backup = async () => {
    setMsg(null);
    if (pass.length < MIN_BACKUP_PASSPHRASE) return setMsg({ tone: 'bad', text: t('vaultBackup.passShort') });
    if (pass !== pass2) return setMsg({ tone: 'bad', text: t('vaultBackup.passMismatch') });
    setBusy(true);
    try {
      const b = await exportVault(sharedVault(), { scope, includeAdminKey: isAdmin && includeAdmin, contractAddress: contractAddress ?? undefined });
      const who = isAdmin ? 'admin' : location.pathname.split('/')[1] || 'party';
      downloadJson(`escrow-vault-backup-${who}-${new Date().toISOString().slice(0, 10)}.json`, await sealBackup(b, pass));
      const now = Date.now();
      try {
        localStorage.setItem(LAST_BACKUP, String(now));
      } catch {
        /* storage blocked */
      }
      setLast(now);
      setPass('');
      setPass2('');
      setMsg({ tone: 'ok', text: t('vaultBackup.done') });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    setMsg(null);
    setReport(null);
    if (!file) return;
    setBusy(true);
    try {
      setOpened(await openBackup(file.data, rpass));
    } catch (e) {
      setOpened(null);
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!opened) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await restoreVault(sharedVault(), opened, { scope });
      const admin = r.admin === null ? null : r.admin.startsWith('admin secret key restored') ? t('vaultBackup.adminRestored') : t('vaultBackup.adminKept');
      await onRestored?.(opened);
      await reloadVault(); // re-reads envelope keys and the active escrow (admin page: also the admin key)
      setReport({ ...r, admin });
      setOpened(null);
      setRpass('');
      setFile(null);
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!vaultUnlocked) return null;
  return (
    <div className={isAdmin ? 'space-y-4' : 'grid items-start gap-4 lg:grid-cols-2'}>
      {msg && (
        <div className="lg:col-span-2">
          <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>
        </div>
      )}
      <Card title={t('vaultBackup.backupTitle')} icon={<DownloadCloud size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t(isAdmin ? 'vaultBackup.backupHint' : 'vaultBackup.partyBackupHint')}</p>
        {current && <Summary s={{ ...current, adminKey: isAdmin && includeAdmin && !!adminKey }} showAdmin={isAdmin} />}
        <p className="mt-2 text-xs text-slate-500">
          {t('vaultBackup.last')}: {last ? new Date(last).toLocaleString() : t('vaultBackup.never')}
        </p>
        {isAdmin && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeAdmin} onChange={(e) => setIncludeAdmin(e.target.checked)} /> {t('vaultBackup.includeAdmin')}
          </label>
        )}
        <div className="mt-3 grid gap-x-4 sm:grid-cols-2">
          <Field label={t('vaultBackup.pass')} tip={t('tip.vaultBackup.pass')} htmlFor={`vb-pass-${scope}`} hint={t('vaultBackup.passHint')}>
            <input id={`vb-pass-${scope}`} type="password" className="input" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label={t('vaultBackup.pass2')} htmlFor={`vb-pass2-${scope}`}>
            <input id={`vb-pass2-${scope}`} type="password" className="input" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void backup()}>
          {busy ? <Spinner /> : <DownloadCloud size={16} aria-hidden />} {t('vaultBackup.download')}
        </button>
      </Card>

      <Card title={t('vaultBackup.restoreTitle')} icon={<ArchiveRestore size={16} aria-hidden />}>
        <p className="mb-3 text-sm text-slate-400">{t('vaultBackup.restoreHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <FilePick
            label={t('vaultBackup.choose')}
            accept="application/json,.json"
            onFile={(f) =>
              void readJsonFile(f).then(
                (data) => (setFile({ name: f.name, data }), setOpened(null), setReport(null)),
                () => setMsg({ tone: 'bad', text: t('vaultBackup.badFile') })
              )
            }
          />
          {file && <span className="text-sm text-slate-300">{file.name}</span>}
        </div>
        {file && (
          <div className="mt-3 flex gap-2">
            <input type="password" className="input" placeholder={t('vaultBackup.pass')} aria-label={t('vaultBackup.pass')} value={rpass} onChange={(e) => setRpass(e.target.value)} />
            <button type="button" className="btn-ghost" disabled={busy || !rpass} onClick={() => void open()}>
              {busy ? <Spinner /> : null} {t('vaultBackup.decrypt')}
            </button>
          </div>
        )}
        {opened && (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-300">
              {t('vaultBackup.createdAt')}: {new Date(opened.createdAt).toLocaleString()}
            </p>
            <Summary s={summarize(opened)} />
            {!isAdmin && (summarize(opened).adminKey || summarize(opened).contracts.some((c) => c.authorityKey)) && <Alert tone="warn">{t('vaultBackup.adminSkipped')}</Alert>}
            <Alert tone="warn">{t('vaultBackup.mergeNote')}</Alert>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void restore()}>
              {busy ? <Spinner /> : <ArchiveRestore size={16} aria-hidden />} {t('vaultBackup.restore')}
            </button>
          </div>
        )}
        {report && (
          <div className="mt-3 space-y-2 text-sm" aria-live="polite">
            <Alert tone="ok">
              {t('vaultBackup.restored')}: {report.contractsAdded.length} {t('vaultBackup.new')}, {report.contractsMerged.length} {t('vaultBackup.merged')}
            </Alert>
            {[...report.added, ...(report.identity ? [report.identity] : []), ...(report.admin ? [report.admin] : []), ...(report.txLogAdded ? [`${t('txlog.entries')}: +${report.txLogAdded}`] : [])].map((a) => (
              <p key={a} className="text-slate-300">+ {a}</p>
            ))}
            {report.adminSkipped && <Alert tone="warn">{t('vaultBackup.adminSkipped')}</Alert>}
            {report.conflicts.map((c) => (
              <Alert key={c} tone="warn">{c}</Alert>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Party and notary pages: backup / restore of this page's vault. No vault yet on this address → create it from a backup.
 * Locked → nothing (the page's own unlock card handles that). Unlocked → collapsible backup and restore cards.
 */
/** The escrows a backup holds (record ids that are contract addresses). */
export const backupEscrows = (b: VaultBackup) => Object.keys(b.records).filter((id) => /^[0-9a-f]{64}$/.test(id));

export function VaultBackupSection({ contractAddress, onRestored, lockedHint }: { contractAddress?: string | null; onRestored?: (b: VaultBackup) => Promise<void>; lockedHint?: ReactNode }) {
  const { t } = useT();
  const { vaultExists, vaultUnlocked } = useEscrow();
  if (vaultExists === false) return <RestoreIntoNewVault scope="party" onRestored={onRestored} />;
  if (!vaultUnlocked) return lockedHint ? <>{lockedHint}</> : null;
  return (
    <details className="card print:hidden">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-white">
        <DatabaseBackup size={16} aria-hidden /> {t('vaultBackup.sectionTitle')}
      </summary>
      <p className="mt-2 text-sm text-slate-400">{t('vaultBackup.sectionHint')}</p>
      <div className="mt-4">
        <VaultBackupCards scope="party" contractAddress={contractAddress} onRestored={onRestored} />
      </div>
    </details>
  );
}
