/**
 * The shared tooltip, logic only: when it shows and hides, how it joins a warm group, what it says and where it sits.
 * It has no DOM; src/ui/tooltip.ts feeds it pointer and focus events and draws what it decides.
 */

/** How long the pointer rests on a target before the first tooltip opens. Keyboard focus opens it at once. */
export const SHOW_DELAY = 400;
/** After a tooltip closes, the next target of the same group still opens at once for this long (a warm group). */
export const COOL_DELAY = 400;
/** Space between target and tooltip, and the least space kept to the edge of the viewport. */
export const TIP_GAP = 6;
export const TIP_MARGIN = 8;

export interface TipTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: TipTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TipHost<T> {
  /** Open the tooltip for `target`, replacing the one that is open. */
  show(target: T): void;
  hide(): void;
}

export interface TipOptions<T> {
  timers?: TipTimers;
  showDelay?: number;
  coolDelay?: number;
  /** A target that fails this (taken out of the page, nothing to say) never opens a tooltip. */
  live?: (target: T) => boolean;
  /** The group a target belongs to, such as the left rail or the top bar. Warm hops stay inside one group. Default: one group for all. */
  group?: (target: T) => unknown;
}

export interface TipController<T> {
  /** The pointer came onto a target: open after the delay, or at once when it is in the warm group of the last tooltip. */
  enter(target: T): void;
  /** Keyboard focus arrived on a target: open at once. */
  focus(target: T): void;
  /**
   * The pointer left, or focus left, a target. `next` is the group the pointer moved onto, with null for outside every group;
   * when it is not the target's group the warm hop ends at once. Omitted (focus, or no group option): nothing changes.
   */
  leave(target: T, next?: unknown): void;
  /** Click, scroll, resize: close and stay closed until the pointer leaves the target and comes back. */
  dismiss(): boolean;
  /** Escape closes the tooltip; returns whether there was one to close. Other keys do nothing. */
  key(key: string): boolean;
  current(): T | null;
  dispose(): void;
}

