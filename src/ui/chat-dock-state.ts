/**
 * The chat dock's state machine and what is remembered about it. The dock lives in the app's overlay layer, so it is the same
 * dock on a board, the Boards page and the tracker. Pure: no DOM.
 */
export type DockMode = 'open' | 'compact' | 'bubble' | 'closed';
export type DockSize = 'open' | 'compact';
export type DockEvent = 'open' | 'compact' | 'expand' | 'minimise' | 'close' | 'toggle';

export interface DockPrefs {
  mode: DockMode;
  /** The size the dock comes back in from a bubble or from closed. */
  size: DockSize;
  /** The channel last shown, as `kind/ref`; null before the first one. */
  channel: string | null;
}

export const DEFAULT_DOCK: DockPrefs = { mode: 'closed', size: 'open', channel: null };

const MODES: readonly DockMode[] = ['open', 'compact', 'bubble', 'closed'];
const SIZES: readonly DockSize[] = ['open', 'compact'];

/** One key per person on this device, so a shared computer does not carry one person's dock to another. */
export const dockKey = (userId: string) => `driftboard:chat-dock:${userId}`;

/** What stored text says; anything wrong in it is the default, field by field. */
export function parseDock(raw: string | null): DockPrefs {
  if (!raw) return { ...DEFAULT_DOCK };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_DOCK };
  }
  if (!value || typeof value !== 'object') return { ...DEFAULT_DOCK };
  const v = value as Record<string, unknown>;
  const size = SIZES.includes(v.size as DockSize) ? (v.size as DockSize) : DEFAULT_DOCK.size;
  const mode = MODES.includes(v.mode as DockMode) ? (v.mode as DockMode) : DEFAULT_DOCK.mode;
  const channel = typeof v.channel === 'string' && /^[a-z]{1,16}\/[A-Za-z0-9_-]{1,64}$/.test(v.channel) ? v.channel : null;
  return { mode: mode === 'open' || mode === 'compact' ? size : mode, size, channel };
}

export function loadDock(userId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): DockPrefs {
  try {
    return parseDock(storage?.getItem(dockKey(userId)) ?? null);
  } catch {
    return { ...DEFAULT_DOCK };
  }
}

/** Remembers the dock; a blocked or full storage means it simply starts closed next time. */
export function saveDock(userId: string, prefs: DockPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(dockKey(userId), JSON.stringify(prefs));
  } catch {
    /* storage is unavailable */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The next state. `open` and `compact` show the dock in that size; `expand` is the full size; `minimise` leaves a bubble;
 * `close` hides it everywhere but the entry points; `toggle` is the Chat link and the M key: it closes a shown dock and shows a
 * hidden or minimised one in the size it had.
 */
export function nextDock(prefs: DockPrefs, event: DockEvent): DockPrefs {
  const shown = prefs.mode === 'open' || prefs.mode === 'compact';
  switch (event) {
    case 'open': return { ...prefs, mode: prefs.size };
    case 'compact': return { ...prefs, mode: 'compact', size: 'compact' };
    case 'expand': return { ...prefs, mode: 'open', size: 'open' };
    case 'minimise': return shown ? { ...prefs, mode: 'bubble' } : prefs;
    case 'close': return { ...prefs, mode: 'closed' };
    case 'toggle': return shown ? { ...prefs, mode: 'closed' } : { ...prefs, mode: prefs.size };
  }
}

/** Under this width the dock overlays the board (the phone sheet takes over there); above it the board's chrome makes room. */
export const DOCK_OVERLAY_BELOW = 900;
const DOCK_GAP = 12;
export const DOCK_WIDTH: Record<DockSize, number> = { open: 360, compact: 300 };

/**
 * How far the dock reaches in from the right edge, in px: the chrome that sits at the right or centred (zoom tray, quickbar,
 * session bar, poll card, AI bar, notices) leaves this much room, and "zoom to fit" fits the board into what is left.
 * Nothing when the dock is closed or a bubble, and nothing under 900 px where it overlays.
 */
export function dockInset(mode: DockMode, viewportWidth: number): number {
  if ((mode !== 'open' && mode !== 'compact') || viewportWidth < DOCK_OVERLAY_BELOW) return 0;
  return DOCK_WIDTH[mode] + DOCK_GAP;
}
