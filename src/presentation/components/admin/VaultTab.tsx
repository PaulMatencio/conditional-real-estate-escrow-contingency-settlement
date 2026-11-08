'use client';
import { useEffect, useState } from 'react';
import { ArchiveRestore, DownloadCloud } from 'lucide-react';
import { summarize, type BackupSummary, type RestoreReport, type VaultBackup } from '@/application/vaultBackup';
import { shortHex } from '@/domain/hex';
import { MIN_BACKUP_PASSPHRASE, exportVault, openBackup, restoreVault, sealBackup } from '@/infrastructure/storage/vaultBackupStore';
import { sharedVault } from '@/infrastructure/storage/vaultInstance';
import { useApp } from '../../providers/AppProvider';
import { useEscrow } from '../../providers/EscrowProvider';
import { useT } from '../../i18n';
import { Alert, Badge, Card, Field, Spinner } from '../ui';
import { VaultGate } from '../party/PartySetup';
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

function Summary({ s }: { s: BackupSummary }) {
  const { t } = useT();
  return (
    <div className="space-y-2 text-sm">
      <p className="text-slate-400">
        {t('vaultBackup.escrows')}: <strong className="text-white">{s.contracts.length}</strong> · {t('vaultBackup.identity')}: {s.identity ? '✓' : '—'} · {t('vaultBackup.adminKey')}: {s.adminKey ? '✓' : '—'}
      </p>
      <ul className="space-y-1">
        {s.contracts.map((c) => (
          <li key={c.address} className="flex flex-wrap items-center gap-1.5">
            <span className="mono text-slate-300">{shortHex(c.address)}</span>
            {c.terms && <Badge tone="accent">{t('vaultBackup.terms')}</Badge>}
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
 * Vault backup / restore (admin page). Backup: every vault record (all escrows, the envelope identity) and optionally
 * the admin secret key, sealed with a separate backup passphrase. Restore: decrypt, preview, then merge — never deletes.
 */
export function VaultTab() {
  const { t } = useT();
  const { adminKey, contractAddress, loadContract } = useApp();
  const { vaultUnlocked, reloadVault } = useEscrow();
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
    void exportVault(sharedVault()).then((b) => setCurrent(summarize(b)), () => setCurrent(null));
  }, [vaultUnlocked, report]);

  const backup = async () => {
    setMsg(null);
    if (pass.length < MIN_BACKUP_PASSPHRASE) return setMsg({ tone: 'bad', text: t('vaultBackup.passShort') });
    if (pass !== pass2) return setMsg({ tone: 'bad', text: t('vaultBackup.passMismatch') });
    setBusy(true);
    try {
      const b = await exportVault(sharedVault(), { includeAdminKey: includeAdmin, contractAddress: contractAddress ?? undefined });
      downloadJson(`escrow-vault-backup-${new Date().toISOString().slice(0, 10)}.json`, await sealBackup(b, pass));
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
      const r = await restoreVault(sharedVault(), opened);
      const admin = r.admin === null ? null : r.admin.startsWith('admin secret key restored') ? t('vaultBackup.adminRestored') : t('vaultBackup.adminKept');
      if (!contractAddress && opened.admin?.contractAddress) await loadContract(opened.admin.contractAddress);
      await reloadVault(); // also tells the admin console to re-read its key from the vault
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

  return (
    <div className="space-y-4">
      <VaultGate />
      {msg && <Alert tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {vaultUnlocked && (
        <>
          <Card title={t('vaultBackup.backupTitle')} icon={<DownloadCloud size={16} aria-hidden />}>
            <p className="mb-3 text-sm text-slate-400">{t('vaultBackup.backupHint')}</p>
            {current && <Summary s={{ ...current, adminKey: includeAdmin && !!adminKey }} />}
            <p className="mt-2 text-xs text-slate-500">
              {t('vaultBackup.last')}: {last ? new Date(last).toLocaleString() : t('vaultBackup.never')}
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeAdmin} onChange={(e) => setIncludeAdmin(e.target.checked)} /> {t('vaultBackup.includeAdmin')}
            </label>
            <div className="mt-3 grid gap-x-4 sm:grid-cols-2">
              <Field label={t('vaultBackup.pass')} htmlFor="vb-pass" hint={t('vaultBackup.passHint')}>
                <input id="vb-pass" type="password" className="input" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label={t('vaultBackup.pass2')} htmlFor="vb-pass2">
                <input id="vb-pass2" type="password" className="input" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
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
                {[...report.added, ...(report.identity ? [report.identity] : []), ...(report.admin ? [report.admin] : [])].map((a) => (
                  <p key={a} className="text-slate-300">+ {a}</p>
                ))}
                {report.conflicts.map((c) => (
                  <Alert key={c} tone="warn">{c}</Alert>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
