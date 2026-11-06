import { useEffect } from 'react';
import { useThemeStore } from '../stores/themeStore';

/**
 * Initializes the theme by applying the correct class on <html>
 * and listening for system preference changes.
 * Call once in App.tsx.
 */
export function useThemeInit() {
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setResolved = useThemeStore((s) => s.setResolved);

  // Listen for system preference changes when mode is 'system'
  useEffect(() => {
    if (mode !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setResolved(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode, setResolved]);

  // Apply theme class on <html>
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove('light', 'dark');
    html.classList.add(resolved);
    // Update color-scheme for native form controls
    html.style.colorScheme = resolved;
  }, [resolved]);
}
