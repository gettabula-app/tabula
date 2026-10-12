import type { ChatChannelEntry } from '../api';
import type { ChannelKind } from './chat-logic';

/** What the dock's channel chips are made of. Pure: no DOM. */
export interface DockChannel {
  /** `kind/ref`, the form the dock remembers. */
  key: string;
  kind: ChannelKind;
  ref: string;
  label: string;
  /** The board that is open: it is the dock's "This board" chip, with the board's own object links. */
  attached: boolean;
}

export const channelKey = (kind: ChannelKind, ref: string): string => `${kind}/${ref}`;

/** Chip order never follows activity: a new message must not make the chips jump under someone's hand. */
const byName = (a: ChatChannelEntry, b: ChatChannelEntry) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref);

/**
 * The channels the dock offers, in a fixed chip order: the board that is open ("This board"), the workspace, the person's teams
 * (live first, then archived, each by name), teams they may read without belonging to, then other boards with recent chat. The open board is
 * listed once even when the server also lists it.
 */
export function dockChannels(entries: readonly ChatChannelEntry[], attachedBoardId: string | null): DockChannel[] {
  const of = (e: ChatChannelEntry): DockChannel => ({ key: channelKey(e.kind, e.ref), kind: e.kind, ref: e.ref, label: e.name, attached: false });
  const out: DockChannel[] = [];
  if (attachedBoardId) out.push({ key: channelKey('board', attachedBoardId), kind: 'board', ref: attachedBoardId, label: 'This board', attached: true });
  out.push(...entries.filter((e) => e.kind === 'workspace').map(of));
  const teams = entries.filter((e) => e.kind === 'team' && e.member !== false);
  out.push(...teams.filter((e) => !e.archived).sort(byName).map(of), ...teams.filter((e) => e.archived).sort(byName).map(of));
  out.push(...entries.filter((e) => e.kind === 'team' && e.member === false).sort(byName).map(of));
  out.push(...entries.filter((e) => e.kind === 'board' && e.ref !== attachedBoardId).sort(byName).map(of));
  return out;
}

/**
 * Which channel the dock opens on, chosen only when it opens: one with a mention, else the one with most unread, else the one last
 * open in this browser, else the open board, else the workspace, else the first. Never used to switch what someone is reading.
 */
export function pickChannel(
  channels: readonly DockChannel[],
  lastOpen: string | null,
  unreadOf: (c: DockChannel) => { unread: number; mentions: number },
): DockChannel | null {
  let best: DockChannel | null = null;
  let score = 0;
  for (const c of channels) {
    const u = unreadOf(c);
    const s = u.mentions * 1_000_000 + u.unread;
    if (s > score) {
      best = c;
      score = s;
    }
  }
  if (best) return best;
  return channels.find((c) => c.key === lastOpen) ?? channels.find((c) => c.attached) ?? channels.find((c) => c.kind === 'workspace') ?? channels[0] ?? null;
}

/** The chips that fit, always including the current channel, and the rest for the "+N" list. */
export function splitChips(channels: readonly DockChannel[], currentKey: string | null, max: number): { visible: DockChannel[]; overflow: DockChannel[] } {
  if (channels.length <= max) return { visible: [...channels], overflow: [] };
  const visible = channels.slice(0, max);
  const current = channels.find((c) => c.key === currentKey);
  if (current && !visible.includes(current) && max > 0) visible[max - 1] = current;
  return { visible, overflow: channels.filter((c) => !visible.includes(c)) };
}

/** "4 here now: Ana, Ben, Visual QA and Sara"; past four names, "and 3 more". Nobody: an empty line. */
export function hereLine(names: readonly string[]): string {
  const n = names.length;
  if (n === 0) return '';
  const shown = names.slice(0, 4);
  const rest = n - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return `${n} here now: ${list}`;
}
