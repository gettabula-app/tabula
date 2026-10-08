import { describe, expect, it } from 'vitest';
import type { BaseObj, ConnectorObj, Obj } from '../src/types';
import { instantiate, validateContent, type CustomTemplate } from '../src/custom-templates';
import { CATEGORIES, CUSTOM_CATEGORY, TEMPLATES } from '../src/templates';
import { validateTemplate } from '../src/template-store';
import {
  builtinToCustom, copyName, duplicateTemplate, exportTemplateFile, parseTemplateFile, TEMPLATE_FILE_FORMAT,
} from '../src/template-file';

const sticky = (id: string, x: number, y: number, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'sticky', x, y, w: 100, h: 80, rotation: 0, z: id, text: id, ...extra,
});

function template(extra: Partial<CustomTemplate> = {}): CustomTemplate {
  const objects: Obj[] = [
    sticky('o1', 0, 0, { type: 'frame', w: 400, h: 300, name: 'Frame' }),
    sticky('o2', 20, 20, { parent: 'o1' }),
    sticky('o3', 200, 20, { parent: 'o1' }),
    {
      id: 'o4', type: 'connector', z: 'o4', route: 'straight', startHead: 'none', endHead: 'arrow',
      from: { kind: 'bound', id: 'o2', anchor: 'right' }, to: { kind: 'bound', id: 'o3', anchor: 'left' },
    } satisfies ConnectorObj,
  ];
  return {
    id: 'tpl1', version: 1, name: 'Weekly review', category: 'Planning', description: 'Look back, look ahead.',
    content: {
      objects,
      steps: [{ id: 's1', title: 'Write', instructions: 'Add notes.', mode: 'write', frameId: 'o1', durationSec: 300 }],
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      fonts: { heading: 'cabinet-grotesk', body: 'satoshi' },
    },
    createdBy: 'maker', createdAt: 1000, updatedAt: 2000,
    ...extra,
  };
}

const file = (patch: Record<string, unknown> = {}, t: CustomTemplate = template()) =>
  JSON.stringify({ format: TEMPLATE_FILE_FORMAT, version: 1, template: t, ...patch });

