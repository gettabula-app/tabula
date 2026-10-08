import { describe, expect, it } from 'vitest';
import { resolveCssVars } from '../src/exporters';
import { objectMarkup, styleOf } from '../src/markup';
import type { BaseObj, ConnectorObj, Obj } from '../src/types';

const box = (id: string, x: number, y: number, w = 100, h = 60, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x, y, w, h, rotation: 0, z: 'a0', ...extra,
});

describe('theme-aware object defaults', () => {
  const a = box('a', 0, 0);
  const b = box('b', 300, 0);
  const get = (id: string) => [a, b].find((o) => o.id === id);
  const markup = (o: Obj) => objectMarkup(o, { get });
  const text = box('t', 0, 0, 240, 40, { type: 'text', text: 'Note' });
  const path = box('p', 0, 0, 100, 100, { type: 'path', points: [0, 0, 50, 50, 100, 20] });
  const icon = box('i', 0, 0, 48, 48, { type: 'icon', body: '<path fill="currentColor" d="M0 0h24v24H0z"/>', viewBox: [0, 0, 24, 24] });
  const link = { id: 'c', type: 'connector', z: 'a1', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' } as ConnectorObj;

  it('draws default text, paths, icons and connectors with the canvas ink variable', () => {
    expect(markup(text)).toContain('var(--canvas-ink');
    expect(markup(path)).toContain('var(--canvas-ink');
    expect(markup(icon)).toContain('var(--canvas-ink');
    expect(markup(link)).toContain('var(--canvas-ink');
  });

  it('resolves theme variables to their fallbacks for export', () => {
    const exported = [text, path, icon, link].map((o) => resolveCssVars(markup(o)));
    for (const svg of exported) {
      expect(svg).not.toContain('var(');
      expect(svg).toContain('#18212B');
    }
  });

  it('keeps connector labels dark on their white pill', () => {
    expect(markup({ ...link, label: 'Calls' })).toContain('fill="#18212B" text-anchor="middle"');
  });

  it('resolves frame colours to their fallbacks', () => {
    expect(resolveCssVars('fill="var(--graphite, #5B6672)" stroke="var(--canvas-rule,#C9D1DA)"')).toBe('fill="#5B6672" stroke="#C9D1DA"');
  });

  it('gives text objects a variable colour and shapes a literal one', () => {
    expect(styleOf(text).textColor).toBe('var(--canvas-ink, #18212B)');
    expect(styleOf(a).textColor).toBe('#18212B');
  });
});
