import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import { closeContainerSheet, openContainerSheet, openSheetFor } from '../src/ui/container-sheet';
import { EMPTY_FILTER } from '../src/ui/kanban-logic';
import { activeLane, moveChoices, moveToIndex, rowDropIndex, sheetRights, sheetSummary, sheetTabs } from '../src/ui/sheet-logic';
import type { BaseObj, Id } from '../src/types';
import { FakeEvent, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// docs/kanban.md, slice 5: the list sheet (lane tabs, card rows, Move to…, the Add card bar), pure and in the fake DOM.

describe('sheet logic', () => {
  it('gives each role what the spec says', () => {
    expect(sheetRights(false, false)).toEqual({ edit: true, open: true });
    // a commenter: the board is read-only, the comments are not
    expect(sheetRights(true, false)).toEqual({ edit: false, open: true });
    // a viewer reads and filters
    expect(sheetRights(true, true)).toEqual({ edit: false, open: false });
  });

  it('counts lanes as the headers do, with a limit as n / limit and over it marked', () => {
    const tabs = sheetTabs([{ id: 'a', name: 'To do' }, { id: 'b', name: 'Doing', wip: 2 }, { id: 'c', name: '  ', wip: 1, wipMode: 'block' }], (id) => ({ a: 1, b: 3, c: 1 })[id]!);
    expect(tabs.map((t) => [t.name, t.count.text, t.count.state, t.count.block])).toEqual([
      ['To do', '1', '', false], ['Doing', '3 / 2', 'over', false], ['Lane', '1 / 1', 'at', true],
    ]);
    expect(tabs[0].label).toBe('To do, 1 card');
    expect(tabs[1].label).toBe('Doing, 3 of 2 cards, over the limit');
  });

  it('keeps the active lane while it is there, else the first', () => {
    expect(activeLane(['a', 'b'], 'b')).toBe('b');
    expect(activeLane(['a', 'b'], 'gone')).toBe('a');
    expect(activeLane([], 'a')).toBeNull();
  });

  it('marks the current lane and disables a lane that refuses the card', () => {
    const c = moveChoices([{ id: 'a', name: 'To do' }, { id: 'b', name: 'Doing', wip: 2, wipMode: 'block' }, { id: 'c', name: 'Done' }], 'a', () => 2, (id) => (id === 'b' ? 'Doing is full: 2 of 2' : null));
    expect(c.map((x) => [x.id, x.end, x.current, x.disabled])).toEqual([['a', 'Current', true, false], ['b', 'Full', false, true], ['c', '2', false, false]]);
    expect(c[1].reason).toBe('Doing is full: 2 of 2');
  });

  it('puts a card at the top or after the others', () => {
    expect(moveToIndex(['x', 'y', 'z'], 'y', 'top')).toBe(0);
    expect(moveToIndex(['x', 'y', 'z'], 'y', 'bottom')).toBe(2);
    expect(moveToIndex(['x', 'y'], 'n', 'bottom')).toBe(2);
  });

  it('drops a dragged row before the first row whose middle is below the pointer', () => {
    expect(rowDropIndex([10, 30, 50], 5)).toBe(0);
    expect(rowDropIndex([10, 30, 50], 31)).toBe(2);
    expect(rowDropIndex([10, 30, 50], 99)).toBe(3);
    expect(sheetSummary(1, 1)).toBe('1 lane · 1 card');
    expect(sheetSummary(4, 9)).toBe('4 lanes · 9 cards');
  });
});

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('window', { setTimeout, clearTimeout, innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(async () => {
  closeContainerSheet();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  browser.uninstall();
});

type Role = 'editor' | 'commenter' | 'viewer';

function setup(role: Role = 'editor') {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const [todo, doing, done] = lanes.map((l) => l.id);
  const cards = ['A', 'B', 'C'].map((t) => addCard(store, todo, t, { createdBy: 'me' })!);
  store.undo.clear();
  const listeners = new Map<string, Set<() => void>>();
  const commentListeners = new Set<(v: boolean) => void>();
  const comments = { ro: role === 'viewer' };
  if (role !== 'editor') store.setReadOnly(true);
  const app = {
    store,
    get readOnly() { return store.readOnly; },
    user: { id: 'me', name: 'Me' },
    comments: { readOnly: () => comments.ro, onReadOnly: (fn: (v: boolean) => void) => { commentListeners.add(fn); return () => commentListeners.delete(fn); } },
    on: (ev: string, fn: () => void) => { const set = listeners.get(ev) ?? new Set(); set.add(fn); listeners.set(ev, set); return () => set.delete(fn); },
    emit: (ev: string) => listeners.get(ev)?.forEach((fn) => fn()),
    announce: vi.fn<(msg: string) => void>(),
    notify: vi.fn<(msg: string) => void>(),
    openCardDialog: vi.fn<(id: Id) => boolean>(() => true),
    turnIntoStickies: vi.fn<(ids: Id[]) => boolean>(() => true),
    isDimmed: () => false,
    kanbanFilter: () => EMPTY_FILTER,
    openKanbanMenu: vi.fn<(kind: string, id: Id, at: unknown) => void>(),
    r: { commentCount: () => 0 },
  };
  return { store, app, comments, commentListeners, container: container.id, todo, doing, done, cards };
}

const open = (s: ReturnType<typeof setup>, lane?: Id) => openContainerSheet(s.app as unknown as BoardApp, s.container, lane)!;
const sheet = () => browser.document.body.querySelector('.ks-sheet') as FakeElement | null;
const rowsText = () => sheet()!.querySelectorAll('.ks-row .ks-row-title').map((el) => textOf(el));
const button = (root: FakeElement, label: string | RegExp) => root.querySelectorAll('button').find((b) => (typeof label === 'string' ? textOf(b) === label || b.getAttribute('aria-label') === label : label.test(textOf(b))))!;
const titles = (s: ReturnType<typeof setup>, lane: Id) => (s.store.containerLayout(s.container)!.cards.get(lane) ?? []).map((id) => (s.store.get(id) as BaseObj).text);
const moveSheet = () => browser.document.body.querySelector('.ks-bsheet') as FakeElement | null;
const key = (el: FakeElement, k: string, alt = false) => {
  const e = new FakeEvent('keydown');
  Object.assign(e, { key: k, altKey: alt, ctrlKey: false, metaKey: false, shiftKey: false });
  el.dispatchEvent(e);
};

describe('the list sheet', () => {
  it('shows the lanes as tabs with counts and the first lane\'s cards as rows', () => {
    const s = setup();
    open(s);
    expect(openSheetFor()).toBe(s.container);
    expect(textOf(sheet()!.querySelector('.ks-head')!)).toContain('3 lanes · 3 cards');
    const tabs = sheet()!.querySelectorAll('[role="tab"]');
    expect(tabs.map((t) => textOf(t))).toEqual(['To do3', 'Doing0', 'Done0']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(rowsText()).toEqual(['A', 'B', 'C']);
  });

  it('opens on the lane asked for, and shows its empty state', () => {
    const s = setup();
    open(s, s.doing);
    expect(textOf(sheet()!.querySelector('.ks-rows')!)).toBe('No cards in this lane');
    expect(textOf(button(sheet()!, /^Add card to Doing/))).toBe('Add card to Doing');
  });

  it('marks a lane over its limit with the danger chip', () => {
    const s = setup();
    s.store.transact(() => s.store.update(s.todo, { wip: 2 }));
    open(s);
    const n = sheet()!.querySelectorAll('[role="tab"]')[0].querySelector('.ks-n')!;
    expect(textOf(n)).toBe('3 / 2');
    expect(n.classList.contains('over')).toBe(true);
  });

  it('gives an editor the grip, the row menu and the Add card bar', () => {
    const s = setup('editor');
    open(s);
    expect(sheet()!.querySelectorAll('[data-grip]')).toHaveLength(3);
    expect(sheet()!.querySelectorAll('.ks-more-btn')).toHaveLength(3);
    expect(sheet()!.querySelector('.ks-add')!.hidden).toBe(false);
  });

  it('gives a commenter rows that open the card read-only, and nothing that writes', () => {
    const s = setup('commenter');
    open(s);
    expect(sheet()!.querySelectorAll('[data-grip]')).toHaveLength(0);
    expect(sheet()!.querySelectorAll('.ks-more-btn')).toHaveLength(0);
    expect(sheet()!.querySelector('.ks-add')!.hidden).toBe(true);
    (sheet()!.querySelector('button.ks-row-title') as FakeElement).click();
    expect(s.app.openCardDialog).toHaveBeenCalledWith(s.cards[0]);
  });

  it('gives a viewer the rows and the filter only', () => {
    const s = setup('viewer');
    open(s);
    expect(sheet()!.querySelectorAll('button.ks-row-title')).toHaveLength(0);
    expect(sheet()!.querySelectorAll('.ks-more-btn')).toHaveLength(0);
    expect(sheet()!.querySelector('.ks-add')!.hidden).toBe(true);
    expect(rowsText()).toEqual(['A', 'B', 'C']);
    button(sheet()!, 'Filter cards').click();
    expect(s.app.openKanbanMenu).toHaveBeenCalledWith('filter', s.container, expect.anything());
  });

  it('follows a role change while it is open', () => {
    const s = setup('editor');
    open(s);
    s.store.setReadOnly(true);
    s.app.emit('readonly');
    expect(sheet()!.querySelector('.ks-add')!.hidden).toBe(true);
    expect(sheet()!.querySelectorAll('.ks-more-btn')).toHaveLength(0);
  });

  it('switches lanes with the tabs and the arrow keys', () => {
    const s = setup();
    addCard(s.store, s.doing, 'D', { createdBy: 'me' });
    open(s);
    key(sheet()!.querySelectorAll('[role="tab"]')[0], 'ArrowRight');
    expect(rowsText()).toEqual(['D']);
    expect(sheet()!.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected')).toBe('true');
  });

  it('moves a card with Alt+arrows, announced, one undo step each', () => {
    const s = setup();
    open(s);
    key(sheet()!.querySelectorAll('button.ks-row-title')[0], 'ArrowDown', true);
    expect(titles(s, s.todo)).toEqual(['B', 'A', 'C']);
    expect(s.app.announce).toHaveBeenLastCalledWith('Moved to To do, position 2 of 3');
    // to the next lane: the sheet follows the card
    key(sheet()!.querySelectorAll('button.ks-row-title')[1], 'ArrowRight', true);
    expect(titles(s, s.doing)).toEqual(['A']);
    expect(rowsText()).toEqual(['A']);
    s.store.undo.undo();
    expect(titles(s, s.todo)).toEqual(['B', 'A', 'C']);
  });

  it('closes when its kanban is deleted, and with Escape', () => {
    const s = setup();
    open(s);
    s.store.transact(() => s.store.remove([s.container]));
    expect(sheet()).toBeNull();
    const t = setup();
    open(t);
    key(sheet()!, 'Escape');
    expect(sheet()).toBeNull();
  });
});

describe('Move to…', () => {
  const openMoveTo = (s: ReturnType<typeof setup>, row = 0) => {
    sheet()!.querySelectorAll('.ks-more-btn')[row].click();
    const menu = browser.document.body.querySelector('.k-menu')!;
    button(menu, 'Move to…').click();
    return moveSheet()!;
  };

  it('moves a card to the bottom of another lane in one undo step', () => {
    const s = setup();
    addCard(s.store, s.doing, 'D', { createdBy: 'me' });
    s.store.undo.clear();
    open(s);
    const box = openMoveTo(s, 0);
    const doing = box.querySelectorAll('[role="radio"]').find((r) => r.dataset.lane === s.doing)!;
    doing.click();
    expect(doing.getAttribute('aria-checked')).toBe('true');
    button(box, 'Move').click();
    expect(titles(s, s.doing)).toEqual(['D', 'A']);
    expect(s.app.announce).toHaveBeenLastCalledWith('Moved to Doing, position 2 of 2');
    expect(moveSheet()).toBeNull();
    s.store.undo.undo();
    expect(titles(s, s.todo)).toEqual(['A', 'B', 'C']);
    expect(titles(s, s.doing)).toEqual(['D']);
  });

  it('moves to the top when asked', () => {
    const s = setup();
    addCard(s.store, s.doing, 'D', { createdBy: 'me' });
    open(s);
    const box = openMoveTo(s, 2);
    box.querySelectorAll('[role="radio"]').find((r) => r.dataset.lane === s.doing)!.click();
    button(box, 'Top').click();
    button(box, 'Move').click();
    expect(titles(s, s.doing)).toEqual(['C', 'D']);
  });

  it('disables a full block lane with the reason, and never moves into it', () => {
    const s = setup();
    addCard(s.store, s.doing, 'D', { createdBy: 'me' });
    s.store.transact(() => s.store.update(s.doing, { wip: 1, wipMode: 'block' }));
    open(s);
    const box = openMoveTo(s, 0);
    const full = box.querySelectorAll('[role="radio"]').find((r) => r.dataset.lane === s.doing)!;
    expect(full.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(full)).toContain('Full');
    expect(full.getAttribute('data-tip')).toBe('Doing is full: 1 of 1');
    full.click();
    expect(s.app.notify).toHaveBeenCalledWith('Doing is full: 1 of 1');
    expect(full.getAttribute('aria-checked')).toBe('false');
    // the first lane that takes it is chosen instead (Done)
    button(box, 'Move').click();
    expect(titles(s, s.doing)).toEqual(['D']);
    expect(titles(s, s.done)).toEqual(['A']);
  });

  it('is not offered for a locked card, and a locked card does not move by keys', () => {
    const s = setup();
    s.store.transact(() => s.store.update(s.cards[0], { locked: true }));
    open(s);
    sheet()!.querySelectorAll('.ks-more-btn')[0].click();
    const menu = browser.document.body.querySelector('.k-menu')!;
    expect(button(menu, 'Move to…').disabled).toBe(true);
    expect(button(menu, 'Turn into sticky').disabled).toBe(true);
    expect(sheet()!.querySelectorAll('[data-grip]')).toHaveLength(2);
    key(sheet()!.querySelectorAll('button.ks-row-title')[0], 'ArrowDown', true);
    expect(titles(s, s.todo)).toEqual(['A', 'B', 'C']);
    expect(s.app.notify).toHaveBeenCalledWith('This card is locked. Unlock it to move it.');
  });

  it('closes when the board turns read-only under it', () => {
    const s = setup();
    open(s);
    openMoveTo(s, 0);
    s.store.setReadOnly(true);
    s.app.emit('readonly');
    expect(moveSheet()).toBeNull();
  });
});

describe('the Add card bar', () => {
  it('adds cards to the lane shown, one after another', () => {
    const s = setup();
    open(s, s.doing);
    button(sheet()!, /^Add card to Doing/).click();
    const input = sheet()!.querySelector('.ks-input')!;
    input.value = 'New one';
    key(input, 'Enter');
    expect(titles(s, s.doing)).toEqual(['New one']);
    expect(s.app.announce).toHaveBeenLastCalledWith('Added to Doing: New one');
    // the input stays for the next card
    expect(sheet()!.querySelector('.ks-input')).not.toBeNull();
  });

  it('is refused in a full block lane, and says why', () => {
    const s = setup();
    addCard(s.store, s.doing, 'D', { createdBy: 'me' });
    s.store.transact(() => s.store.update(s.doing, { wip: 1, wipMode: 'block' }));
    open(s, s.doing);
    const add = button(sheet()!, /^Add card to Doing/);
    expect(add.getAttribute('aria-disabled')).toBe('true');
    add.click();
    expect(s.app.notify).toHaveBeenCalledWith('Doing is full: 1 of 1');
    expect(sheet()!.querySelector('.ks-input')).toBeNull();
    expect(titles(s, s.doing)).toEqual(['D']);
  });
});