describe('exportTemplateFile and parseTemplateFile', () => {
  it('writes the format, the version and the template', () => {
    const parsed = JSON.parse(exportTemplateFile(template()));
    expect(parsed.format).toBe('tabula-template');
    expect(parsed.version).toBe(1);
    expect(parsed.template.name).toBe('Weekly review');
    expect(parsed.template.content.objects).toHaveLength(4);
  });

  it('round trips: same content, name, category and description, as a new template of the importer', () => {
    const t = template();
    const back = parseTemplateFile(exportTemplateFile(t), 'importer', 5000);
    expect(back.content).toEqual(t.content);
    expect(back.name).toBe(t.name);
    expect(back.category).toBe(t.category);
    expect(back.description).toBe(t.description);
    expect(back.id).not.toBe(t.id);
    expect(back.createdBy).toBe('importer');
    expect(back.createdAt).toBe(5000);
    expect(back.updatedAt).toBe(5000);
    expect(back.version).toBe(1);
    expect(() => validateTemplate(back)).not.toThrow();
  });

  it('gives every import a different id', () => {
    const text = exportTemplateFile(template());
    expect(parseTemplateFile(text, 'u').id).not.toBe(parseTemplateFile(text, 'u').id);
  });

  it('leaves out account-only fields', () => {
    const t = template({ scope: 'team', teamId: 't1' });
    expect(JSON.parse(exportTemplateFile(t)).template).not.toHaveProperty('scope');
    expect(parseTemplateFile(file({}, t), 'u')).not.toHaveProperty('teamId');
  });

  it('still makes a usable template: it can be placed on a board', () => {
    const back = parseTemplateFile(exportTemplateFile(template()), 'importer');
    const { objects, steps } = instantiate(back.content, { x: 0, y: 0 }, 'importer');
    expect(objects).toHaveLength(4);
    expect(steps[0].frameId).toBe(objects[0].id);
  });

  it('refuses to export a template that is not valid', () => {
    expect(() => exportTemplateFile(template({ name: '' }))).toThrow(/name/);
  });

  it('keeps the categories it knows and turns any other into Custom', () => {
    for (const category of [...CATEGORIES, CUSTOM_CATEGORY]) {
      expect(parseTemplateFile(file({}, template({ category })), 'u').category).toBe(category);
    }
    expect(parseTemplateFile(file({}, template({ category: 'Workshops' })), 'u').category).toBe(CUSTOM_CATEGORY);
  });

  it('takes a missing description as empty', () => {
    const raw = JSON.parse(file());
    delete raw.template.description;
    expect(parseTemplateFile(JSON.stringify(raw), 'u').description).toBe('');
  });

  describe('rejects', () => {
    it('text that is not JSON', () => {
      expect(() => parseTemplateFile('not json', 'u')).toThrow(/not valid JSON/);
      expect(() => parseTemplateFile('', 'u')).toThrow(/not valid JSON/);
    });

    it('JSON that is not a template file', () => {
      for (const text of ['[]', 'null', '42', '{}', '{"objects":[]}']) {
        expect(() => parseTemplateFile(text, 'u')).toThrow(/not a Tabula template file/);
      }
    });

    it('a board file or another format', () => {
      expect(() => parseTemplateFile(file({ format: 'driftboard' }), 'u')).toThrow(/not a Tabula template file/);
      expect(() => parseTemplateFile(JSON.stringify({ driftboard: 1, objects: [] }), 'u')).toThrow(/not a Tabula template file/);
    });

    it('a version other than 1', () => {
      expect(() => parseTemplateFile(file({ version: 2 }), 'u')).toThrow(/newer version/);
      expect(() => parseTemplateFile(file({ version: 0 }), 'u')).toThrow(/unknown format version/);
      expect(() => parseTemplateFile(file({ version: '1' }), 'u')).toThrow(/unknown format version/);
      const raw = JSON.parse(file());
      delete raw.version;
      expect(() => parseTemplateFile(JSON.stringify(raw), 'u')).toThrow(/unknown format version/);
    });

    it('a file with no template', () => {
      expect(() => parseTemplateFile(file({ template: null }), 'u')).toThrow(/holds no template/);
      expect(() => parseTemplateFile(file({ template: [] }), 'u')).toThrow(/holds no template/);
      const raw = JSON.parse(file());
      delete raw.template;
      expect(() => parseTemplateFile(JSON.stringify(raw), 'u')).toThrow(/holds no template/);
    });

    it('a name or category that is empty or too long', () => {
      expect(() => parseTemplateFile(file({}, template({ name: '  ' })), 'u')).toThrow(/name/);
      expect(() => parseTemplateFile(file({}, template({ name: 'x'.repeat(81) })), 'u')).toThrow(/name/);
      expect(() => parseTemplateFile(file({}, template({ description: 'x'.repeat(281) })), 'u')).toThrow(/description/);
    });

    it('content that is not valid', () => {
      const bad = template();
      bad.content.objects.push({ ...sticky('o9', 0, 0), type: 'bogus' } as unknown as Obj);
      expect(() => parseTemplateFile(file({}, bad), 'u')).toThrow(/unknown type/);

      const dangling = template();
      (dangling.content.objects[3] as ConnectorObj).to = { kind: 'bound', id: 'gone', anchor: 'auto' };
      expect(() => parseTemplateFile(file({}, dangling), 'u')).toThrow(/missing object/);

      const noSteps = JSON.parse(file());
      delete noSteps.template.content.steps;
      expect(() => parseTemplateFile(JSON.stringify(noSteps), 'u')).toThrow(/steps/);

      const stepAway = template();
      stepAway.content.steps[0].frameId = 'nowhere';
      expect(() => parseTemplateFile(file({}, stepAway), 'u')).toThrow(/frame/);
    });

    it('content over the object limit, and files over the size limit', () => {
      const big = template();
      big.content.objects = Array.from({ length: 2001 }, (_, i) => sticky(`b${i}`, i, 0));
      expect(() => parseTemplateFile(file({}, big), 'u')).toThrow(/at most 2000 objects/);
      expect(() => parseTemplateFile(' '.repeat(2_000_001), 'u')).toThrow(/too large/);
    });

    it('a template whose content has a bad structure', () => {
      expect(() => parseTemplateFile(file({ template: { ...template(), content: 'nope' } }), 'u')).toThrow(/content/);
    });
  });
});

