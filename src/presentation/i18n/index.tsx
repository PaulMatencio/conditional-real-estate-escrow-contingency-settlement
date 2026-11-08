'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { es } from './es';
import { fr } from './fr';

export type Locale = 'en' | 'fr' | 'es';
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'es', label: 'Español' }
];
/** Missing keys fall back to English, so a locale can be filled in incrementally. */
const dictionaries: Record<Locale, Partial<Record<MessageKey, string>>> = { en, fr, es };

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: MessageKey) => string;
}
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('locale') as Locale | null;
      const nav = navigator.language.slice(0, 2) as Locale;
      setLocaleState(saved && saved in dictionaries ? saved : nav in dictionaries ? nav : 'en');
    } catch {
      /* storage blocked */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('locale', l);
    } catch {
      /* storage blocked */
    }
  }, []);
  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (k) => dictionaries[locale][k] ?? en[k] }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): I18n {
  const c = useContext(Ctx);
  if (!c) throw new Error('useT must be used inside <I18nProvider>');
  return c;
}
export type { MessageKey };
