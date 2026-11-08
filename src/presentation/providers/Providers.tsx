'use client';
import type { ReactNode } from 'react';
import { Header } from '../components/Header';
import { I18nProvider } from '../i18n';
import { AppProvider } from './AppProvider';
import { EscrowProvider } from './EscrowProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <AppProvider>
        <EscrowProvider>
          <Header />
          {children}
        </EscrowProvider>
      </AppProvider>
    </I18nProvider>
  );
}
