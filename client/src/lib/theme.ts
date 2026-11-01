// client/src/lib/theme.ts — light/dark toggle. AppKit styles read a .dark or .light class on <html>
// and fall back to prefers-color-scheme when neither is set.
import { useCallback, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Set the <html> class; called before the first render so the page never flashes the wrong theme. */
export function applyTheme(theme: Theme = initialTheme()): Theme {
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(theme);
  return theme;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}
