'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Info } from 'lucide-react';
import { useT } from '../i18n';

/**
 * Info tooltip: a small (i) button next to a label. Opens on hover, keyboard focus or tap; Escape closes it.
 * Rendered in a portal with fixed positioning so cards (backdrop-blur) neither clip it nor paint over it.
 */
export function Tip({ text }: { text?: string }) {
  const { t } = useT();
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 8, window.innerWidth - 296)) });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  if (!text) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={t('common.moreInfo')}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full align-middle text-slate-500 hover:text-accent-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Info size={14} aria-hidden />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
            className="pointer-events-none fixed z-[60] w-72 rounded-lg border border-midnight-600 bg-midnight-900 px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-200 shadow-lg"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}

export function Card({ title, icon, children, className = '', actions, tip }: { title?: string; icon?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; tip?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <h2 className="card-title">
          {icon}
          <span className="flex flex-1 items-center gap-1">
            {title}
            <Tip text={tip} />
          </span>
          {actions}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children, hint, htmlFor, tip }: { label: string; children: ReactNode; hint?: string; htmlFor?: string; tip?: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1">
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
        <Tip text={tip} />
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Badge({ tone = 'accent', children }: { tone?: 'accent' | 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  const tones = {
    accent: 'border-accent/40 bg-accent/10 text-accent-soft',
    ok: 'border-ok/40 bg-ok/10 text-ok',
    warn: 'border-warn/40 bg-warn/10 text-warn',
    bad: 'border-bad/40 bg-bad/10 text-bad',
    muted: 'border-midnight-600 bg-midnight-800 text-slate-400'
  } as const;
  return <span className={`badge ${tones[tone]}`}>{children}</span>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost !px-2 !py-1 text-xs"
      aria-label={label ?? t('common.copy')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      <span className="sr-only sm:not-sr-only">{done ? t('common.copied') : t('common.copy')}</span>
    </button>
  );
}

export function Mono({ value, copy = true }: { value: string; copy?: boolean }) {
  return (
    <span className="flex items-start gap-2">
      <span className="mono flex-1 text-slate-300">{value}</span>
      {copy && <CopyButton value={value} />}
    </span>
  );
}

export function Alert({ tone, children, onClose }: { tone: 'bad' | 'ok' | 'warn'; children: ReactNode; onClose?: () => void }) {
  const tones = { bad: 'border-bad/40 bg-bad/10 text-bad', ok: 'border-ok/40 bg-ok/10 text-ok', warn: 'border-warn/40 bg-warn/10 text-warn' };
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      <div className="flex-1 break-words">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />;
}

export function Stat({ label, value, sub, tip }: { label: string; value: ReactNode; sub?: ReactNode; tip?: string }) {
  return (
    <div className="rounded-xl border border-midnight-700 bg-midnight-900/60 p-3">
      <div className="flex items-center gap-1 text-xs text-slate-400">
        {label}
        <Tip text={tip} />
      </div>
      <div className="mt-1 break-words text-lg font-semibold text-white">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
