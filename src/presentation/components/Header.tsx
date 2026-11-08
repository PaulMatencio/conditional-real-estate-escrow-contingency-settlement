'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Home, Moon, ShieldCheck, Sun, Wallet, X } from 'lucide-react';
import { KNOWN_WALLETS } from '@/infrastructure/wallet/connector';
import { shortHex } from '@/domain/hex';
import { useApp } from '../providers/AppProvider';
import { LOCALES, useT, type Locale } from '../i18n';
import { Badge, Spinner } from './ui';
import { DustBadge } from './DustCard';

function WalletModal({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { wallets, connectWallet, connector, rescanWallets } = useApp();
  const connecting = connector.status === 'connecting';
  useEffect(() => {
    void rescanWallets(); // extensions can inject late
  }, [rescanWallets]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={t('wallet.choose')}>
      <div className="card w-full max-w-md">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('wallet.choose')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="btn-ghost !p-1.5">
            <X size={16} />
          </button>
        </div>
        <ul className="space-y-2">
          {KNOWN_WALLETS.map((k) => {
            const found = wallets.find((w) => w.known === k.id);
            return (
              <li key={k.id} className="flex items-center gap-3 rounded-xl border border-midnight-700 bg-midnight-900/60 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {found?.icon ? <img src={found.icon} alt="" className="h-8 w-8 rounded" /> : <Wallet className="text-slate-500" />}
                <div className="flex-1">
                  <div className="font-medium text-white">{k.label}</div>
                  <div className="text-xs text-slate-400">{found ? t('wallet.detected') : t('wallet.notInstalled')}</div>
                </div>
                {found ? (
                  <button type="button" className="btn-primary" disabled={connecting} onClick={async () => (await connectWallet(found.key), onClose())}>
                    {connecting ? <Spinner /> : t('wallet.connect')}
                  </button>
                ) : (
                  <a className="btn-ghost" href={k.installUrl} target="_blank" rel="noopener noreferrer">
                    {t('wallet.install')}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        {wallets.length === 0 && <p className="mt-3 text-sm text-slate-400">{t('wallet.notFound')}</p>}
      </div>
    </div>,
    document.body
  );
}

function useTheme() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('theme');
      const next = saved ? saved === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches;
      setLight(next);
      document.documentElement.classList.toggle('light', next);
    } catch {
      /* storage blocked */
    }
  }, []);
  return {
    light,
    toggle: () => {
      const next = !light;
      setLight(next);
      document.documentElement.classList.toggle('light', next);
      try {
        localStorage.setItem('theme', next ? 'light' : 'dark');
      } catch {
        /* storage blocked */
      }
    }
  };
}

/** Sticky top navigation: brand, role pages, language, theme, wallet. */
export function Header() {
  const { t, locale, setLocale } = useT();
  const { connector, disconnectWallet } = useApp();
  const [picker, setPicker] = useState(false);
  const { light, toggle } = useTheme();
  const session = connector.status === 'connected' ? connector.session : null;

  return (
    <header className="sticky top-0 z-40 border-b border-midnight-700 bg-midnight-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold text-white">
          <ShieldCheck className="text-accent" aria-hidden />
          <span>{t('app.name')}</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm" aria-label="Primary">
          <Link href="/" className="btn-ghost !px-2.5 !py-1.5">
            <Home size={14} aria-hidden /> {t('nav.home')}
          </Link>
          <Link href="/admin" className="btn-ghost !px-2.5 !py-1.5">
            {t('nav.admin')}
          </Link>
          <details className="relative">
            <summary className="btn-ghost cursor-pointer list-none !px-2.5 !py-1.5">{t('nav.parties')}</summary>
            <div className="absolute left-0 z-50 mt-1 grid min-w-44 gap-1 rounded-xl border border-midnight-700 bg-midnight-900 p-2 shadow-glow">
              {(['buyer', 'seller', 'inspector', 'lender', 'title-agent', 'resolver'] as const).map((s) => (
                <Link key={s} href={`/${s}`} className="rounded-lg px-2 py-1 hover:bg-midnight-800">
                  {t(`nav.${s}`)}
                </Link>
              ))}
            </div>
          </details>
          <Link href="/compliance" className="btn-ghost !px-2.5 !py-1.5">
            {t('nav.compliance')}
          </Link>
          <Link href="/verify" className="btn-ghost !px-2.5 !py-1.5">
            {t('nav.notary')}
          </Link>
          <Link href="/role-id" className="btn-ghost !px-2.5 !py-1.5">
            {t('nav.roleId')}
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <select aria-label={t('common.language')} className="input !w-auto !py-1.5" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn-ghost !p-2" onClick={toggle} aria-label={t('common.theme')}>
            {light ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          {session ? (
            <>
              <Badge tone="ok">{session.wallet.name}</Badge>
              <DustBadge />
              <span className="mono hidden sm:inline" title={session.networkId}>
                {shortHex(session.unshieldedAddress ?? session.networkId, 10, 6)}
              </span>
              <button type="button" className="btn-ghost" onClick={disconnectWallet}>
                {t('wallet.disconnect')}
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={() => setPicker(true)}>
              <Wallet size={16} aria-hidden /> {t('wallet.connect')}
            </button>
          )}
        </div>
      </div>
      {picker && <WalletModal onClose={() => setPicker(false)} />}
    </header>
  );
}
