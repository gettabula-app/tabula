import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CODE_LANG_IDS, MAX_CODE_CHARS } from '../shared/code-langs.mjs';
import { OpsError, applyPlan, planCreate, planUpdate, summarise, readAll } from '../server/board-ops.mjs';
import { exportBoardMarkdown } from '../server/board-export.mjs';
import { FIELDS, OBJ_TYPES, validateBoardObject } from '../server/sync-validate.mjs';
import { MAX_TEMPLATE_CODE_CHARS, TEMPLATE_OBJ_TYPES, validateTemplateContent } from '../server/templates.mjs';

const who = { createdBy: 'user-1', now: 1000 };
const create = (d: Y.Doc, items: unknown[]) => {
  const plan = planCreate(d, items, who);
  d.transact(() => applyPlan(d, plan), 'mcp:test');
  return plan.result as { created: { id: string }[] };
};
const update = (d: Y.Doc, updates: unknown[]) => {
  const plan = planUpdate(d, updates, { now: 2000 });
  d.transact(() => applyPlan(d, plan), 'mcp:test');
};
const fail = (fn: () => unknown): OpsError => {
  try { fn(); } catch (e) { if (e instanceof OpsError) return e; throw e; }
  throw new Error('expected an OpsError');
};
const stored = (d: Y.Doc, id: string) => d.getMap<Y.Map<unknown>>('objects').get(id)!.toJSON() as Record<string, any>;

describe('validator', () => {
  const ctx = { writer: { id: 'u1' }, isBoardMember: () => true, canEditObject: () => true };
  const obj = (extra: Record<string, unknown> = {}) => ({ id: 'k1', type: 'code', x: 0, y: 0, w: 520, h: 100, rotation: 0, z: 'a0', createdBy: 'u1', text: 'let a = 1', lang: 'ts', title: 'T', lines: true, wrap: false, ...extra });
  const run = (v: unknown) => validateBoardObject('k1', v, ctx, {}) as { ok: boolean; violations?: { code: string; path: string; reportOnly?: boolean }[] };

  it('knows the type and its fields', () => {
    expect(OBJ_TYPES).toContain('code');
    expect(Object.keys(FIELDS.code)).toEqual(expect.arrayContaining(['text', 'lang', 'title', 'lines', 'wrap', 'x', 'w']));
    expect(run(obj()).ok).toBe(true);
    for (const lang of CODE_LANG_IDS) expect(run(obj({ lang })).ok).toBe(true);
  });

  it('refuses an unknown language, a non-boolean switch and a bad title; the text cap is report-only', () => {
    expect(run(obj({ lang: 'klingon' })).violations).toContainEqual(expect.objectContaining({ code: 'bad_value', path: 'lang' }));
    expect(run(obj({ lang: 'typescript' })).violations).toContainEqual(expect.objectContaining({ code: 'bad_value', path: 'lang' })); // aliases are for tools, the stored value is an id
    expect(run(obj({ wrap: 'yes' })).violations).toContainEqual(expect.objectContaining({ code: 'bad_type', path: 'wrap' }));
    expect(run(obj({ title: 'x'.repeat(101) })).violations).toContainEqual(expect.objectContaining({ code: 'too_long', path: 'title' }));
    const big = run(obj({ text: 'x'.repeat(MAX_CODE_CHARS + 1) }));
    expect(big.violations).toContainEqual(expect.objectContaining({ code: 'too_long', path: 'text', reportOnly: true }));
    expect(run(obj({ text: 'x'.repeat(MAX_CODE_CHARS) })).ok).toBe(true);
  });

  it('other types do not take code fields', () => {
    expect(run({ ...obj(), type: 'sticky' }).ok).toBe(false);
  });
});

