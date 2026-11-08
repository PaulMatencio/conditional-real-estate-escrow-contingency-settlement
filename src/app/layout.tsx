import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/presentation/providers/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Real-estate escrow — Midnight DApp', template: '%s · Real-estate escrow' },
  description: 'Conditional real-estate escrow with contingency settlement on Midnight (preview network): shielded custody, zero-knowledge role authentication, Lace and 1AM wallets.',
  applicationName: 'Real-estate escrow',
  keywords: ['Midnight', 'Compact', 'real estate', 'escrow', 'zero-knowledge', 'DApp'],
  robots: { index: true, follow: true }
};

export const viewport: Viewport = { themeColor: '#070812', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent-strong focus:px-3 focus:py-2">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
