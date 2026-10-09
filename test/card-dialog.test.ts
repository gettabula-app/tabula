import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Store } from '../src/store';
import { addCard, cardsToStickies, newKanban } from '../src/containers';
import { createLabel, listLabels } from '../src/labels';
import { openCardDialog } from '../src/ui/card-dialog';
import { openLabelsDialog } from '../src/ui/labels-dialog';
import type { BaseObj, Id, Label } from '../src/types';
import { FakeElement, FakeEvent, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/kanban.md, slice 3: the card dialog and the Labels dialog, rendered into the fake DOM (test/fake-dom.ts) over a
// real store. Fields save as they are left; commenters read; stored strings reach the page as text and values only.

const EVIL = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
const EVIL_COLOR = 'red;background:url(https://evil.example/x)';

let browser: FakeBrowser;
let keyListeners: ((e: unknown) => void)[];
beforeEach(() => {
  browser = installFakeBrowser();
  keyListeners = [];
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, innerWidth: 1024, innerHeight: 800,
    addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') keyListeners.push(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { keyListeners = keyListeners.filter((f) => f !== fn); },
  });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
});
afterEach(() => browser.uninstall());

type Role = 'editor' | 'commenter' | 'viewer';

function setup(role: Role = 'editor') {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const card = addCard(store, lanes[1].id, 'Fix the login loop', { createdBy: 'me' })!;
  const bug = createLabel(store, 'Bug', 'pink')!;
  const ui = createLabel(store, 'Frontend', 'teal')!;
  store.undo.clear();
  if (role !== 'editor') store.setReadOnly(true);
  const roleNow = { value: role };
  const listeners = new Map<string, Set<() => void>>();
  const commentListeners = new Set<(v: boolean) => void>();
  const app = {
    store,
    get readOnly() { return store.readOnly; },
    comments: { readOnly: () => roleNow.value === 'viewer', onReadOnly: (fn: (v: boolean) => void) => { commentListeners.add(fn); return () => commentListeners.delete(fn); } },
    canOpenCard: () => !store.readOnly || roleNow.value === 'commenter',
    on: (ev: string, fn: () => void) => { const set = listeners.get(ev) ?? new Set(); set.add(fn); listeners.set(ev, set); return () => set.delete(fn); },
    /** What the board does when this person's role changes. */
    becomes(next: Role) {
      roleNow.value = next;
      store.setReadOnly(next !== 'editor');
      listeners.get('readonly')?.forEach((fn) => fn());
    },
    user: { id: 'me', name: 'Visual QA', color: '#326DD3' },
    participants: () => [{ clientId: 2, isMe: false, user: { id: 'u2', name: 'Marta Ruiz', color: '#D3332D' } }],
    notify: vi.fn<(m: string) => void>(),
    openLabels: vi.fn<() => void>(),
    commentOnCard: vi.fn<(id: Id) => boolean>(),
    turnIntoStickies: vi.fn<(ids: Id[]) => boolean>(),
    setSelection: vi.fn<(ids: Id[]) => void>(),
    deleteSelection: vi.fn<() => void>(),
  };
  return { store, app, card, bug, ui, lanes: lanes.map((l) => l.id) };
}

const open = (app: unknown, id: Id, focus?: 'owner' | 'due' | 'labels') => openCardDialog(app as BoardApp, id, focus);
const box = () => browser.document.body.querySelector('[role="dialog"]') as FakeElement | null;
const byLabel = (label: string) => box()!.querySelectorAll('input, textarea, select').find((e) => e.getAttribute('aria-label') === label)!;
const button = (name: string) => box()!.querySelectorAll('button').find((b) => textOf(b) === name || b.getAttribute('aria-label') === name);
/** Types a value and leaves the field, as a person does: input, then change. */
function change(el: FakeElement, value: string) {
  el.value = value;
  el.dispatchEvent(new FakeEvent('input'));
  el.dispatchEvent(new FakeEvent('change'));
}
const bo = (store: Store, id: Id) => store.get(id) as BaseObj;
const steps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;

/** Every element under `root` (for checking that nothing a person wrote became markup). */
function all(root: FakeElement): FakeElement[] {
  return [root, ...root.querySelectorAll('*')];
}

