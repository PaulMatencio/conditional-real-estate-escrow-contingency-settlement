'use client';
import { useEffect, type ReactNode } from 'react';
import { useT } from '../../i18n';

/** Saves JSON as a local file (never uploaded). BigInts become strings. */
export function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readFileBytes(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

export async function readJsonFile<T = unknown>(f: File): Promise<T> {
  return JSON.parse(await f.text()) as T;
}

/** File picker that hands back the File; resets itself so the same file can be chosen twice. */
export function FilePick({ label, accept, onFile, disabled }: { label: string; accept?: string; onFile: (f: File) => void; disabled?: boolean }) {
  return (
    <label className={`btn-ghost cursor-pointer ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
      {label}
      <input
        type="file"
        className="sr-only"
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

export const fmtTime = (sec: bigint | number): string => {
  const n = Number(sec);
  if (!n) return '—';
  return new Date(n * 1000).toLocaleString();
};

export function fmtDuration(sec: number): string {
  const s = Math.abs(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** FR-DISPUTE-03 / FR-KYC-02 countdown, announced politely to screen readers. */
export function Countdown({ to, now, label }: { to: bigint; now: bigint; label: string }) {
  const { t } = useT();
  // `now` comes from the gateway (simulator time, or wall clock refreshed with the view).
  const left = Number(to) - Number(now);
  const past = left <= 0;
  return (
    <div className={`rounded-xl border p-3 ${past ? 'border-bad/40 bg-bad/10' : left < 86400 * 2 ? 'border-warn/40 bg-warn/10' : 'border-midnight-700 bg-midnight-900/60'}`} aria-live="polite">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 font-semibold text-white">{past ? `${t('party.passed')} ${fmtDuration(left)} ${t('party.ago')}` : `${t('party.in')} ${fmtDuration(left)}`}</div>
      <div className="text-xs text-slate-500">{fmtTime(to)}</div>
    </div>
  );
}

/** Irreversible-action confirmation (FR-ATTEST-04 and every fund-moving circuit). */
export function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm, children }: { title: string; body: ReactNode; confirmLabel: string; onCancel: () => void; onConfirm: () => void; children?: ReactNode }) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="cd-title" className="card w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 id="cd-title" className="text-base font-semibold text-white">{title}</h2>
        <div className="text-sm text-slate-300">{body}</div>
        {children}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel} autoFocus>
            {t('keys.replaceCancel')}
          </button>
          <button type="button" className="btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
