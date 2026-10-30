import { create } from 'zustand';

export type SettingsTab = 'agents' | 'mcp' | 'connectors' | 'dev' | 'repos';
export type Theme = 'light' | 'dark';

const THEME_KEY = 'ops-console-theme';

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

type UiState = {
  settingsTab: SettingsTab | null;
  theme: Theme;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  toggleTheme: () => void;
};

export const useUi = create<UiState>((set, get) => ({
  settingsTab: null,
  theme: initialTheme(),
  openSettings: (tab = 'agents') => set({ settingsTab: tab }),
  closeSettings: () => set({ settingsTab: null }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
}));
