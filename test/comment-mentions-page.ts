// The page the comment-mentions browser test loads: the real comment card over a stub board. A module file, so Vite resolves
// the bare `yjs` import (an inline script cannot).

import * as Y from 'yjs';
import { Comments } from '../src/comments';
import { mountComments } from '../src/ui/comments';
import { mountSideTray } from '../src/ui/side-tray';

interface PageGlobals { __app?: unknown; __comments?: unknown; __ready?: boolean }
const page = window as unknown as PageGlobals;

const chrome = document.getElementById('chrome') as HTMLElement;
const comments = new Comments(new Y.Doc());
comments.addThread({ id: 'u-ben', name: 'Ben', color: '#2F6FED' }, { x: 40, y: 40 }, 'Shall we move the header?');

const listeners = new Map<string, Set<() => void>>();
const app = {
  user: { id: 'u-me', name: 'Me', color: '#D64545' },
  role: 'owner',
  comments,
  participants: () => [{ user: { id: 'u-ben', name: 'Ben', color: '#2F6FED' }, clientId: 1, isMe: false }],
  r: { onCamera: () => () => undefined },
  openThreadId: null as string | null,
  onOpenComment: null,
  visibleThreads: () => comments.list(),
  flyToThread: () => undefined,
  openThread(id: string) {
    this.openThreadId = id;
  },
  closeThread() {
    this.openThreadId = null;
  },
  setDraftPin: () => undefined,
  on(name: string, listener: () => void) {
    const set = listeners.get(name) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(name, set);
    return () => set.delete(listener);
  },
};

mountComments(app as unknown as Parameters<typeof mountComments>[0], chrome, mountSideTray(chrome));
page.__app = app;
page.__comments = comments;
page.__ready = true;
