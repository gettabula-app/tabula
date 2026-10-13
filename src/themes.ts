export const THEME_VARS = ['--canvas','--paper','--ink','--graphite','--rule','--signal','--on-signal','--canvas-signal','--on-canvas-signal','--wire','--selection-handle-fill','--selection-handle-stroke','--danger','--on-danger','--tray','--tray-2','--tray-line','--tray-text','--tray-muted','--tray-hover','--grid-dot','--grid-line','--grid-major','--canvas-ink','--canvas-rule','--guide','--shade','--scrim'] as const;
export type ThemeVar = (typeof THEME_VARS)[number];

export interface Theme {
  id: string;
  name: string;
  scheme: 'light' | 'dark';
  trayScheme: 'light' | 'dark';
  vars: Record<ThemeVar, string>;
}

export interface ThemeRoot {
  style: { setProperty(k: string, v: string): void; removeProperty(k: string): string | void };
  dataset: Record<string, string | undefined>;
}

// --scrim: the veil behind modal dialogs. Light themes darken the page (ink at 42%). The dark themes deliberately LIGHTEN it (white at 10 to 12%): black
// disappears on their near-black canvases, so a pale wash is what makes the dialog layer read as raised (tech lead re-review, 13 Oct 2026).
export const THEMES: Theme[] = [
  {
    id: 'default',
    name: 'Default',
    scheme: 'light',
    trayScheme: 'light',
    vars: {
      '--canvas': '#F7F6F3',
      '--paper': '#FFFFFF',
      '--ink': '#111111',
      '--graphite': '#65635F',
      '--rule': '#EAEAEA',
      '--signal': '#111111',
      '--on-signal': '#FFFFFF',
      '--canvas-signal': '#FFD23F',
      '--on-canvas-signal': '#18212B',
      '--wire': '#2A64D6',
      '--selection-handle-fill': '#FFFFFF',
      '--selection-handle-stroke': '#2A64D6',
      '--danger': '#D41E24',
      '--on-danger': '#FFFFFF',
      '--tray': '#FFFFFF',
      '--tray-2': '#F7F6F3',
      '--tray-line': 'rgba(17, 17, 17, 0.08)',
      '--tray-text': '#111111',
      '--tray-muted': '#65635F',
      '--tray-hover': 'rgba(17, 17, 17, 0.05)',
      '--grid-dot': '#D4D2CC',
      '--grid-line': '#ECEBE7',
      '--grid-major': '#DDDBD5',
      '--canvas-ink': '#111111',
      '--canvas-rule': '#D9D8D4',
      '--guide': '#D6247F',
      '--shade': '#000000',
      '--scrim': 'rgba(17, 17, 17, 0.42)',
    },
  },
  {
    id: 'ayu',
    name: 'Ayu',
    scheme: 'dark',
    trayScheme: 'dark',
    vars: {
      '--canvas': '#1F2430',
      '--paper': '#272D38',
      '--ink': '#CCCAC2',
      '--graphite': '#8F969D',
      '--rule': '#3D4455',
      '--signal': '#FFCC66',
      '--on-signal': '#1F2430',
      '--canvas-signal': '#FFCC66',
      '--on-canvas-signal': '#1F2430',
      '--wire': '#73D0FF',
      '--selection-handle-fill': '#272D38',
      '--selection-handle-stroke': '#73D0FF',
      '--danger': '#F28779',
      '--on-danger': '#1F2430',
      '--tray': '#171B24',
      '--tray-2': '#232834',
      '--tray-line': 'rgba(204, 202, 194, 0.12)',
      '--tray-text': '#CCCAC2',
      '--tray-muted': '#8A9199',
      '--tray-hover': 'rgba(204, 202, 194, 0.08)',
      '--grid-dot': '#3A4150',
      '--grid-line': '#2A3040',
      '--grid-major': '#3A4150',
      '--canvas-ink': '#CCCAC2',
      '--canvas-rule': '#3D4455',
      '--guide': '#FF7EB6',
      '--shade': '#000000',
      '--scrim': 'rgba(255, 255, 255, 0.10)',
    },
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    scheme: 'dark',
    trayScheme: 'dark',
    vars: {
      '--canvas': '#1F1F28',
      '--paper': '#2A2A37',
      '--ink': '#DCD7BA',
      '--graphite': '#A6A69C',
      '--rule': '#363646',
      '--signal': '#E6C384',
      '--on-signal': '#1F1F28',
      '--canvas-signal': '#E6C384',
      '--on-canvas-signal': '#1F1F28',
      '--wire': '#7E9CD8',
      '--selection-handle-fill': '#2A2A37',
      '--selection-handle-stroke': '#7E9CD8',
      '--danger': '#E56E7B',
      '--on-danger': '#1F1F28',
      '--tray': '#16161D',
      '--tray-2': '#2A2A37',
      '--tray-line': 'rgba(220, 215, 186, 0.12)',
      '--tray-text': '#DCD7BA',
      '--tray-muted': '#9C9A8A',
      '--tray-hover': 'rgba(220, 215, 186, 0.08)',
      '--grid-dot': '#3A3A4A',
      '--grid-line': '#2A2A37',
      '--grid-major': '#3A3A4A',
      '--canvas-ink': '#DCD7BA',
      '--canvas-rule': '#54546D',
      '--guide': '#FF5D8F',
      '--shade': '#000000',
      '--scrim': 'rgba(255, 255, 255, 0.10)',
    },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    scheme: 'dark',
    trayScheme: 'dark',
    vars: {
      '--canvas': '#050A06',
      '--paper': '#0B140C',
      '--ink': '#3DFF70',
      '--graphite': '#1FA84A',
      '--rule': '#14501F',
      '--signal': '#00FF41',
      '--on-signal': '#021004',
      '--canvas-signal': '#00FF41',
      '--on-canvas-signal': '#021004',
      '--wire': '#22D3EE',
      '--selection-handle-fill': '#0B140C',
      '--selection-handle-stroke': '#22D3EE',
      '--danger': '#FF4D4D',
      '--on-danger': '#021004',
      '--tray': '#0A120B',
      '--tray-2': '#102014',
      '--tray-line': 'rgba(61, 255, 112, 0.16)',
      '--tray-text': '#8CFFA8',
      '--tray-muted': '#3FBF62',
      '--tray-hover': 'rgba(61, 255, 112, 0.1)',
      '--grid-dot': '#0F3A1A',
      '--grid-line': '#0B2412',
      '--grid-major': '#124B22',
      '--canvas-ink': '#3DFF70',
      '--canvas-rule': '#14501F',
      '--guide': '#FF4FA3',
      '--shade': '#000000',
      '--scrim': 'rgba(255, 255, 255, 0.12)',
    },
  },
  {
    id: 'evergreen',
    name: 'Evergreen',
    scheme: 'light',
    trayScheme: 'dark',
    vars: {
      '--canvas': '#EEF3EC',
      '--paper': '#FFFFFF',
      '--ink': '#14301F',
      '--graphite': '#4F6B5A',
      '--rule': '#CBD9CE',
      '--signal': '#E0B040',
      '--on-signal': '#14301F',
      '--canvas-signal': '#E0B040',
      '--on-canvas-signal': '#14301F',
      '--wire': '#1E6FD9',
      '--selection-handle-fill': '#FFFFFF',
      '--selection-handle-stroke': '#1E6FD9',
      '--danger': '#C14036',
      '--on-danger': '#FFFFFF',
      '--tray': '#0F2A1D',
      '--tray-2': '#1B3F2C',
      '--tray-line': 'rgba(226, 240, 228, 0.14)',
      '--tray-text': '#E6F2E8',
      '--tray-muted': '#9DB8A5',
      '--tray-hover': 'rgba(226, 240, 228, 0.09)',
      '--grid-dot': '#A9BDAE',
      '--grid-line': '#D8E3DB',
      '--grid-major': '#BCCDC1',
      '--canvas-ink': '#14301F',
      '--canvas-rule': '#CBD9CE',
      '--guide': '#D6247F',
      '--shade': '#000000',
      '--scrim': 'rgba(17, 17, 17, 0.42)',
    },
  },
];

export const DEFAULT_THEME = 'default';

const STORAGE_KEY = 'driftboard:theme';
const listeners = new Set<(id: string) => void>();

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function getStoredTheme(): string {
  try {
    return themeById(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: string, root: ThemeRoot = document.documentElement): void {
  const theme = themeById(id);
  for (const v of THEME_VARS) {
    if (theme.id === DEFAULT_THEME) root.style.removeProperty(v);
    else root.style.setProperty(v, theme.vars[v]);
  }
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  root.dataset.trayScheme = theme.trayScheme;
  root.style.setProperty('color-scheme', theme.scheme);
}

export function setTheme(id: string): void {
  const theme = themeById(id);
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // Storage is unavailable (private window, blocked site data); the theme still applies.
  }
  applyTheme(theme.id);
  for (const fn of listeners) fn(theme.id);
}

export function onThemeChange(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
