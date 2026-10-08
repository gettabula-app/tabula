import { describe, expect, it } from 'vitest';
import { Builder, CATEGORIES, TEMPLATES } from '../src/templates';
import { validateContent } from '../src/custom-templates';
import { builtinToCustom } from '../src/template-file';
import { validateTemplateContent, TEMPLATE_CATEGORIES } from '../server/templates.mjs';
import type { BaseObj } from '../src/types';

const host = { user: { id: 'u1' }, store: { getMeta: () => ({ bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' }) } };
const NEW = ['business-model-canvas', 'lean-canvas', 'service-blueprint', 'design-sprint'];

function build(id: string) {
  const def = TEMPLATES.find((t) => t.id === id)!;
  const b = new Builder(host, 0, 0);
  def.build(b);
  return { def, b };
}

describe('built-in templates (TAB-150)', () => {
  it('lists the four new templates once each, in known categories', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of NEW) {
      const def = TEMPLATES.find((t) => t.id === id)!;
      expect(def).toBeTruthy();
      expect(CATEGORIES).toContain(def.category);
      expect(TEMPLATE_CATEGORIES).toContain(def.category);
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it.each(NEW)('%s has frames, prompts and steps that point at real frames', (id) => {
    const { b } = build(id);
    const objs = b.objs as BaseObj[];
    const frames = new Set(objs.filter((o) => o.type === 'frame').map((o) => o.id));
    expect(frames.size).toBeGreaterThanOrEqual(5);
    expect(b.steps.length).toBeGreaterThanOrEqual(5);
    for (const s of b.steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.instructions.length).toBeGreaterThan(0);
      expect(!s.frameId || frames.has(s.frameId), `${s.title} -> frame`).toBe(true);
      expect(s.durationSec ?? 1).toBeGreaterThan(0);
    }
    for (const o of objs) expect(!o.parent || frames.has(o.parent)).toBe(true);
  });

  it.each(NEW)('%s keeps every child inside its parent frame', (id) => {
    const { b } = build(id);
    const byId = new Map((b.objs as BaseObj[]).map((o) => [o.id, o]));
    for (const o of (b.objs as BaseObj[]).filter((x) => x.parent)) {
      const p = byId.get(o.parent!)!;
      expect(o.x, `${o.text ?? o.name} x`).toBeGreaterThanOrEqual(p.x);
      expect(o.y, `${o.text ?? o.name} y`).toBeGreaterThanOrEqual(p.y);
      expect(o.x + o.w, `${o.text ?? o.name} right`).toBeLessThanOrEqual(p.x + p.w + 1);
      expect(o.y + o.h, `${o.text ?? o.name} bottom`).toBeLessThanOrEqual(p.y + p.h + 1);
    }
  });

  it.each(NEW)('%s passes the client and the server validators', (id) => {
    const { def } = build(id);
    const content = builtinToCustom(def, 'u1').content;
    expect(() => validateContent(JSON.parse(JSON.stringify(content)))).not.toThrow();
    expect(() => validateTemplateContent(JSON.parse(JSON.stringify(content)))).not.toThrow();
    expect(def.name.length).toBeLessThanOrEqual(80);
  });

  it('the Business Model Canvas and the Lean Canvas have the nine blocks', () => {
    const names = (id: string) => (build(id).b.objs as BaseObj[]).filter((o) => o.type === 'frame' && o.parent).map((o) => o.name);
    expect(names('business-model-canvas')).toEqual(expect.arrayContaining(['Key partners', 'Key activities', 'Key resources', 'Value propositions', 'Customer relationships', 'Channels', 'Customer segments', 'Cost structure', 'Revenue streams']));
    expect(names('lean-canvas')).toEqual(expect.arrayContaining(['Problem', 'Solution', 'Key metrics', 'Unique value proposition', 'Unfair advantage', 'Channels', 'Customer segments', 'Cost structure', 'Revenue streams']));
    expect(names('business-model-canvas')).toHaveLength(9);
    expect(names('lean-canvas')).toHaveLength(9);
  });

  it('canvas blocks do not overlap', () => {
    for (const id of ['business-model-canvas', 'lean-canvas']) {
      const fr = (build(id).b.objs as BaseObj[]).filter((o) => o.type === 'frame' && o.parent);
      for (let i = 0; i < fr.length; i++) for (let j = i + 1; j < fr.length; j++) {
        const a = fr[i], c = fr[j];
        const overlap = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
        expect(overlap, `${a.name} / ${c.name}`).toBe(false);
      }
    }
  });
});
