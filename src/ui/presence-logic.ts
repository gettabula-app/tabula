// "Here now" on the Boards rows (proto/designer-preview/presence/SPEC.md): who else is on a board, as squares, a count, a
// spoken label and a short text for the phone. Pure; the viewer's own entry is never counted as "someone else".
import { USER_COLORS, personColor } from '../palette';

export interface PresenceUser {
  userId: string;
  name: string;
  /** The person's cursor colour; absent draws the row's ink. */
  colour?: string | null;
  joinedAt: number;
}

/** Squares shown on a row, the viewer's own "You" included. */
export const MAX_SQUARES = 3;

export interface HereSquare {
  name: string;
  initial: string;
  /** One of the eight person colours, or null for the ink fallback. */
  colour: string | null;
}

export interface PresenceView {
  squares: HereSquare[];
  /** The viewer is on the board too (another tab): a "You" square follows the others. */
  you: boolean;
  /** People beyond the squares. */
  more: number;
  /** "Lin and you are here now" */
  label: string;
  /** "Lin, Omar and 2 more": the phone text, without the suffix. */
  names: string;
  /** Everyone else, for the hover list. */
  all: HereSquare[];
}

const nameOf = (u: PresenceUser) => (typeof u.name === 'string' && u.name.trim() ? u.name.trim() : 'Someone');

export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/** A colour from the person palette, or null when there is none to map (the square then takes the ink). */
export function squareColour(colour: unknown): string | null {
  if (typeof colour !== 'string' || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(colour.trim())) return null;
  const mapped = personColor(colour);
  return USER_COLORS.includes(mapped) ? mapped : null;
}

/** "Ben", "Lin and you", "A, B and C", "A, B and 2 more". */
export function spoken(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** Null when nobody else is there: the row then draws nothing (alone on a board is not shown, and neither is "0"). */
export function presenceView(users: readonly PresenceUser[], meId: string | null): PresenceView | null {
  const seen = new Map<string, PresenceUser>();
  for (const u of users) {
    if (!u || typeof u.userId !== 'string') continue;
    const had = seen.get(u.userId);
    if (!had || u.joinedAt < had.joinedAt) seen.set(u.userId, u);
  }
  const you = meId !== null && seen.has(meId);
  const others = [...seen.values()].filter((u) => u.userId !== meId).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!others.length) return null;
  const square = (u: PresenceUser): HereSquare => ({ name: nameOf(u), initial: initialOf(nameOf(u)), colour: squareColour(u.colour) });
  const all = others.map(square);
  const room = you ? MAX_SQUARES - 1 : MAX_SQUARES;
  const squares = all.slice(0, room);
  const names = spoken([...all.map((s) => s.name), ...(you ? ['you'] : [])]);
  const count = all.length + (you ? 1 : 0);
  return { squares, you, more: all.length - squares.length, label: `${names} ${count === 1 ? 'is' : 'are'} here now`, names, all };
}
