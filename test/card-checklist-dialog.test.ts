import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import { openCardDialog } from '../src/ui/card-dialog';
import type { BaseObj, ChecklistItem, Id } from '../src/types';
import { FakeElement, FakeEvent, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// TAB-372: the checklist section of the card dialog, rendered into the fake DOM over a real store. Every change is one card
// patch (one undo step); the rules are those of src/checklist.ts.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, innerWidth: 1024, innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
});
afterEach(() => browser.uninstall());

function setup() {
  const store = new Store(new Y.Doc());
  const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
  const card = addCard(store, lanes[1].id, 'Pack for the trip', { createdBy: 'me' })!;
  store.undo.clear();
  const app = {
    store,
    get readOnly() { return store.readOnly; },
    comments: { readOnly: () => false, onReadOnly: () => () => undefined },
    canOpenCard: () => true,
    on: () => () => undefined,
    user: { id: 'me', name: 'Visual QA', color: '#326DD3' },
    participants: () => [],
    notify: vi.fn<(m: string) => void>(),
    announce: vi.fn<(m: string) => void>(),
    openLabels: vi.fn<() => void>(),
    commentOnCard: vi.fn<(id: Id) => boolean>(),
    turnIntoStickies: vi.fn<(ids: Id[]) => boolean>(),
    setSelection: vi.fn<(ids: Id[]) => void>(),
    deleteSelection: vi.fn<() => void>(),
  };
  return { store, app, card, laneId: lanes[1].id as Id };
}

const open = (app: unknown, id: Id) => openCardDialog(app as BoardApp, id);
const box = () => browser.document.body.querySelector('[role="dialog"]') as FakeElement | null;
const addField = () => box()!.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Add a checklist item')!;
const rows = () => box()!.querySelectorAll('.k-cl-row');
const checkbox = (text: string) => box()!.querySelectorAll('.k-cl-box').find((b) => b.getAttribute('aria-label') === text)!;
const bo = (store: Store, id: Id) => store.get(id) as BaseObj;
const steps = (store: Store) => (store.undo as unknown as { undoStack: unknown[] }).undoStack.length;
const list = (store: Store, id: Id): ChecklistItem[] => bo(store, id).checklist ?? [];
/** The card's checklist as it was before the dialog opened: one write, not an undo step. */
const seed = (store: Store, id: Id, items: ChecklistItem[]) => {
  store.transact(() => store.update(id, { checklist: items }));
  store.undo.clear();
};
function press(el: FakeElement, key: string, extra: Record<string, unknown> = {}) {
  const e = new FakeEvent('keydown');
  Object.assign(e, { key, ...extra });
  el.dispatchEvent(e);
}

