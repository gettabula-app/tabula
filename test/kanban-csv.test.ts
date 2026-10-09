import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { BoardApp } from '../src/app';
import { Store } from '../src/store';
import { addCard, newKanban } from '../src/containers';
import { createLabel, listLabels } from '../src/labels';
import { BOM, CSV_COLUMNS, cardRows, cardsCsvName, csvCell, csvText } from '../src/csv';
import { csvKanbans, safeName } from '../src/exporters';
import type { BaseObj, Id } from '../src/types';

// docs/kanban.md, Export and import: cards as CSV, RFC 4180, a byte order mark, \r\n, and formula-safe cells.

describe('a CSV cell', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(1)', "'@SUM(1)"],
    ['\tcmd', "'\tcmd"],
    ['=HYPERLINK("https://evil.example","x")', '"\'=HYPERLINK(""https://evil.example"",""x"")"'],
  ])('guards %j against being read as a formula', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('guards a cell starting with a carriage return, then quotes it', () => {
    expect(csvCell('\r=1')).toBe('"\'\r=1"');
  });

  it('leaves ordinary text, a date and a number alone', () => {
    expect(csvCell('Write the guide')).toBe('Write the guide');
    expect(csvCell('2026-10-09')).toBe('2026-10-09');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(csvCell('one\r\ntwo')).toBe('"one\r\ntwo"');
  });
});

describe('the CSV file', () => {
  it('starts with a byte order mark and the header, and ends every line with \\r\\n', () => {
    const text = csvText([['K', 'L', 'todo', 1, 'T', '', '', '', '', 0, 'me', '', 'c1']]);
    expect(text.startsWith(BOM)).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('container,lane,stage,position,title,description,owner,due,labels,comments,created_by,updated_at,id');
    expect(lines[1]).toBe('K,L,todo,1,T,,,,,0,me,,c1');
    expect(lines[2]).toBe('');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('names the file after the board and the kanban, without unsafe characters', () => {
    expect(cardsCsvName('Q4: plans/<x>', 'Sprint "1"', safeName)).toBe('q4-plansx-sprint-1-cards.csv');
    expect(cardsCsvName('Board', null, safeName)).toBe('board-cards.csv');
    expect(cardsCsvName('', '', safeName)).toBe('board-kanban-cards.csv');
  });
});

afterEach(() => vi.useRealTimers());

function board() {
  // the store stamps every write with the time: a fixed one
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 9, 12, 0, 0), toFake: ['Date'] });
  const store = new Store(new Y.Doc());
  const k1 = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'me' });
  const k2 = newKanban({ x: 0, y: 2000 }, { z: 'a1', createdBy: 'me' });
  store.transact(() => [k1.container, ...k1.lanes, { ...k2.container, name: 'Second' }, ...k2.lanes].forEach((o) => store.create(o)));
  const bug = createLabel(store, 'Bug')!;
  const ui = createLabel(store, 'UI, phone')!;
  const [todo, doing] = k1.lanes.map((l) => l.id);
  const a = addCard(store, todo, '=cmd|calc', { createdBy: 'ada' })!;
  const b = addCard(store, todo, 'Second, with "quotes"', { createdBy: 'bo' })!;
  const c = addCard(store, doing, 'Doing it', { createdBy: 'ada' })!;
  const d = addCard(store, k2.lanes[0].id, 'Elsewhere', { createdBy: 'ada' })!;
  store.transact(() => {
    store.update(a, { desc: 'line one\nline two', ownerName: 'Ada', due: '2026-10-12', labels: [bug, ui, 'deleted'] });
  });
  return { store, k1: k1.container.id, k2: k2.container.id, todo, doing, a, b, c, d };
}

describe('the card rows', () => {
  it('lists every card, lane by lane, with its position, stage, labels and comments', () => {
    const s = board();
    const rows = cardRows({
      get: (id) => s.store.get(id) as BaseObj | undefined,
      containerLayout: (id) => s.store.containerLayout(id),
      labels: listLabels(s.store),
      commentCount: (id) => (id === s.b ? 2 : 0),
    }, [s.k1]);
    expect(rows.map((r) => [r[1], r[2], r[3], r[4]])).toEqual([['To do', 'todo', 1, '=cmd|calc'], ['To do', 'todo', 2, 'Second, with "quotes"'], ['Doing', 'doing', 1, 'Doing it']]);
    const [first, second] = rows;
    expect(first).toEqual(['Kanban', 'To do', 'todo', 1, '=cmd|calc', 'line one\nline two', 'Ada', '2026-10-12', 'Bug; UI, phone', 0, 'ada', '2026-10-09T12:00:00.000Z', s.a]);
    expect(second[9]).toBe(2);
    expect(rows[0]).toHaveLength(CSV_COLUMNS.length);
    // in the file, the formula is guarded and the rest quoted where it needs it (an id can start with - too)
    const text = csvText(rows);
    expect(text).toContain(`Kanban,To do,todo,1,'=cmd|calc,"line one\nline two",Ada,2026-10-12,"Bug; UI, phone",0,ada,2026-10-09T12:00:00.000Z,${csvCell(s.a)}\r\n`);
    expect(text).toContain('"Second, with ""quotes"""');
  });
});

describe('which kanbans are exported', () => {
  const app = (s: ReturnType<typeof board>, selection: Id[]) => ({ store: s.store, selection }) as unknown as BoardApp;

  it('every kanban when nothing is selected, in paint order', () => {
    const s = board();
    expect(csvKanbans(app(s, []))).toEqual([s.k1, s.k2]);
  });

  it('the kanban of a selected card or lane, or a selected kanban', () => {
    const s = board();
    expect(csvKanbans(app(s, [s.d]))).toEqual([s.k2]);
    expect(csvKanbans(app(s, [s.doing]))).toEqual([s.k1]);
    expect(csvKanbans(app(s, [s.k2, s.a]))).toEqual([s.k1, s.k2]);
  });

  it('the ones asked for, from a kanban menu', () => {
    const s = board();
    expect(csvKanbans(app(s, [s.k1]), [s.k2])).toEqual([s.k2]);
    expect(csvKanbans(app(s, []), ['gone'])).toEqual([]);
  });
});
