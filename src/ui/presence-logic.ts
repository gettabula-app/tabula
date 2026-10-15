// "Here now" on the Boards rows (proto/designer-preview/presence/SPEC.md): who else is on a board, as squares, a count, a
// spoken label and a short text for the phone. Pure. The server's summary leaves the viewer out and says with `me` whether
// they are on the board too (another tab).
import { USER_COLORS, personColor } from '../palette';
import { initialOf } from '../../shared/initials';

export { initialOf };

export interface PresenceUser {
  userId: string;
  name: string;
  /** The person's cursor colour; absent draws the row's ink. */
  colour?: string | null;
  joinedAt: number;
  guest?: boolean;
}

/** One board's "who else is here" as the server sends it: at most 8 people, oldest first, and the full count. */
export interface PresenceSummary {
  boardId: string;
  count: number;
  people: PresenceUser[];
  /** The viewer has the board open too (any tab). */
  me?: boolean;
}

/** Squares shown on a row, the viewer's own "You" included. */
export const MAX_SQUARES = 3;

export interface HereSquare {
  name: string;
  initial: string;
  /** One of the eight person colours, or null for the ink fallback. */
  colour: string | null;
  guest: boolean;
}

export interface PresenceView {
  squares: HereSquare[];
  /** The viewer is on the board too (another tab): a "You" square follows the others. */
  you: boolean;
  /** People beyond the squares. */
  more: number;
  /** "Lin and you are here now" */
  label: string;
  /** "Lin, Omar and 2 more": the spoken form, without the suffix. */
  names: string;
  /** The phone line: first names, at most two, then "and N more". `head` may be cut to fit; `tail` never is. */
  phone: { head: string; tail: string };
  /** The same with a limit on the names: a row too narrow for two writes one and the count ("Lin and 5 more"). */
  phoneWith: (maxNames: number) => { head: string; tail: string };
  /** The people the server named, for the hover list. */
  all: HereSquare[];
  /** Others the server counted but did not name (it names at most 8): the list ends "and N more". */
  unnamed: number;
}

const nameOf = (u: PresenceUser) => (typeof u.name === 'string' && u.name.trim() ? u.name.trim() : 'Someone');

/** A colour from the person palette, or null when there is none to map (the square then takes the ink). */
export function squareColour(colour: unknown): string | null {
  if (typeof colour !== 'string' || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(colour.trim())) return null;
  const mapped = personColor(colour);
  return USER_COLORS.includes(mapped) ? mapped : null;
}

/** "Ben", "Lin and you", "A, B and C", "A, B and 2 more": `names` as far as they are known, `total` the whole count. */
export function spoken(names: string[], total = names.length): string {
  if (total <= 1) return names[0] ?? '';
  if (total <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} and ${total - 2} more`;
}

/**
 * The phone line (proto/designer-preview/presence/SPEC.md): first names only, at most two, then "and N more" ("Lin", "Lin and Omar",
 * "Lin, Omar and 1 more"). Two people who share a first name are both written in full. The tail is its own part so a narrow row cuts
 * the names and never the count.
 */
export function phoneNames(names: string[], total: number, maxNames = 2): { head: string; tail: string } {
  const first = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const firsts = names.map(first);
  const written = names.map((n, i) => (firsts.filter((f) => f.toLowerCase() === firsts[i].toLowerCase()).length > 1 ? n.trim() : firsts[i]));
  if (total <= 1) return { head: written[0] ?? '', tail: '' };
  if (maxNames <= 1) return { head: written[0] ?? '', tail: ` and ${total - 1} more` };
  if (total === 2) return { head: written.slice(0, 2).join(' and '), tail: '' };
  return { head: written.slice(0, 2).join(', '), tail: ` and ${total - 2} more` };
}

/** Null when nobody else is there: the row then draws nothing (alone on a board is not shown, and neither is "0"). */
export function presenceView(summary: Pick<PresenceSummary, 'count' | 'people' | 'me'> | null | undefined): PresenceView | null {
  if (!summary) return null;
  const seen = new Map<string, PresenceUser>();
  for (const u of Array.isArray(summary.people) ? summary.people : []) {
    if (!u || typeof u.userId !== 'string') continue;
    const had = seen.get(u.userId);
    if (!had || u.joinedAt < had.joinedAt) seen.set(u.userId, u);
  }
  const people = [...seen.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const total = Math.max(people.length, Number.isFinite(summary.count) ? Math.floor(summary.count) : 0);
  if (!total) return null;
  const you = summary.me === true;
  const square = (u: PresenceUser): HereSquare => ({ name: nameOf(u), initial: initialOf(nameOf(u)), colour: squareColour(u.colour), guest: u.guest === true });
  const all = people.map(square);
  const squares = all.slice(0, you ? MAX_SQUARES - 1 : MAX_SQUARES);
  const everyone = total + (you ? 1 : 0);
  const names = spoken([...all.map((x) => x.name), ...(you ? ['you'] : [])], everyone);
  const spokenNames = [...all.map((x) => x.name), ...(you ? ['you'] : [])];
  const phoneWith = (maxNames: number) => phoneNames(spokenNames, everyone, maxNames);
  return { squares, you, more: total - squares.length, label: `${names} ${everyone === 1 ? 'is' : 'are'} here now`, names, phone: phoneWith(2), phoneWith, all, unnamed: total - all.length };
}
