import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { validateTemplateContent } from '../server/templates.mjs';
import { instantiate, toTemplateContent, validateContent, type TemplateContent } from '../src/custom-templates';
import { builtinToCustom } from '../src/template-file';
import { TEMPLATES } from '../src/templates';
import { Store } from '../src/store';
import { createLabel, listLabels, mergeTemplateLabels } from '../src/labels';
import { layoutAll, ranksBetween, splitRank } from '../shared/containers';
import { thumbnailSvg } from '../src/template-thumb';
import type { BaseObj, Obj } from '../src/types';

// docs/kanban.md, slice 5, Templates: the four built-in kanbans, the validator on both sides checking container, lane and
// card field by field, stripping owners and dates on save, rank suffixes on use, and the label merge.

/** A small kanban template: a frame holding a kanban with two lanes and two cards, and two labels. */
function content(): TemplateContent {
  const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const objects = [
    { ...box, id: 'f', type: 'frame', z: '1', name: 'Frame' },
    { ...box, id: 'k', type: 'container', z: '2', layout: 'kanban', name: 'Board', parent: 'f', laneW: 280 },
    { ...box, id: 'a', type: 'lane', z: '3', parent: 'k', rank: 'a0@k', name: 'To do', stage: 'todo', fill: 'Teal' },
    { ...box, id: 'b', type: 'lane', z: '4', parent: 'k', rank: 'a1@k', name: 'Doing', stage: 'doing', wip: 3, wipMode: 'block' },
    { ...box, id: 'c1', type: 'card', z: '5', parent: 'a', rank: 'a0@a', text: 'First', desc: 'More words\nover lines', labels: ['l1'], fill: '#FF0000' },
    { ...box, id: 'c2', type: 'card', z: '6', parent: 'b', rank: 'a0@b', text: 'Second' },
    { ...box, id: 'c3', type: 'card', z: '7', text: 'Loose' },
  ] as unknown as Obj[];
  return { objects, steps: [], bounds: { x: 0, y: 0, w: 100, h: 100 }, labels: [{ id: 'l1', name: 'Bug', color: 'pink' }, { id: 'l2', name: 'Feature', color: '#2F6FED' }] };
}

/** The content with one object changed (or `null` to delete a key). */
function patched(id: string, patch: Record<string, unknown>, change?: (c: TemplateContent) => void): TemplateContent {
  const c = structuredClone(content());
  const o = c.objects.find((x) => x.id === id) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete o[k];
    else o[k] = v;
  }
  change?.(c);
  return c;
}

const validators = [
  ['the server', (c: unknown) => validateTemplateContent(c).content as TemplateContent],
  ['the client', (c: unknown) => validateContent(c)],
] as const;