export function createTipController<T>(host: TipHost<T>, opts: TipOptions<T> = {}): TipController<T> {
  const timers = opts.timers ?? realTimers;
  const showDelay = opts.showDelay ?? SHOW_DELAY;
  const coolDelay = opts.coolDelay ?? COOL_DELAY;
  const live = opts.live ?? (() => true);
  const groupOf = opts.group ?? (() => undefined);
  let shown: T | null = null;
  let pending: { target: T; timer: unknown } | null = null;
  let coolTimer: unknown = null;
  let warm = false;
  // The group of the target last opened: only a target of this group can open at once while warm.
  let warmGroup: unknown = undefined;
  // Closed by a click, scroll or Escape while still on its target: nothing reopens until the target is left.
  let dismissed: T | null = null;

  const cancelPending = () => {
    if (pending) timers.clear(pending.timer);
    pending = null;
  };
  const cancelCool = () => {
    if (coolTimer !== null) timers.clear(coolTimer);
    coolTimer = null;
  };
  const open = (target: T) => {
    cancelPending();
    cancelCool();
    if (!live(target)) return;
    warm = true;
    warmGroup = groupOf(target);
    shown = target;
    host.show(target);
  };
  const close = (keepWarm: boolean) => {
    cancelPending();
    const was = shown !== null;
    if (was) {
      shown = null;
      host.hide();
    }
    if (!keepWarm) {
      cancelCool();
      warm = false;
    } else if (was) {
      cancelCool();
      coolTimer = timers.set(() => {
        coolTimer = null;
        warm = false;
      }, coolDelay);
    }
  };
  const leave = (target: T, next?: unknown) => {
    if (dismissed === target) dismissed = null;
    if (pending?.target === target) cancelPending();
    // Only with a group option does a move onto another group (or outside every group) end the warm hop at once.
    const leftGroup = opts.group !== undefined && next !== undefined && next !== groupOf(target);
    if (shown === target) close(!leftGroup);
    else if (shown === null && leftGroup) close(false);
  };
  const dismiss = () => {
    const target = shown ?? pending?.target ?? null;
    if (target === null) return false;
    dismissed = target;
    close(false);
    return true;
  };

  return {
    enter(target) {
      if (target === dismissed) return;
      dismissed = null;
      if (target === shown || pending?.target === target) return;
      cancelPending();
      // Another group ends the warm hop, and a tooltip still shown for the old group closes first.
      const sameGroup = groupOf(target) === warmGroup;
      if (!sameGroup) close(false);
      if (sameGroup && (shown !== null || warm)) {
        open(target);
        return;
      }
      pending = { target, timer: timers.set(() => open(target), showDelay) };
    },
    focus(target) {
      if (target === dismissed) return;
      dismissed = null;
      if (target !== shown) open(target);
    },
    leave,
    dismiss,
    key: (key) => (key === 'Escape' || key === 'Esc') && dismiss(),
    current: () => shown,
    dispose() {
      cancelPending();
      cancelCool();
      shown = null;
      warm = false;
      dismissed = null;
    },
  };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TipPlacement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

/**
 * Above the target when there is room, else below, centred on the target and shifted sideways to stay `margin` from the
 * viewport edges. When neither side has room it takes the roomier one: the tooltip may be cut off but never covers the target.
 */
export function placeTip(
  target: Box, tip: Size, view: Size, gap = TIP_GAP, margin = TIP_MARGIN,
  safe: { top?: number; right?: number; bottom?: number; left?: number } = {},
): TipPlacement {
  const leftLimit = margin + (safe.left ?? 0);
  const rightLimit = view.width - margin - (safe.right ?? 0);
  const topLimit = margin + (safe.top ?? 0);
  const bottomLimit = view.height - margin - (safe.bottom ?? 0);
  const roomAbove = target.top - gap - topLimit;
  const roomBelow = bottomLimit - (target.top + target.height + gap);
  const above = roomAbove >= tip.height || (roomBelow < tip.height && roomAbove >= roomBelow);
  const y = above ? target.top - gap - tip.height : target.top + target.height + gap;
  const top = above
    ? (topLimit + tip.height <= target.top - gap ? Math.max(topLimit, y) : y)
    : (bottomLimit - tip.height >= target.top + target.height + gap ? Math.min(bottomLimit - tip.height, y) : y);
  const centred = target.left + target.width / 2 - tip.width / 2;
  const left = Math.max(leftLimit, Math.min(centred, rightLimit - tip.width));
  return { left, top, side: above ? 'above' : 'below' };
}

export interface TipContent {
  label: string;
  /** The shortcut as the shortcuts dialog writes it, for the key chip. */
  keys?: string;
}

/** What a target says: its data-tip (or, for icon buttons without one, its aria-label) and its shortcut, if it has one. */
export function tipContent(
  src: { tip: string | null; ariaLabel: string | null; keyId: string | null; keys?: string | null },
  keysOf: (id: string) => string | undefined,
): TipContent | null {
  const label = (src.tip ?? src.ariaLabel ?? '').trim();
  if (!label) return null;
  const keys = src.keys?.trim() || (src.keyId ? keysOf(src.keyId) : undefined);
  return keys ? { label, keys } : { label };
}

/** Adds `token` to a space-separated attribute value such as aria-describedby. */
export function addToken(list: string | null, token: string): string {
  const tokens = (list ?? '').split(/\s+/).filter(Boolean);
  return tokens.includes(token) ? tokens.join(' ') : [...tokens, token].join(' ');
}

/** Removes `token`; null when nothing is left, so the caller can drop the attribute. */
export function removeToken(list: string | null, token: string): string | null {
  const tokens = (list ?? '').split(/\s+/).filter((t) => t && t !== token);
  return tokens.length ? tokens.join(' ') : null;
}
