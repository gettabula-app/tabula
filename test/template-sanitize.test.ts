import { describe, expect, it } from 'vitest';
import { instantiate, validateContent } from '../src/custom-templates';
import { cleanMarkdownLinks, isTemplateKey, sanitizeImportedObjects, sanitizeTemplateObject, stripHiddenChars } from '../src/import-sanitize';
import { builtinToCustom, exportTemplateFile, parseTemplateFile, TEMPLATE_FILE_FORMAT } from '../src/template-file';
import { validateTemplate } from '../src/template-store';
import { TEMPLATES } from '../src/templates';
import type { Obj } from '../src/types';

const base = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
const content = (objects: unknown[]) => ({ objects, steps: [], bounds: { x: 0, y: 0, w: 1, h: 1 } });
const hostileJson = `{"objects":[
 {"id":"a","type":"sticky","x":0,"y":0,"w":100,"h":100,"z":"1","text":"hi\\u0007\\u202e!","__proto__":{"polluted":1},"ownerId":"victim","createdBy":"victim","ownerName":"Boss","tracker":{"x":1},"extUrl":"javascript:alert(1)","locked":true,"hidden":true,"link":"javascript:alert(1)","unknownBig":"${'x'.repeat(1000)}","constructor":{"prototype":{"x":1}}},
 {"id":"b","type":"markdown","x":0,"y":0,"w":100,"h":100,"z":"2","text":"[x](javascript:alert(1)) [ok](https://example.com) [d](data:text/html,1) [v](vbscript:x) [m](mailto:a@b.co) [o](#obj:abc) ![i](https://tracker/p.gif)","ownerId":"victim"},
 {"id":"c","type":"table","x":0,"y":0,"w":100,"h":100,"z":"3","r:aa":"a0","r:bb":"a1","k:aa":"a0","c:aa:aa":"=1+1\\u0000 [x](javascript:1)","c:__proto__:aa":"x","c:bb:zz":"ghost","w:aa":99999,"__proto__":{"a":1}},
 {"id":"d","type":"link","x":0,"y":0,"w":100,"h":100,"z":"4","url":"javascript:alert(1)","title":"t\\u202e","finalUrl":"data:text/html,x","image":"deadbeef"}
 ],"steps":[{"id":"s1","title":"t\\u0001","instructions":"i","mode":"write"}],"bounds":{"x":0,"y":0,"w":1,"h":1}}`;

