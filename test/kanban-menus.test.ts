import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Store } from '../src/store';
import { newKanban } from '../src/containers';
import { openContainerMenu, openFilterPopover, openLaneMenu } from '../src/ui/kanban-menus';
import { EMPTY_FILTER, type KanbanFilter } from '../src/ui/kanban-logic';
import type { Id } from '../src/types';
import { FakeEvent, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/kanban.md, slice 4: the lane and kanban menus and the Filter popover in the fake DOM (test/fake-dom.ts).

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('window', { setTimeout, clearTimeout, innerWidth: 1024, innerHeight: 800, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
});
afterEach(async () => {
  // the popover arms its outside-click listener on the next tick: let that run while the fake window is still here
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  browser.uninstall();
});

function setup() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const listeners = new Map<string, Set<() => void>>();
  let filter: KanbanFilter = EMPTY_FILTER;
  const app = {
    store,
    get readOnly() { return store.readOnly; },
    on: (ev: string, fn: () => void) => { const set = listeners.get(ev) ?? new Set(); set.add(fn); listeners.set(ev, set); return () => set.delete(fn); },
    emit: (ev: string) => listeners.get(ev)?.forEach((fn) => fn()),
    setKanbanMenuOpen: vi.fn<(open: unknown) => void>(),
    renameKanbanPart: vi.fn<() => void>(), moveLaneFromMenu: vi.fn<() => void>(), deleteLane: vi.fn<() => void>(), editLaneFromMenu: vi.fn<() => void>(), addLaneTo: vi.fn<() => void>(), toggleKanbanLock: vi.fn<() => void>(), deleteKanban: vi.fn<() => void>(),
    kanbanFilter: () => filter,
    setKanbanFilter: vi.fn<(id: Id, f: KanbanFilter) => void>((_: Id, f: KanbanFilter) => { filter = f; listeners.get('filter')?.forEach((fn) => fn()); }),
    filterCounts: vi.fn<() => { matching: number; total: number }>(() => ({ matching: 1, total: 3 })),
  };
  return { store, app, container: container.id, lanes: lanes.map((l) => l.id) };
}

const at = { x: 100, y: 100, w: 28, h: 28 };
const menu = () => browser.document.body.querySelector('.k-menu') as FakeElement | null;
const items = () => menu()!.querySelectorAll('button').map((b) => textOf(b));

describe('the lane menu', () => {
  it.each(['transparent', 'none', 'red;background:url(https://evil.example/x)', '"><script>alert(1)</script>', ''])('opens with a lane fill of %j, the colour reading None', (fill) => {
    const { store, app, lanes } = setup();
    store.transact(() => store.update(lanes[1], { fill }));
    expect(() => openLaneMenu(app as unknown as BoardApp, lanes[1], at)).not.toThrow();
    const colour = menu()!.querySelectorAll('button').find((b) => textOf(b).startsWith('Colour'))!;
    expect(textOf(colour)).toContain('None');
    expect(textOf(menu()!)).not.toContain('script');
  });

  it('names a palette colour', () => {
    const { store, app, lanes } = setup();
    store.transact(() => store.update(lanes[1], { fill: 'teal' }));
    openLaneMenu(app as unknown as BoardApp, lanes[1], at);
    expect(items().find((t) => t.startsWith('Colour'))).toContain('Teal');
  });

  it('closes when this person stops being an editor, and the kanban menu too', () => {
    const { store, app, lanes, container } = setup();
    openLaneMenu(app as unknown as BoardApp, lanes[0], at);
    expect(menu()).not.toBeNull();
    store.setReadOnly(true);
    app.emit('readonly');
    expect(menu()).toBeNull();
    store.setReadOnly(false);
    openContainerMenu(app as unknown as BoardApp, container, at);
    expect(menu()).not.toBeNull();
    store.setReadOnly(true);
    app.emit('readonly');
    expect(menu()).toBeNull();
  });

  it('the Filter popover stays open for a viewer', () => {
    const { store, app, container } = setup();
    openFilterPopover(app as unknown as BoardApp, container, at);
    store.setReadOnly(true);
    app.emit('readonly');
    expect(menu()).not.toBeNull();
  });
});

describe('the Filter popover', () => {
  it('waits for a pause in typing before it filters, and keeps what was typed on close', () => {
    vi.useFakeTimers();
    const { app, container } = setup();
    openFilterPopover(app as unknown as BoardApp, container, at);
    const input = menu()!.querySelector('input') as FakeElement & { value: string };
    for (const v of ['l', 'lo', 'log']) {
      input.value = v;
      input.dispatchEvent(new FakeEvent('input'));
    }
    expect(app.setKanbanFilter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    expect(app.setKanbanFilter).toHaveBeenCalledTimes(1);
    expect(app.kanbanFilter().text).toBe('log');
  });
});
