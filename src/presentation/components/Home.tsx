'use client';
import Link from 'next/link';
import { Building, Gavel, Home as HomeIcon, Landmark, Search, ShieldCheck, Stamp, UserCog, UserRound, Wallet } from 'lucide-react';
import { useT, type MessageKey } from '../i18n';

const PAGES = [
  { id: 'admin', icon: UserCog, href: '/admin' },
  { id: 'buyer', icon: Wallet, href: '/buyer' },
  { id: 'seller', icon: HomeIcon, href: '/seller' },
  { id: 'inspector', icon: Search, href: '/inspector' },
  { id: 'lender', icon: Landmark, href: '/lender' },
  { id: 'titleAgent', icon: UserRound, href: '/title-agent' },
  { id: 'resolver', icon: Gavel, href: '/resolver' },
  { id: 'compliance', icon: Building, href: '/compliance' },
  { id: 'notary', icon: Stamp, href: '/verify' }
] as const;

export function Home() {
  const { t } = useT();
  return (
    <main id="main" className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-semibold text-white">
          <ShieldCheck className="text-accent" aria-hidden /> {t('app.name')}
        </h1>
        <p className="mt-1 text-slate-400">{t('app.tagline')}</p>
      </div>
      <section aria-labelledby="roles">
        <h2 id="roles" className="mb-1 text-lg font-semibold text-white">{t('home.title')}</h2>
        <p className="mb-4 text-sm text-slate-400">{t('home.intro')}</p>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PAGES.map(({ id, icon: Icon, href }) => (
            <li key={id}>
              <Link href={href} className="card flex items-start gap-3 transition hover:border-accent/60">
                <Icon className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>
                  <span className="block font-medium text-white">{t(`page.${id}.title` as MessageKey)}</span>
                  <span className="block text-sm text-slate-400">{t(`page.${id}.subtitle` as MessageKey)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