describe('the checklist section, for an editor', () => {
  it('sits after the description and before the owner and due fields', () => {
    const { app, card } = setup();
    open(app, card);
    const kids = [...box()!.querySelector('.k-card-form')!.children];
    const at = kids.findIndex((c) => c.classList.contains('k-checklist'));
    expect(at).toBeGreaterThan(0);
    expect(textOf(kids[at - 1].querySelector('.field-label')!)).toBe('Description');
    expect(kids[at + 1].classList.contains('k-row2')).toBe(true);
  });

  it('adds an item on Enter as one write, and keeps the focus in the field', () => {
    const { store, app, card } = setup();
    open(app, card);
    const field = addField();
    field.value = 'Passport';
    press(field, 'Enter');
    expect(list(store, card)).toEqual([{ id: expect.any(String), text: 'Passport', done: false }]);
    expect(steps(store)).toBe(1);
    expect(field.value).toBe('');
    expect(rows()).toHaveLength(1);
  });

  it('ticks an item in one write, and shows the count and the bar', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: false }, { id: 'pack-2', text: 'Charger', done: false }]);
    open(app, card);
    checkbox('Passport').click();
    expect(list(store, card).map((i) => i.done)).toEqual([true, false]);
    expect(list(store, card).map((i) => i.id)).toEqual(['pack-1', 'pack-2']);
    expect(steps(store)).toBe(1);
    expect(checkbox('Passport').getAttribute('aria-checked')).toBe('true');
    expect(box()!.querySelector('.k-cl-count')!.textContent).toBe('1 of 2');
    expect(box()!.querySelector('.k-cl-bar')!.getAttribute('aria-valuenow')).toBe('1');
  });

  it('shows All done with no hide control when every item is ticked', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: true }]);
    open(app, card);
    expect(box()!.querySelector('.k-cl-count')!.classList.contains('k-cl-done')).toBe(true);
    expect(textOf(box()!.querySelector('.k-cl-count')!)).toBe('All done');
    expect(box()!.querySelector('.k-cl-hide')!.hidden).toBe(true);
  });

  it('hides the done items on request, and only while some are not done', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: true }, { id: 'pack-2', text: 'Charger', done: false }]);
    open(app, card);
    expect(rows()).toHaveLength(2);
    box()!.querySelector<FakeElement>('.k-cl-hide')!.click();
    expect(rows()).toHaveLength(1);
    expect(box()!.querySelector('.k-cl-hide')!.textContent).toBe('Show 1 done');
    expect(steps(store)).toBe(0);
  });

  it('deletes an item in one write', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: false }, { id: 'pack-2', text: 'Charger', done: false }]);
    open(app, card);
    box()!.querySelectorAll('.k-cl-del')[0].click();
    expect(list(store, card).map((i) => i.text)).toEqual(['Charger']);
    expect(steps(store)).toBe(1);
  });

  it('edits an item on Enter and keeps its id', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: false }]);
    open(app, card);
    box()!.querySelector<FakeElement>('.k-cl-text')!.click();
    const field = box()!.querySelector<FakeElement>('.k-cl-edit')!;
    field.value = '  Passport and visa  ';
    press(field, 'Enter');
    expect(list(store, card)).toEqual([{ id: 'pack-1', text: 'Passport and visa', done: false }]);
    expect(steps(store)).toBe(1);
  });

  it('cancels an edit on Escape without writing', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: false }]);
    open(app, card);
    box()!.querySelector<FakeElement>('.k-cl-text')!.click();
    const field = box()!.querySelector<FakeElement>('.k-cl-edit')!;
    field.value = 'Something else';
    press(field, 'Escape');
    expect(list(store, card)).toEqual([{ id: 'pack-1', text: 'Passport', done: false }]);
    expect(steps(store)).toBe(0);
  });

  it('caps the list at 50 items: the add field is disabled', () => {
    const { store, app, card } = setup();
    seed(store, card, Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`, text: `Step ${i + 1}`, done: false })));
    open(app, card);
    expect(addField().disabled).toBe(true);
    expect(addField().getAttribute('placeholder')).toBe('The list is full (50 items)');
  });

  it('pastes three lines as three items in one write, reading list marks and ticks', () => {
    const { store, app, card } = setup();
    open(app, card);
    const field = addField();
    const paste = new FakeEvent('paste');
    Object.assign(paste, { clipboardData: { getData: () => '- Pack bag\n[x] Book train\n2. Call Sam' } });
    field.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(list(store, card).map((i) => [i.text, i.done])).toEqual([['Pack bag', false], ['Book train', true], ['Call Sam', false]]);
    expect(steps(store)).toBe(1);
    expect(box()!.querySelector('.k-cl-note')!.hidden).toBe(true);
  });

  it('says how many pasted items did not fit', () => {
    const { store, app, card } = setup();
    seed(store, card, Array.from({ length: 49 }, (_, i) => ({ id: `item-${i}`, text: `Step ${i + 1}`, done: false })));
    open(app, card);
    const paste = new FakeEvent('paste');
    Object.assign(paste, { clipboardData: { getData: () => 'One\nTwo\nThree' } });
    addField().dispatchEvent(paste);
    expect(list(store, card)).toHaveLength(50);
    expect(textOf(box()!.querySelector('.k-cl-note')!)).toBe('2 items were not added: the list holds 50.');
  });

  it('turns an item into a card directly below this card, in one undo step', () => {
    const { store, app, card, laneId } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: false }, { id: 'pack-2', text: 'Charger', done: false }]);
    open(app, card);
    box()!.querySelectorAll<FakeElement>('.k-cl-convert')[0].click();
    const cards = store.containerLayout(store.get(laneId)!.parent!)!.cards.get(laneId)!;
    const made = cards[cards.indexOf(card) + 1];
    expect(made).toBeDefined();
    expect(bo(store, made).type).toBe('card');
    expect(bo(store, made).text).toBe('Passport');
    expect(bo(store, made).parent).toBe(laneId);
    expect(list(store, card).map((i) => i.id)).toEqual(['pack-2']);
    expect(steps(store)).toBe(1);
  });
});

describe('the checklist section, for a reader', () => {
  it('shows the list with no add field, no grip and no tools; the checkboxes keep their state', () => {
    const { store, app, card } = setup();
    seed(store, card, [{ id: 'pack-1', text: 'Passport', done: true }]);
    store.setReadOnly(true);
    open(app, card);
    expect(box()!.querySelector('.k-cl-add')).toBeNull();
    expect(box()!.querySelector('.k-cl-grip')).toBeNull();
    expect(box()!.querySelector('.k-cl-tools')).toBeNull();
    const box1 = checkbox('Passport');
    expect(box1.disabled).toBe(true);
    expect(box1.getAttribute('aria-disabled')).toBe('true');
    expect(box1.getAttribute('aria-checked')).toBe('true');
    expect(rows()).toHaveLength(1);
  });
});