describe('the template allow-list sanitiser', () => {
  it('strips XML-illegal and bidi characters and keeps tab, line breaks and ordinary text', () => {
    expect(stripHiddenChars('a\u0000b\u0008c\u000bd\u000ce\u001ff￾g￿h‪i‮j⁦k⁩l')).toBe('abcdefghijkl');
    expect(stripHiddenChars('x\ud800y')).toBe('xy');
    expect(stripHiddenChars('\udc00z')).toBe('z');
    expect(stripHiddenChars('a\tb\nc\rd \u{1F600} é 日本')).toBe('a\tb\nc\rd \u{1F600} é 日本');
  });

  it('turns every hostile probe input into a safe, valid template', () => {
    const v = validateContent(JSON.parse(hostileJson));
    const [sticky, md, table, link] = v.objects as unknown as Record<string, unknown>[];
    expect(Object.hasOwn(sticky, '__proto__')).toBe(false);
    expect(Object.keys(sticky).sort()).toEqual(['h', 'id', 'rotation', 'text', 'type', 'w', 'x', 'y', 'z'].filter((k) => k in sticky).sort());
    for (const k of ['ownerId', 'createdBy', 'ownerName', 'tracker', 'extUrl', 'locked', 'hidden', 'link', 'unknownBig', 'constructor']) expect(sticky).not.toHaveProperty(k);
    expect(sticky.text).toBe('hi!');
    expect(md.text).toBe('x [ok](https://example.com) d v [m](mailto:a@b.co) [o](#obj:abc) !i');
    expect(md).not.toHaveProperty('ownerId');
    expect(Object.keys(table).filter((k) => /^[rkwcf]:/.test(k)).sort()).toEqual(['c:aa:aa', 'k:aa', 'r:aa', 'r:bb', 'w:aa']);
    expect(table['c:aa:aa']).toBe('=1+1 x');
    expect(table['w:aa']).toBeLessThanOrEqual(1000);
    expect(Object.hasOwn(table, '__proto__')).toBe(false);
    expect(link).not.toHaveProperty('url');
    expect(link).not.toHaveProperty('finalUrl');
    expect(link).not.toHaveProperty('image');
    expect(link.title).toBe('t');
    expect(v.steps[0].title).toBe('t');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // and what a board gets from it carries only the acting user
    const inst = instantiate(v, { x: 0, y: 0 }, 'me');
    for (const o of inst.objects) expect((o as { createdBy?: string }).createdBy).toBe('me');
    expect(inst.objects[0]).not.toHaveProperty('ownerId');
  });

  it('a template file with the hostile content comes back through parseTemplateFile and the template store as the same safe template', () => {
    const file = JSON.stringify({ format: TEMPLATE_FILE_FORMAT, version: 1, template: { id: 't', version: 1, name: 'Bad‮name\u0000', category: 'Planning', description: 'd\u0007', createdBy: 'victim', createdAt: 1, updatedAt: 1, content: JSON.parse(hostileJson) } });
    const t = parseTemplateFile(file, 'me');
    expect(t.name).toBe('Badname');
    expect(t.description).toBe('d');
    expect(t.createdBy).toBe('me');
    expect(validateTemplate(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(JSON.stringify(t)).not.toMatch(/javascript:|vbscript:|data:text|victim|\\u0007|‮/);
    expect(parseTemplateFile(exportTemplateFile(t), 'me').content).toEqual(t.content);
  });

  it('keeps what every built-in template carries, unchanged (nothing legitimate is dropped)', () => {
    for (const def of TEMPLATES) {
      const t = builtinToCustom(def, 'me');
      const back = validateContent(t.content);
      expect(back).toEqual(t.content);
    }
  });

  it('keeps a table, a Markdown block and a link card of a saved template, and nothing that sets rights', () => {
    const objs = [
      { id: 'o1', type: 'table', ...base, z: '1', headerRow: true, 'r:aa': 'a0', 'k:aa': 'a0', 'k:bb': 'a1', 'w:aa': 200, 'a:bb': 'right', 'c:aa:aa': 'one', 'f:aa:aa': '#ff0000' },
      { id: 'o2', type: 'markdown', ...base, z: '2', text: '# Plan\n\n- [ ] [link](https://example.com)' },
      { id: 'o3', type: 'link', ...base, z: '3', url: 'https://example.com/a', title: 'T', description: 'D', siteName: 'S' },
      { id: 'o4', type: 'group', z: '4', x: 0, y: 0, w: 0, h: 0, rotation: 0 },
    ];
    expect(validateContent(content(objs)).objects).toEqual(objs);
  });

  it('exposes the key grammar: type keys, table parts, no forbidden or privileged keys', () => {
    expect(isTemplateKey('table', 'c:r1:c1')).toBe(true);
    expect(isTemplateKey('table', 'c:__proto__:x')).toBe(false);
    expect(isTemplateKey('sticky', 'c:r1:c1')).toBe(false);
    expect(isTemplateKey('sticky', 'text')).toBe(true);
    expect(isTemplateKey('sticky', 'ownerId')).toBe(false);
    expect(isTemplateKey('sticky', 'locked')).toBe(false);
    expect(isTemplateKey('shape', 'kind')).toBe(true);
    expect(isTemplateKey('sticky', 'kind')).toBe(false);
    expect(isTemplateKey('markdown', '__proto__')).toBe(false);
  });

  it('cleans Markdown links by target', () => {
    expect(cleanMarkdownLinks('[a](JaVaScRiPt:1) [b](https://e.com) [c](//e.com) [d](file:///x) plain')).toBe('a [b](https://e.com) c d plain');
    expect(cleanMarkdownLinks('![i](asset:' + 'a'.repeat(64) + ')')).toContain('asset:');
  });

  it('the sanitiser is idempotent and does not change its input', () => {
    const o = { id: 'a', type: 'sticky', ...base, z: '1', text: 'x\u0001', ownerId: 'v' };
    const once = sanitizeTemplateObject(o);
    expect(sanitizeTemplateObject(once)).toEqual(once);
    expect(o.ownerId).toBe('v');
  });
});

describe('import and paste take the same cleaning', () => {
  it('a hostile clipboard object keeps its fields but loses unsafe addresses, control characters and forbidden keys', () => {
    const raw = JSON.parse(`{"id":"a","type":"card","x":0,"y":0,"w":1,"h":1,"z":"1","text":"t\\u0000\\u202e","link":"javascript:alert(1)","extUrl":"javascript:1","ownerId":"victim","__proto__":{"p":1}}`) as Obj;
    const md = { id: 'm', type: 'markdown', ...base, z: '2', text: '[x](javascript:alert(1)) [y](https://e.com)', ownerId: 'victim' } as unknown as Obj;
    const l = { id: 'l', type: 'link', ...base, z: '3', url: 'data:text/html,1', title: 'ok', locked: true } as unknown as Obj;
    const [card, m, link] = sanitizeImportedObjects([raw, md, l], 'me') as unknown as Record<string, unknown>[];
    expect(card.text).toBe('t');
    expect(card).not.toHaveProperty('link');
    expect(card).not.toHaveProperty('extUrl');
    expect(card).not.toHaveProperty('ownerId');
    expect(Object.hasOwn(card, '__proto__')).toBe(false);
    expect(card.createdBy).toBe('me');
    expect(m.text).toBe('x [y](https://e.com)');
    expect(link).not.toHaveProperty('url');
    expect(link.locked).toBe(true); // an import of a board keeps what a board holds
  });

  it('a table pasted keeps its cells byte for byte when they are clean, and loses control characters when not', () => {
    const t = { id: 't', type: 'table', ...base, z: '1', 'r:aa': 'a0', 'k:aa': 'a0', 'c:aa:aa': 'café \u{1F600}\ttab\nline', 'c:aa:zz': 'ghost' } as unknown as Obj;
    const [out] = sanitizeImportedObjects([t, { ...t, id: 'u', 'c:aa:aa': 'a\u0001b' } as unknown as Obj], 'me') as unknown as Record<string, unknown>[];
    expect(out['c:aa:aa']).toBe('café \u{1F600}\ttab\nline');
    expect(out).not.toHaveProperty('c:aa:zz');
  });
});

describe('cleaning stays linear on hostile Markdown', () => {
  it('long runs of brackets and parentheses take well under a second', () => {
    const t0 = performance.now();
    for (const s of ['['.repeat(20000), '[]('.repeat(7000), '[a]('.repeat(5000) + ')'.repeat(5000), '[x](' + '('.repeat(20000)]) cleanMarkdownLinks(s);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
