import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  setResolved: (resolved: ResolvedTheme) => void;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'dark',
      resolved: 'dark',
      setMode: (mode) => {
        const resolved = mode === 'system' ? getSystemTheme() : mode;
        set({ mode, resolved });
      },
      setResolved: (resolved) => set({ resolved }),
    }),
    {
      name: 'atlas-theme',
      partialize: (state) => ({ mode: state.mode }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Recompute resolved after rehydration
          const resolved = state.mode === 'system' ? getSystemTheme() : state.mode;
          state.setResolved(resolved);
        }
      },
    }
  )
);