describe.each(validators)('%s template validator', (_name, validate) => {
  it('accepts a kanban, rebuilding each part from the fields it knows', () => {
    const c = patched('c1', { evil: '<script>', onclick: 'x' }, (x) => Object.assign(x.objects.find((o) => o.id === 'k')!, { columns: 3 }));
    const out = validate(c);
    const card = out.objects.find((o) => o.id === 'c1') as BaseObj & Record<string, unknown>;
    expect(card.evil).toBeUndefined();
    expect(card.onclick).toBeUndefined();
    expect(card).toMatchObject({ type: 'card', parent: 'a', rank: 'a0@a', text: 'First', desc: 'More words\nover lines', labels: ['l1'], fill: '#FF0000' });
    expect((out.objects.find((o) => o.id === 'k') as unknown as Record<string, unknown>).columns).toBeUndefined();
    expect(out.objects.find((o) => o.id === 'a')).toMatchObject({ name: 'To do', stage: 'todo', fill: 'teal' });
    expect(out.objects.find((o) => o.id === 'b')).toMatchObject({ wip: 3, wipMode: 'block' });
    expect(out.labels).toEqual([{ id: 'l1', name: 'Bug', color: 'pink' }, { id: 'l2', name: 'Feature', color: '#2F6FED' }]);
  });

  it.each([
    ['a lane outside a kanban', 'a', { parent: 'f', rank: 'a0@f' }, /not in a kanban/],
    ['a lane with no parent', 'a', { parent: null, rank: null }, /not in a kanban/],
    ['a card in a kanban, not a lane', 'c1', { parent: 'k', rank: 'a0@k' }, /parent is not a lane/],
    ['a card in a frame', 'c1', { parent: 'f', rank: 'a0@f' }, /parent is not a lane/],
    ['a kanban inside a lane', 'k', { parent: 'a' }, /not a frame/],
    ['a rank that is not one', 'c1', { rank: 'not a rank' }, /rank/],
    ['a rank with no parent in it', 'c1', { rank: 'a0' }, /rank/],
    ['a rank naming another parent', 'c1', { rank: 'a0@b' }, /rank/],
    ['a laid-out lane with no rank', 'b', { rank: null }, /rank/],
    ['a loose card with a rank', 'c3', { rank: 'a0@x' }, /no rank/],
    ['a label not in the template', 'c1', { labels: ['l9'] }, /not in the template/],
    ['a label twice', 'c1', { labels: ['l1', 'l1'] }, /label twice/],
    ['labels that are not a list', 'c1', { labels: 'l1' }, /must be a list/],
    ['eleven labels', 'c1', { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }, /at most 10/],
    ['a due date', 'c1', { due: '2026-10-09' }, /due date/],
    ['an owner kind', 'c1', { ownerKind: 'agent' }, /an owner/],
    ['a card link', 'c1', { link: 'https://example.com' }, /a link/],
    ['an owner id', 'c1', { ownerId: 'u1' }, /an owner/],
    ['an owner name', 'c1', { ownerName: 'Ada' }, /an owner/],
    ['a tracker link', 'c1', { extUrl: 'https://example.com' }, /extUrl/],
    ['a fill that injects style', 'c1', { fill: 'red;background:url(https://evil.example/x)' }, /colour the board can/],
    ['a fill of none', 'a', { fill: 'none' }, /colour the board can/],
    ['a title over 200 characters', 'c1', { text: 'x'.repeat(201) }, /title must be text/],
    ['a title on two lines', 'c1', { text: 'one\ntwo' }, /title must be text/],
    ['a description over 4,000 characters', 'c1', { desc: 'x'.repeat(4001) }, /description/],
    ['a control character in a description', 'c1', { desc: 'a\u0007b' }, /description/],
    ['a lane name over 60 characters', 'a', { name: 'x'.repeat(61) }, /name must be text/],
    ['a kanban name over 80 characters', 'k', { name: 'x'.repeat(81) }, /name must be text/],
    ['an unknown stage', 'a', { stage: 'blocked' }, /stage/],
    ['a WIP limit of 0', 'b', { wip: 0 }, /WIP limit/],
    ['a WIP limit of 100', 'b', { wip: 100 }, /WIP limit/],
    ['a WIP limit that is not whole', 'b', { wip: 2.5 }, /WIP limit/],
    ['a WIP mode with no limit', 'b', { wip: null }, /no limit/],
    ['an unknown WIP mode', 'b', { wipMode: 'strict' }, /WIP mode|wipMode/],
    ['an unknown layout', 'k', { layout: 'table' }, /layout/],
    ['a lane width below 200', 'k', { laneW: 100 }, /lane width/],
  ] as const)('refuses %s', (_what, id, patch, message) => {
    expect(() => validate(patched(id, patch))).toThrow(message);
  });

  it('refuses an object of another type inside a lane', () => {
    const c = content();
    c.objects.push({ id: 's', type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: '9', parent: 'a', text: 'x' } as unknown as Obj);
    expect(() => validate(c)).toThrow(/frame|kanban/);
  });

  it('refuses a label list that is not one, too long or badly coloured', () => {
    expect(() => validate({ ...content(), labels: 'Bug' })).toThrow(/must be a list/);
    expect(() => validate({ ...content(), labels: Array.from({ length: 31 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, color: 'grey' })) })).toThrow(/30 labels/);
    expect(() => validate({ ...content(), labels: [{ id: 'l1', name: 'Bug', color: 'url(x)' }] })).toThrow(/colour/);
    expect(() => validate({ ...content(), labels: [{ id: 'l1', name: 'x'.repeat(41), color: 'grey' }] })).toThrow(/name must be text/);
    expect(() => validate({ ...content(), labels: [{ id: 'l1', name: 'A', color: 'grey' }, { id: 'l1', name: 'B', color: 'grey' }] })).toThrow(/share an id/);
  });

  it('refuses more than 20 lanes in a kanban', () => {
    const c = content();
    const ranks = ranksBetween('a1@k', null, 19, 'k');
    for (let i = 0; i < 19; i++) c.objects.push({ id: `x${i}`, type: 'lane', x: 0, y: 0, w: 1, h: 1, rotation: 0, z: `x${i}`, parent: 'k', rank: ranks[i] } as unknown as Obj);
    expect(() => validate(c)).toThrow(/20 lanes/);
  });

  it('accepts every built-in kanban template', () => {
    for (const def of TEMPLATES.filter((t) => ['kanban', 'sprint-board', 'bug-triage', 'personal-tasks'].includes(t.id))) {
      const t = builtinToCustom(def, 'me', 1);
      const out = validate(t.content);
      expect(out.objects.some((o) => o.type === 'container')).toBe(true);
      expect(out.labels?.length ?? 0).toBeGreaterThanOrEqual(def.id === 'personal-tasks' ? 0 : 1);
    }
  });
});

