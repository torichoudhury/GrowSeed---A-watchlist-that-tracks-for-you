"use client";

import { useEffect } from 'react';
import { useStoredValue, writeStored } from '@/lib/browser-store';

type Theme = 'dark' | 'light';

const isTheme = (raw: string): raw is Theme => raw === 'dark' || raw === 'light';

/** Dark by default (see layout.tsx's pre-paint bootstrap); the choice sticks
 * per browser and follows along in other tabs. Purely presentational —
 * nothing else reads it. */
export function ThemeToggle() {
  const theme = useStoredValue<Theme>('theme', 'dark', isTheme);

  // The <html> attribute is an external system, so syncing it here is exactly
  // what an effect is for. The inline bootstrap already set it before paint;
  // this keeps it true after a toggle or a change in another tab.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <button
      onClick={() => writeStored('theme', theme === 'dark' ? 'light' : 'dark')}
      className="h-8 w-8 grid place-items-center rounded-full text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
    >
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