describe('duplicateTemplate', () => {
  it('keeps the content and gets a new id, name and dates', () => {
    const t = template();
    const copy = duplicateTemplate(t, 'me', 9000);
    expect(copy.content).toEqual(t.content);
    expect(copy.id).not.toBe(t.id);
    expect(copy.name).toBe('Weekly review (copy)');
    expect(copy.category).toBe('Planning');
    expect(copy.description).toBe(t.description);
    expect(copy.createdBy).toBe('me');
    expect(copy.createdAt).toBe(9000);
    expect(copy.updatedAt).toBe(9000);
    expect(() => validateTemplate(copy)).not.toThrow();
  });

  it('shares nothing with the original', () => {
    const t = template();
    const copy = duplicateTemplate(t, 'me');
    expect(copy.content).not.toBe(t.content);
    expect(copy.content.objects[0]).not.toBe(t.content.objects[0]);
    copy.content.objects[1].x = 999;
    expect(t.content.objects[1].x).toBe(20);
    expect(t.name).toBe('Weekly review');
    expect(t.updatedAt).toBe(2000);
  });

  it('keeps a long name within the limit', () => {
    const copy = duplicateTemplate(template({ name: 'n'.repeat(80) }), 'me');
    expect(copy.name).toBe(`${'n'.repeat(73)} (copy)`);
    expect(copy.name.length).toBe(80);
    expect(() => validateTemplate(copy)).not.toThrow();
  });
});

describe('copyName', () => {
  it('adds (copy) and cuts a name that would go over 80 characters', () => {
    expect(copyName('Retro')).toBe('Retro (copy)');
    expect(copyName('Retro (copy)')).toBe('Retro (copy) (copy)');
    expect(copyName('x'.repeat(78))).toHaveLength(80);
    expect(copyName(`${'x'.repeat(72)}  tail`)).toBe(`${'x'.repeat(72)} (copy)`);
  });
});

describe('builtinToCustom', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('turns %s into a valid personal template', (_id, def) => {
    const t = builtinToCustom(def, 'me', 7000);
    expect(() => validateTemplate(t)).not.toThrow();
    expect(() => validateContent(t.content)).not.toThrow();
    expect(t.name).toBe(copyName(def.name));
    expect(t.category).toBe(def.category);
    expect(t.description).toBe(def.description);
    expect(t.createdBy).toBe('me');
    expect(t.createdAt).toBe(7000);
    expect(t.content.objects.length).toBeGreaterThan(0);
    expect(t.content.steps.length).toBeGreaterThan(0);
    expect(t.content.bounds.x).toBe(0);
    expect(t.content.bounds.y).toBe(0);
    expect(t.content.fonts).toEqual({ heading: 'cabinet-grotesk', body: 'satoshi' });
    const ids = new Set(t.content.objects.map((o) => o.id));
    expect(t.content.steps.flatMap((s) => (s.frameId ? [ids.has(s.frameId)] : []))).not.toContain(false);
  });

  it('gives each call a different id and leaves no undefined fields', () => {
    const def = TEMPLATES[0];
    expect(builtinToCustom(def, 'me').id).not.toBe(builtinToCustom(def, 'me').id);
    expect(JSON.stringify(builtinToCustom(def, 'me').content)).not.toContain('undefined');
    const content = builtinToCustom(def, 'me').content;
    expect(Object.values(content.objects[0]).includes(undefined)).toBe(false);
  });
});
