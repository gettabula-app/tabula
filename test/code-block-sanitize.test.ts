import { describe, expect, it } from 'vitest';
import { validateContent } from '../src/custom-templates';
import { isTemplateKey, sanitizeImportedObjects, sanitizeTemplateObject } from '../src/import-sanitize';
import { MAX_CODE_CHARS, MAX_CODE_TITLE } from '../shared/code-langs';
import type { Obj } from '../src/types';

const base = { x: 0, y: 0, w: 320, h: 160, rotation: 0, z: 'a0', createdBy: 'victim' };
const code = (extra: Record<string, unknown> = {}) => ({ id: 'c1', type: 'code', ...base, text: 'let a = 1;', lang: 'ts', ...extra });

describe('the code block in the import and template sanitiser', () => {
  it('keeps a legitimate code block as it is (authored by the importer), and drops an owner, a tracker link and proposedBy', () => {
    const [o] = sanitizeImportedObjects([code({ title: 'main.ts', lines: true, wrap: false, ownerId: 'x', ownerKind: 'person', tracker: { a: 1 }, proposedBy: { run: 1 } }) as unknown as Obj], 'me');
    expect(o).toEqual({ ...code({ title: 'main.ts', lines: true, wrap: false }), createdBy: 'me' });
  });

  it('turns an unknown language into plain text, strips hidden characters, cuts the code and the title, and drops non-boolean flags', () => {
    const hostile = code({ lang: 'klingon', text: `a‮b\u0000c​d\n\tx${'y'.repeat(MAX_CODE_CHARS)}`, title: `  one\n\ttwo ${'t'.repeat(500)}`, lines: 'yes', wrap: 1, __proto__: { p: 1 }, evil: 'field' });
    const [o] = sanitizeImportedObjects([hostile as unknown as Obj], 'me') as unknown as Record<string, unknown>[];
    expect(o.lang).toBe('plaintext');
    expect((o.text as string).startsWith('abc')).toBe(true);
    expect(o.text).toMatch(/\n\tx/);
    expect([...(o.text as string)].length).toBeLessThanOrEqual(MAX_CODE_CHARS);
    expect([...(o.title as string)].length).toBeLessThanOrEqual(MAX_CODE_TITLE);
    expect(o.title).toMatch(/^one two t/);
    expect(o).not.toHaveProperty('lines');
    expect(o).not.toHaveProperty('wrap');
    expect(Object.hasOwn(o, '__proto__')).toBe(false);
  });

  it('a template keeps a code block\'s own keys only, and it validates', () => {
    for (const k of ['lang', 'title', 'lines', 'wrap', 'text']) expect(isTemplateKey('code', k)).toBe(true);
    for (const k of ['ownerId', 'createdBy', 'tracker', 'proposedBy', '__proto__']) expect(isTemplateKey('code', k)).toBe(false);
    const s = sanitizeTemplateObject(code({ lang: 'nope', ownerId: 'x', title: 7 }));
    expect(s).not.toHaveProperty('ownerId');
    expect(s).not.toHaveProperty('createdBy');
    expect(s).not.toHaveProperty('title');
    expect((s as { lang: string }).lang).toBe('plaintext');
    const v = validateContent({ objects: [code({ ownerId: 'x', lang: 'rust' })], steps: [], bounds: { x: 0, y: 0, w: 1, h: 1 } });
    expect(v.objects[0]).toMatchObject({ type: 'code', lang: 'rust', text: 'let a = 1;' });
    expect(v.objects[0]).not.toHaveProperty('ownerId');
  });
});