describe('the card dialog, for an editor', () => {
  it('shows the card and saves each field as it is left, one undo step each', () => {
    const { store, app, card, bug } = setup();
    open(app, card);
    expect(textOf(box()!.querySelector('h2'))).toBe('Card in Doing');
    expect(byLabel('Title').value).toBe('Fix the login loop');
    change(byLabel('Title'), 'Fix the Safari login loop');
    change(byLabel('Description'), 'Steps:\n1. Open Safari 17');
    change(byLabel('Due date'), '2026-01-16');
    change(byLabel('Owner'), 'id:u2');
    button('Bug')!.click();
    expect(bo(store, card)).toMatchObject({ text: 'Fix the Safari login loop', desc: 'Steps:\n1. Open Safari 17', due: '2026-01-16', ownerId: 'u2', ownerName: 'Marta Ruiz', labels: [bug] });
    expect(steps(store)).toBe(5);
    expect(button('Bug')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers me, the people here and those already named, plus a free-text owner', () => {
    const { store, app, card } = setup();
    open(app, card);
    const owner = byLabel('Owner');
    expect(owner.querySelectorAll('option').map((o) => textOf(o))).toEqual(['No owner', 'Visual QA (you)', 'Marta Ruiz', 'Someone else…']);
    change(owner, '__other');
    const name = byLabel('Owner\'s name');
    expect(name.hidden).toBe(false);
    change(name, 'Lea Brandt');
    expect(bo(store, card)).toMatchObject({ ownerName: 'Lea Brandt' });
    expect(bo(store, card).ownerId).toBeUndefined();
    change(byLabel('Owner'), '');
    expect(bo(store, card).ownerName).toBeUndefined();
  });

  it('puts back what the store has when a field is refused', () => {
    const { store, app, card } = setup();
    open(app, card);
    change(byLabel('Title'), '   ');
    expect(bo(store, card).text).toBe('Fix the login loop');
    expect(byLabel('Title').value).toBe('Fix the login loop');
  });

  it('follows changes made elsewhere, and closes when the card is gone or turned into a sticky', () => {
    const { store, app, card } = setup();
    open(app, card);
    store.transact(() => store.update(card, { desc: 'Written by someone else' }));
    expect(byLabel('Description').value).toBe('Written by someone else');
    cardsToStickies(store, [card], () => undefined);
    expect(box()).toBeNull();
  });

  it('keeps its keys: Delete on a focused button does not reach the board', () => {
    const { app, card } = setup();
    open(app, card);
    const board = vi.fn<() => void>();
    browser.document.body.addEventListener('keydown', board);
    const e = new FakeEvent('keydown');
    Object.assign(e, { key: 'Delete' });
    button('Turn into sticky')!.dispatchEvent(e);
    expect(board).not.toHaveBeenCalled();
    const tab = new FakeEvent('keydown');
    Object.assign(tab, { key: 'Tab' });
    button('Turn into sticky')!.dispatchEvent(tab);
    expect(board).toHaveBeenCalledTimes(1);
  });

  it('has Comment, Turn into sticky and Delete, each closing the dialog first', () => {
    const { app, card } = setup();
    open(app, card);
    button('Comment')!.click();
    expect(box()).toBeNull();
    expect(app.commentOnCard).toHaveBeenCalledWith(card);
    open(app, card);
    button('Turn into sticky')!.click();
    expect(app.turnIntoStickies).toHaveBeenCalledWith([card]);
    open(app, card);
    button('Delete')!.click();
    expect(app.setSelection).toHaveBeenCalledWith([card]);
    expect(app.deleteSelection).toHaveBeenCalled();
    open(app, card);
    button('Edit labels')!.click();
    expect(app.openLabels).toHaveBeenCalled();
  });
});

describe('the card dialog, against changes made elsewhere', () => {
  it('a field only focused writes nothing on close, so a rename made meanwhile stays', () => {
    const { store, app, card } = setup();
    const d = open(app, card)!;
    byLabel('Title').focus();
    byLabel('Description').focus();
    store.transact(() => store.update(card, { text: 'Renamed elsewhere', desc: 'Described elsewhere' }));
    d.close();
    expect(bo(store, card)).toMatchObject({ text: 'Renamed elsewhere', desc: 'Described elsewhere' });
  });

  it('what was typed into a focused field is saved on close', () => {
    const { store, app, card } = setup();
    const d = open(app, card)!;
    const t = byLabel('Title');
    t.focus();
    t.value = 'Typed, not left';
    t.dispatchEvent(new FakeEvent('input'));
    d.close();
    expect(bo(store, card).text).toBe('Typed, not left');
  });

  it('an owner the list no longer offers does nothing, and never clears the owner', () => {
    const { store, app, card } = setup();
    store.transact(() => store.update(card, { ownerId: 'u2', ownerName: 'Marta Ruiz' }));
    open(app, card);
    const owner = byLabel('Owner');
    owner.value = 'id:gone';
    owner.dispatchEvent(new FakeEvent('change'));
    expect(bo(store, card)).toMatchObject({ ownerId: 'u2', ownerName: 'Marta Ruiz' });
    expect(owner.value).toBe('id:u2');
  });

  it('lets undo and redo through to the board, and keeps other keys', () => {
    const { app, card } = setup();
    open(app, card);
    const board = vi.fn<() => void>();
    browser.document.body.addEventListener('keydown', board);
    for (const [key, mod] of [['z', 'metaKey'], ['Z', 'ctrlKey'], ['y', 'ctrlKey']]) {
      const e = new FakeEvent('keydown');
      Object.assign(e, { key, [mod]: true });
      button('Comment')!.dispatchEvent(e);
    }
    expect(board).toHaveBeenCalledTimes(3);
  });

  it('marks chosen labels with a check as well as the colours', () => {
    const { app, card, bug } = setup();
    open(app, card);
    expect(button('Bug')!.querySelector('.k-chip-check')).toBeNull();
    button('Bug')!.click();
    const chip = box()!.querySelectorAll('button').find((b) => b.dataset.label === bug)!;
    expect(chip.querySelector('.k-chip-check')).not.toBeNull();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('a role that changes while the dialog is open', () => {
  it('an editor made a commenter: it opens again read-only', async () => {
    const { app, card } = setup();
    open(app, card);
    app.becomes('commenter');
    await Promise.resolve();
    expect(byLabel('Title').readOnly).toBe(true);
    expect(button('Delete')).toBeUndefined();
    expect(browser.document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('a commenter made an editor: it opens again editable', async () => {
    const { store, app, card } = setup('commenter');
    open(app, card);
    app.becomes('editor');
    await Promise.resolve();
    expect(byLabel('Title').readOnly).toBe(false);
    change(byLabel('Title'), 'Now I can');
    expect(bo(store, card).text).toBe('Now I can');
  });

  it('made a viewer: it closes and says why', () => {
    const { app, card } = setup();
    open(app, card);
    app.becomes('viewer');
    expect(box()).toBeNull();
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('access'));
  });
});

describe('the card dialog, by role', () => {
  it('is read-only for commenters, who keep the comment button', () => {
    const { store, app, card } = setup('commenter');
    open(app, card);
    expect(byLabel('Title').readOnly).toBe(true);
    expect(byLabel('Description').readOnly).toBe(true);
    expect(byLabel('Owner').disabled).toBe(true);
    expect(byLabel('Due date').disabled).toBe(true);
    expect(button('Comment')).toBeTruthy();
    expect(button('Turn into sticky')).toBeUndefined();
    expect(button('Delete')).toBeUndefined();
    expect(button('Edit labels')).toBeUndefined();
    expect(textOf(box()!)).toContain('Only editors can change it');
    // even a change event that gets through writes nothing
    change(byLabel('Title'), 'Changed');
    expect(bo(store, card).text).toBe('Fix the login loop');
  });

  it('does not open for viewers', () => {
    const { app, card } = setup('viewer');
    expect(open(app, card)).toBeNull();
    expect(box()).toBeNull();
  });
});

describe('stored strings in the dialogs are text', () => {
  it('a title, description, owner and label name with markup in them are values and text, never markup', () => {
    const { store, app, card } = setup();
    const evil = createLabel(store, EVIL.slice(0, 40), EVIL_COLOR)!;
    store.transact(() => store.update(card, { text: EVIL, desc: EVIL, ownerName: EVIL, labels: [evil] }));
    // another client writes a label with a colour that is not one
    store.transact(() => store.labels.set('raw', { id: 'raw', name: EVIL.slice(0, 40), color: EVIL_COLOR, order: 9 } as Label));
    open(app, card);
    expect(byLabel('Title').value).toBe(EVIL);
    expect(byLabel('Description').value).toBe(EVIL);
    expect(textOf(byLabel('Owner'))).toContain(EVIL);
    expect(textOf(box()!)).toContain(EVIL.slice(0, 40).toString());
    for (const el of all(box()!)) {
      expect(el.tagName).not.toBe('IMG');
      expect(el.tagName).not.toBe('SCRIPT');
      expect(el.innerHTML).not.toContain('onerror');
      for (const v of Object.values(el.style)) expect(String(v)).not.toContain('evil');
    }
    // the chips' colours are swatches of palette keys only
    const swatches = box()!.querySelectorAll('.k-chip-swatch').map((s) => s.style['--c']);
    expect(swatches.every((c) => c === undefined || /^var\(--s-[a-z]+, #[0-9A-F]{6}\)$/.test(c))).toBe(true);
  });

  it('the Labels dialog shows names as input values and never takes a colour that is not one', () => {
    const { store, app } = setup();
    store.transact(() => store.labels.set('raw', { id: 'raw', name: EVIL.slice(0, 40), color: EVIL_COLOR, order: 9 } as Label));
    openLabelsDialog(app as unknown as BoardApp);
    const inputs = box()!.querySelectorAll('input');
    expect(inputs.some((i) => i.value === EVIL.slice(0, 40))).toBe(true);
    for (const el of all(box()!)) {
      expect(el.tagName).not.toBe('IMG');
      expect(el.innerHTML).not.toContain('onerror');
      for (const v of Object.values(el.style)) expect(String(v)).not.toContain('evil');
    }
  });
});

describe('the Labels dialog', () => {
  it('creates, renames, recolours, reorders and deletes', async () => {
    const { store, app, bug, ui } = setup();
    openLabelsDialog(app as unknown as BoardApp);
    const name = box()!.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'New label name')!;
    name.value = 'Docs';
    box()!.querySelectorAll('button').find((b) => textOf(b) === 'Add')!.click();
    expect(listLabels(store).map((l) => l.name)).toEqual(['Bug', 'Frontend', 'Docs']);
    change(box()!.querySelectorAll('input').find((i) => i.dataset.label === bug)!, 'Defect');
    box()!.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Move Frontend up')!.click();
    // one button per label opens the eight colours, each with its name
    box()!.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Colour of Frontend: Teal')!.click();
    const colours = browser.document.body.querySelector('.k-colour-pop')!;
    expect(colours.querySelectorAll('[role="radio"]').map((b) => textOf(b))).toEqual(['Yellow', 'Orange', 'Pink', 'Violet', 'Blue', 'Teal', 'Green', 'Grey']);
    colours.querySelectorAll('[role="radio"]').find((b) => textOf(b) === 'Violet')!.click();
    expect(browser.document.body.querySelector('.k-colour-pop')).toBeNull();
    box()!.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Delete Docs')!.click();
    expect(listLabels(store).map((l) => `${l.name}:${l.color}`)).toEqual(['Frontend:violet', 'Defect:pink']);
    expect(listLabels(store)[0].id).toBe(ui);
    expect(textOf(box()!)).toContain('2 of 30 labels');
    // the colour list arms its outside-click listener on a timer: let it run while the fake window is there
    await new Promise((r) => setTimeout(r, 0));
  });

  it('lets undo through to the board, so a deleted label can come back', () => {
    const { app } = setup();
    openLabelsDialog(app as unknown as BoardApp);
    const board = vi.fn<() => void>();
    browser.document.body.addEventListener('keydown', board);
    const e = new FakeEvent('keydown');
    Object.assign(e, { key: 'z', metaKey: true });
    const inside = box()!.querySelector('.k-colour-btn')!;
    inside.dispatchEvent(e);
    const del = new FakeEvent('keydown');
    Object.assign(del, { key: 'Delete' });
    inside.dispatchEvent(del);
    expect(board).toHaveBeenCalledTimes(1);
  });

  it('closes when the board turns read-only', () => {
    const { app } = setup();
    openLabelsDialog(app as unknown as BoardApp);
    app.becomes('commenter');
    expect(box()).toBeNull();
    expect(app.notify).toHaveBeenCalled();
  });

  it('is for editors only', () => {
    const { app } = setup('commenter');
    expect(openLabelsDialog(app as unknown as BoardApp)).toBeNull();
  });
});
