import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'ops-console-theme';
const COLLAPSED_KEY = 'ops-console-sidebar-collapsed';

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type UiState = {
  theme: Theme;
  /** The sidebar shows icons only. */
  collapsed: boolean;
  toggleTheme: () => void;
  toggleCollapsed: () => void;
};

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme(),
  collapsed: localStorage.getItem(COLLAPSED_KEY) === 'true',
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
  toggleCollapsed: () => {
    const collapsed = !get().collapsed;
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    set({ collapsed });
  },
}));
