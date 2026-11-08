import type { Config } from 'tailwindcss';

/** Midnight theme tokens. Surfaces are CSS variables (see globals.css) so light and dark share one set of classes. */
const v = (name: string) => `rgb(var(--m-${name}) / <alpha-value>)`;
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        midnight: { 950: v('950'), 900: v('900'), 850: v('850'), 800: v('800'), 700: v('700'), 600: v('600'), 500: v('500') },
        accent: { DEFAULT: '#7c83ff', soft: 'rgb(var(--accent-soft) / <alpha-value>)', strong: '#5a62f0' },
        ok: 'rgb(var(--ok) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        bad: 'rgb(var(--bad) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Inter', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      boxShadow: { glow: '0 0 0 1px rgba(124,131,255,.25), 0 8px 30px -12px rgba(90,98,240,.45)' }
    }
  },
  plugins: []
};
export default config;