describe('board-ops', () => {
  it('creates a code block with defaults, an alias language, a title and a fitted height estimate', () => {
    const d = new Y.Doc();
    const { created } = create(d, [
      { type: 'code', text: 'a\nb\nc', x: 5, y: 6 },
      { type: 'code', text: 'print(1)', lang: 'py', title: '  My   code ', lines: true, wrap: true, x: 0, y: 0, w: 300 },
    ]);
    expect(stored(d, created[0].id)).toMatchObject({ type: 'code', text: 'a\nb\nc', lang: 'plaintext', lines: false, wrap: false, w: 520, x: 5, y: 6 });
    expect(stored(d, created[0].id).h).toBeCloseTo(28 + 3 * 19.5, 1);
    expect(stored(d, created[1].id)).toMatchObject({ lang: 'python', title: 'My code', lines: true, wrap: true, w: 300 });
    expect(stored(d, created[1].id).h).toBeCloseTo(36 + 28 + 19.5, 1);
  });

  it('keeps tabs, refuses an unknown language and fields of other types, and caps the text at 20,000', () => {
    const d = new Y.Doc();
    const { created } = create(d, [{ type: 'code', text: 'if x:\n\treturn', x: 0, y: 0 }]);
    expect(stored(d, created[0].id).text).toBe('if x:\n\treturn');
    const e = fail(() => planCreate(d, [{ type: 'code', text: 'x', lang: 'klingon', x: 0, y: 0 }], who));
    expect(e.message).toMatch(/Not a language/);
    expect(JSON.stringify(e)).toContain('objects[0].lang');
    expect(() => create(d, [{ type: 'code', text: 'x'.repeat(MAX_CODE_CHARS), x: 0, y: 0 }])).not.toThrow();
    fail(() => planCreate(d, [{ type: 'code', text: 'x'.repeat(MAX_CODE_CHARS + 1), x: 0, y: 0 }], who));
    fail(() => planCreate(d, [{ type: 'code', text: 'x', x: 0, y: 0, fontSize: 12 }], who));
    fail(() => planCreate(d, [{ type: 'code', text: 'x', x: 0, y: 0, wrap: 'yes' }], who));
  });

  it('updates text, lang (alias), title, lines and wrap, refits the height, and refuses a bad language', () => {
    const d = new Y.Doc();
    const { created } = create(d, [{ type: 'code', text: 'a', x: 0, y: 0 }]);
    const id = created[0].id;
    update(d, [{ id, text: 'a\nb\nc\nd', lang: 'sh', title: 'Run', lines: true }]);
    expect(stored(d, id)).toMatchObject({ lang: 'bash', title: 'Run', lines: true, text: 'a\nb\nc\nd' });
    expect(stored(d, id).h).toBeCloseTo(36 + 28 + 4 * 19.5, 1);
    update(d, [{ id, text: 'a\nb', h: 400 }]);
    expect(stored(d, id).h).toBe(400);
    fail(() => planUpdate(d, [{ id, lang: 'nope' }], { now: 3 }));
    fail(() => planUpdate(d, [{ id, wrap: 1 }], { now: 3 }));
    fail(() => planUpdate(d, [{ id, fontSize: 12 }], { now: 3 }));
    update(d, [{ id, title: '' }]);
    expect(stored(d, id).title).toBe('');
  });

  it('reads a code block back with its language, title and switches', () => {
    const d = new Y.Doc();
    const { created } = create(d, [{ type: 'code', text: 'select 1', lang: 'sql', title: 'Q', wrap: true, x: 0, y: 0 }]);
    const s = summarise(stored(d, created[0].id), 4000, true);
    expect(s).toMatchObject({ type: 'code', text: 'select 1', lang: 'sql', title: 'Q', wrap: true });
    expect((summarise({ ...stored(d, created[0].id), lang: 'bogus' }, 4000) as Record<string, unknown>).lang).toBe('plaintext');
    expect(readAll(d).boxes.some((o: { id: string }) => o.id === created[0].id)).toBe(true);
  });
});

describe('Markdown export', () => {
  const doc = (text: string, extra: Record<string, unknown> = {}) => {
    const d = new Y.Doc();
    d.getMap('objects').set('k1', new Y.Map(Object.entries({ type: 'code', text, lang: 'ts', x: 0, y: 0, w: 520, h: 100, z: 'a0', ...extra })));
    return d;
  };

  it('writes a fenced block named by the language id', () => {
    const md = exportBoardMarkdown(doc('const a = 1;\n\treturn a;'));
    expect(md).toContain('```ts\nconst a = 1;\n\treturn a;\n```');
  });

  it('uses a fence longer than any run of backticks in the code, and a title line', () => {
    const md = exportBoardMarkdown(doc('x\n```\nnot closed\n````\ny', { title: 'Fences' }));
    expect(md).toContain('Fences\n\n`````ts\nx\n```\nnot closed\n````\ny\n`````');
    expect(md).not.toMatch(/\n```ts/);
  });

  it('falls back to plaintext for an unknown language, skips empty blocks and strips invisible characters', () => {
    expect(exportBoardMarkdown(doc('a', { lang: 'bogus' }))).toContain('```plaintext\na\n```');
    expect(exportBoardMarkdown(doc('   \n'))).not.toContain('```');
    expect(exportBoardMarkdown(doc('a\u202eb'))).toContain('```ts\nab\n```');
  });
});

describe('templates', () => {
  const content = (objects: unknown[]) => ({ objects, steps: [], bounds: { x: 0, y: 0, w: 600, h: 400 } });
  const block = (extra: Record<string, unknown> = {}) => ({ id: 'k1', type: 'code', x: 0, y: 0, w: 520, h: 100, rotation: 0, z: '1', text: 'let a = 1;\n\tb()', lang: 'ts', title: 'Hello', lines: true, wrap: false, ...extra });

  it('accepts a code block and keeps its fields', () => {
    expect(TEMPLATE_OBJ_TYPES).toContain('code');
    const out = validateTemplateContent(content([block()])).content.objects[0];
    expect(out).toMatchObject({ type: 'code', text: 'let a = 1;\n\tb()', lang: 'ts', title: 'Hello', lines: true, wrap: false });
  });

  it('refuses an unknown language, bad switches, a long title and more than 8,000 characters of code', () => {
    expect(() => validateTemplateContent(content([block({ lang: 'klingon' })]))).toThrow(/lang/);
    expect(() => validateTemplateContent(content([block({ wrap: 'x' })]))).toThrow(/wrap must be a boolean/);
    expect(() => validateTemplateContent(content([block({ title: 'x'.repeat(101) })]))).toThrow(/title/);
    expect(() => validateTemplateContent(content([block({ text: 'x'.repeat(MAX_TEMPLATE_CODE_CHARS) })]))).not.toThrow();
    expect(() => validateTemplateContent(content([block({ text: 'x'.repeat(MAX_TEMPLATE_CODE_CHARS + 1) })]))).toThrow(/8000 characters/);
  });

  it('counts code toward the template size', () => {
    const many = Array.from({ length: 130 }, (_, i) => block({ id: `k${i}`, text: 'x'.repeat(MAX_TEMPLATE_CODE_CHARS) }));
    expect(() => validateTemplateContent(content(many))).toThrow(/MB/);
  });
});
