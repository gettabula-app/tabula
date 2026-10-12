import { vi } from 'vitest';
import type { ChatChannelEntry } from '../src/api';
import type { DockDeps } from '../src/ui/chat-dock';
import type { ConversationOptions } from '../src/ui/chat';

/** A stand-in for the chat store and the conversation, for the tests of the dock. */
export function stubDeps(entries: ChatChannelEntry[] = []) {
  const unread = new Map<string, { unread: number; mentions: number }>();
  const badgeListeners = new Set<() => void>();
  const mounts: { opts: ConversationOptions; conv: { setOpen: ReturnType<typeof vi.fn>; focusComposer: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } }[] = [];
  const opened: { kind: string; ref: string; signal: AbortSignal }[] = [];
  const watches: AbortSignal[] = [];
  let listed = entries;
  let unlisted = false;
  const deps = {
    fetchChannels: vi.fn<() => Promise<ChatChannelEntry[]>>(async () => listed),
    openChat: vi.fn<(kind: string, ref: string, signal: AbortSignal) => never>((kind, ref, signal) => { opened.push({ kind, ref, signal }); return {} as never; }),
    unread: (kind: string, ref: string) => unread.get(`${kind}/${ref}`) ?? { unread: 0, mentions: 0 },
    totalUnread: () => [...unread.values()].reduce((t, v) => ({ unread: t.unread + v.unread, mentions: t.mentions + v.mentions }), { unread: 0, mentions: 0 }),
    onBadge: (fn: () => void) => { badgeListeners.add(fn); return () => badgeListeners.delete(fn); },
    hasUnlisted: () => unlisted,
    watch: (signal: AbortSignal) => { watches.push(signal); },
    navigate: vi.fn<(hash: string) => void>(),
    mount: (opts: ConversationOptions) => {
      const conv = { setOpen: vi.fn<(open: boolean) => void>(), focusComposer: vi.fn<() => void>(), refresh: vi.fn<() => void>() };
      mounts.push({ opts, conv });
      return conv as never;
    },
  } as unknown as DockDeps;
  return {
    deps, mounts, opened, watches,
    setUnread: (kind: string, ref: string, value: { unread: number; mentions: number }) => { unread.set(`${kind}/${ref}`, value); badgeListeners.forEach((fn) => fn()); },
    setEntries: (next: ChatChannelEntry[]) => { listed = next; },
    setUnlisted: (v: boolean) => { unlisted = v; },
  };
}

export const entry = (over: Partial<ChatChannelEntry> & Pick<ChatChannelEntry, 'kind' | 'ref' | 'name'>): ChatChannelEntry => ({
  write: true, unread: 0, mentions: 0, lastId: 0, lastAt: null, ...over,
});