describe('saving a template with a kanban', () => {
  const board = (): Obj[] => [
    { id: 'K', type: 'container', layout: 'kanban', name: 'Board', x: 10, y: 10, w: 400, h: 300, rotation: 0, z: 'a0', createdBy: 'me', updatedAt: 1, locked: true },
    { id: 'L', type: 'lane', parent: 'K', rank: 'a0@K', name: 'To do', x: 22, y: 70, w: 280, h: 200, rotation: 0, z: 'a0' },
    { id: 'C', type: 'card', parent: 'L', rank: 'a0@L', text: 'Task', x: 30, y: 126, w: 264, h: 72, rotation: 0, z: 'a0', ownerId: 'u1', ownerName: 'Ada', ownerKind: 'agent', due: '2026-10-09', link: 'https://example.com/task', extKey: 'TAB-1', labels: ['B1', 'gone'] },
    { id: 'D', type: 'card', parent: 'L', rank: 'a1@L', text: 'Other', x: 30, y: 206, w: 264, h: 72, rotation: 0, z: 'a0', labels: ['B2'] },
  ] as unknown as Obj[];
  const labels = [{ id: 'B1', name: 'Bug', color: 'pink' }, { id: 'B2', name: 'Feature', color: 'blue' }, { id: 'B3', name: 'Unused', color: 'grey' }];

  it('strips owners, owner kinds, due dates, card links and tracker fields, keeps used labels and names parents in ranks', () => {
    const c = toTemplateContent(board(), [], { includeSteps: false, labels });
    const card = c.objects.find((o) => (o as BaseObj).text === 'Task') as BaseObj & Record<string, unknown>;
    for (const key of ['ownerId', 'ownerName', 'ownerKind', 'due', 'link', 'extKey', 'locked']) expect(card[key]).toBeUndefined();
    expect(card.labels).toEqual(['l1']);
    expect(c.labels).toEqual([{ id: 'l1', name: 'Bug', color: 'pink' }, { id: 'l2', name: 'Feature', color: 'blue' }]);
    // ranks follow the new ids
    const ranked = c.objects.filter((o) => (o as BaseObj).rank) as BaseObj[];
    expect(ranked).toHaveLength(3);
    expect(ranked.map((o) => splitRank(o.rank)!.parent)).toEqual(ranked.map((o) => o.parent));
    expect(() => validateContent(c)).not.toThrow();
    expect(() => validateTemplateContent(JSON.parse(JSON.stringify(c)))).not.toThrow();
  });

  it('leaves out a hidden kanban, what is inside it, and connectors bound to it, so a template never un-hides them', () => {
    const sticky = { id: 'S', type: 'sticky', text: 'Note', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0' } as unknown as Obj;
    const link = { id: 'X', type: 'connector', from: { kind: 'bound', id: 'K' }, to: { kind: 'bound', id: 'S' }, z: 'a0' } as unknown as Obj;
    const objs = [...board(), sticky, link];
    (objs[0] as BaseObj).hidden = true;
    const c = toTemplateContent(objs, [], { includeSteps: false, labels });
    expect(c.objects.map((o) => (o as BaseObj).text)).toEqual(['Note']);
    expect(c.labels).toBeUndefined();
    // a hidden card goes alone
    const only = board();
    (only[3] as BaseObj).hidden = true;
    expect(toTemplateContent(only, [], { includeSteps: false, labels }).objects.map((o) => (o as BaseObj).text)).toEqual([undefined, undefined, 'Task']);
  });

  it('drops the card fields a sticky kept from when it was a card', () => {
    const sticky = { id: 'S', type: 'sticky', text: 'Note', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', ownerName: 'Ada', ownerKind: 'agent', due: '2026-10-09', link: 'https://example.com', desc: 'more', labels: ['B1'] } as unknown as Obj;
    const c = toTemplateContent([sticky], [], { includeSteps: false, labels });
    expect(Object.keys(c.objects[0]).sort()).toEqual(['h', 'id', 'rotation', 'text', 'type', 'w', 'x', 'y', 'z']);
    expect(c.labels).toBeUndefined();
  });

  it('becomes a kanban again on use, with ranks naming the new parents', () => {
    const c = toTemplateContent(board(), [], { includeSteps: false, labels });
    const { objects } = instantiate(c, { x: 500, y: 500 }, 'you');
    const ids = new Set(objects.map((o) => o.id));
    const inside = objects.filter((o) => (o as BaseObj).parent) as BaseObj[];
    expect(inside.every((o) => ids.has(o.parent!))).toBe(true);
    expect(inside.map((o) => splitRank(o.rank)!.parent)).toEqual(inside.map((o) => o.parent));
    const { layouts } = layoutAll(objects);
    const layout = [...layouts.values()][0];
    expect([...layout.cards.values()].flat().map((id) => (objects.find((o) => o.id === id) as BaseObj).text)).toEqual(['Task', 'Other']);
  });

  it('draws its kanban in the thumbnail where the layout puts it', () => {
    const c = toTemplateContent(board(), [], { includeSteps: false, labels });
    const svg = thumbnailSvg(c.objects, { labels: c.labels });
    expect(svg).toContain('Task');
    expect(svg).toContain('BUG');
  });
});

describe('merging template labels into the board', () => {
  it('uses a board label of the same name, adds the missing ones, in one transaction', () => {
    const store = new Store(new Y.Doc());
    const bug = createLabel(store, 'bug', 'yellow')!;
    store.undo.clear();
    let map = new Map<string, string>();
    store.transact(() => (map = mergeTemplateLabels(store, [{ id: 'l1', name: 'Bug', color: 'pink' }, { id: 'l2', name: 'Feature', color: 'blue' }])));
    expect(map.get('l1')).toBe(bug);
    expect(listLabels(store).map((l) => [l.name, l.color])).toEqual([['bug', 'yellow'], ['Feature', 'blue']]);
    store.undo.undo();
    expect(listLabels(store).map((l) => l.name)).toEqual(['bug']);
  });

  it('adds none past the 30 a board holds', () => {
    const store = new Store(new Y.Doc());
    for (let i = 0; i < 30; i++) createLabel(store, `L${i}`);
    let map = new Map<string, string>();
    store.transact(() => (map = mergeTemplateLabels(store, [{ id: 'l1', name: 'New', color: 'pink' }, { id: 'l2', name: 'l3', color: 'pink' }])));
    expect(map.has('l1')).toBe(false);
    expect(map.get('l2')).toBe(listLabels(store).find((l) => l.name === 'L3')!.id);
    expect(listLabels(store)).toHaveLength(30);
  });
});
