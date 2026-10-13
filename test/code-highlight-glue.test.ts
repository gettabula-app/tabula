import { describe, expect, it } from 'vitest';
import { createCodeHighlightGlue, GLUE_TEXT_DEBOUNCE_MS, type GlueDeps } from '../src/code-highlight-glue';
import type { CodeLines } from '../src/code-tokens';
import type { BaseObj } from '../src/types';
import type { HighlightRequest } from '../src/code-highlight';

// The glue with a fake highlighter, a fake clock and a fake idle scheduler: what it asks for, when, and what it lets the drawing code see.

function rig() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  let idleQ: Array<{ id: number; fn: () => void }> = [];
  let nextIdle = 1;
  const objs = new Map<string, BaseObj>();
  let theme = 'default';
  let vp = { x: 0, y: 0, w: 1000, h: 800 };
  let editing: string | null = null;
  const listeners = { camera: new Set<() => void>(), theme: new Set<() => void>(), objects: new Set<(ids: ReadonlySet<string>) => void>(), editing: new Set<() => void>() };
  const requests: Array<HighlightRequest & { resolve: (l: CodeLines | null) => void }> = [];
  let source: ((o: BaseObj) => CodeLines | null) | null = null;
  let repaints = 0;
  const deps: GlueDeps = {
    objects: () => objs.values(),
    viewport: () => vp,
    themeId: () => theme,
    editingId: () => editing,
    highlight: (req) => new Promise((resolve) => { requests.push({ ...req, resolve }); }),
    repaint: () => { repaints++; },
    setTokenSource: (fn) => { source = fn; },
    onCamera: (fn) => { listeners.camera.add(fn); return () => listeners.camera.delete(fn); },
    onTheme: (fn) => { listeners.theme.add(fn); return () => listeners.theme.delete(fn); },
    onObjects: (fn) => { listeners.objects.add(fn); return () => listeners.objects.delete(fn); },
    onEditing: (fn) => { listeners.editing.add(fn); return () => listeners.editing.delete(fn); },
    now: () => t,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    idle: (fn) => { const id = nextIdle++; idleQ.push({ id, fn }); return () => { idleQ = idleQ.filter((x) => x.id !== id); }; },
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  /** Advances the clock, firing timers in order, running idle callbacks after each, and letting promises settle. */
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
      while (idleQ.length) idleQ.shift()!.fn();
      await flush();
    }
    t = end;
    while (idleQ.length) idleQ.shift()!.fn();
    await flush();
  };
  const code = (id: string, extra: Record<string, unknown> = {}): BaseObj => ({ id, type: 'code', x: 0, y: 0, w: 400, h: 100, rotation: 0, z: 1, lang: 'ts', text: `const ${id} = 1;`, ...extra } as unknown as BaseObj);
  const add = (o: BaseObj) => { objs.set(o.id, o); listeners.objects.forEach((l) => l(new Set([o.id]))); };
  const change = (id: string, patch: Record<string, unknown>) => { objs.set(id, { ...objs.get(id)!, ...patch } as BaseObj); listeners.objects.forEach((l) => l(new Set([id]))); };
  const lines = (o: BaseObj): CodeLines => [[{ t: (o as unknown as { text: string }).text, c: '#123456' }]];
  const answer = async (i: number) => { const r = requests[i]; r.resolve([[{ t: r.text, c: '#123456' }]]); await flush(); };
  return {
    deps, objs, requests, code, add, change, advance, answer, lines, listeners, timers,
    get source() { return source!; },
    get repaints() { return repaints; },
    get idle() { return idleQ.length; },
    setTheme(id: string) { theme = id; listeners.theme.forEach((l) => l()); },
    setVp(v: typeof vp) { vp = v; listeners.camera.forEach((l) => l()); },
    setEditing(id: string | null) { editing = id; listeners.editing.forEach((l) => l()); },
  };
}

describe('code highlight glue', () => {
  it('asks only for blocks in or near the viewport, one at a time, nearest first', async () => {
    const r = rig();
    r.objs.set('far', r.code('far', { x: 5000, y: 5000 }));
    r.objs.set('near', r.code('near', { x: 1200, y: 100 }));
    r.objs.set('in', r.code('in', { x: 100, y: 100 }));
    createCodeHighlightGlue(r.deps);
    await r.advance(200);
    expect(r.requests.map((q) => q.text)).toEqual(['const in = 1;']);
    await r.answer(0);
    await r.advance(200);
    expect(r.requests.map((q) => q.text)).toEqual(['const in = 1;', 'const near = 1;']);
    await r.answer(1);
    await r.advance(500);
    expect(r.requests).toHaveLength(2);
    // panning brings the far one in range
    r.setVp({ x: 4500, y: 4500, w: 1000, h: 800 });
    await r.advance(300);
    expect(r.requests.at(-1)!.text).toBe('const far = 1;');
  });

  it('never has two requests in flight', async () => {
    const r = rig();
    for (const id of ['a', 'b', 'c']) r.objs.set(id, r.code(id));
    createCodeHighlightGlue(r.deps);
    await r.advance(500);
    expect(r.requests).toHaveLength(1);
    await r.answer(0);
    await r.advance(50);
    expect(r.requests).toHaveLength(2);
    await r.answer(1);
    await r.advance(50);
    expect(r.requests).toHaveLength(3);
  });

  it('answers from the cache only for the exact lang, theme and text', async () => {
    const r = rig();
    const o = r.code('a');
    r.objs.set('a', o);
    createCodeHighlightGlue(r.deps);
    expect(r.source(o)).toBeNull();
    await r.advance(200);
    await r.answer(0);
    expect(r.source(o)).not.toBeNull();
    expect(r.repaints).toBe(1);
    expect(r.source({ ...o, text: 'other' } as BaseObj)).toBeNull();
    expect(r.source({ ...o, lang: 'js' } as BaseObj)).toBeNull();
    r.setTheme('ayu');
    expect(r.source(o)).toBeNull();
  });

  it('waits 250 ms after a text change, and not while the block is being edited', async () => {
    const r = rig();
    r.objs.set('a', r.code('a'));
    createCodeHighlightGlue(r.deps);
    await r.advance(200);
    await r.answer(0);
    r.setEditing('a');
    r.change('a', { text: 'let x' });
    await r.advance(GLUE_TEXT_DEBOUNCE_MS + 400);
    expect(r.requests).toHaveLength(1);
    expect(r.source(r.objs.get('a')!)).toBeNull();
    r.setEditing(null);
    await r.advance(300);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1].text).toBe('let x');
    // typing again restarts the wait
    await r.answer(1);
    r.change('a', { text: 'let xy' });
    await r.advance(200);
    r.change('a', { text: 'let xyz' });
    await r.advance(200);
    expect(r.requests).toHaveLength(2);
    await r.advance(200);
    expect(r.requests).toHaveLength(3);
    expect(r.requests[2].text).toBe('let xyz');
  });

  it('drops a result whose text changed meanwhile and asks again for the new text', async () => {
    const r = rig();
    r.objs.set('a', r.code('a'));
    createCodeHighlightGlue(r.deps);
    await r.advance(200);
    expect(r.requests).toHaveLength(1);
    r.change('a', { text: 'changed' });
    await r.answer(0);
    expect(r.source(r.objs.get('a')!)).toBeNull();
    expect(r.repaints).toBe(0);
    await r.advance(600);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1].text).toBe('changed');
    await r.answer(1);
    expect(r.source(r.objs.get('a')!)).not.toBeNull();
  });

  it('re-requests the visible blocks on a theme change, with the new theme', async () => {
    const r = rig();
    r.objs.set('a', r.code('a'));
    createCodeHighlightGlue(r.deps);
    await r.advance(200);
    await r.answer(0);
    expect(r.requests[0].theme).toBe('default');
    const before = r.repaints;
    r.setTheme('matrix');
    expect(r.repaints).toBe(before + 1);
    await r.advance(300);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1].theme).toBe('matrix');
  });

  it('never asks for plain text, empty text, unknown languages or text over 20,000 characters', async () => {
    const r = rig();
    r.objs.set('p', r.code('p', { lang: 'plaintext' }));
    r.objs.set('e', r.code('e', { text: '' }));
    r.objs.set('u', r.code('u', { lang: 'cobol' }));
    r.objs.set('l', r.code('l', { text: 'x'.repeat(20_001) }));
    createCodeHighlightGlue(r.deps);
    await r.advance(1000);
    expect(r.requests).toHaveLength(0);
    r.add(r.code('ok'));
    await r.advance(300);
    expect(r.requests).toHaveLength(1);
  });

  it('does not ask again for a key that was answered with null', async () => {
    const r = rig();
    r.objs.set('a', r.code('a'));
    createCodeHighlightGlue(r.deps);
    await r.advance(200);
    r.requests[0].resolve(null);
    await r.advance(2000);
    expect(r.requests).toHaveLength(1);
    expect(r.source(r.objs.get('a')!)).toBeNull();
    r.setTheme('ayu');
    await r.advance(300);
    expect(r.requests).toHaveLength(2);
  });

  it('asks for a block that is added, and forgets one that is deleted', async () => {
    const r = rig();
    createCodeHighlightGlue(r.deps);
    await r.advance(300);
    expect(r.requests).toHaveLength(0);
    const o = r.code('n');
    r.add(o);
    await r.advance(300);
    expect(r.requests).toHaveLength(1);
    await r.answer(0);
    r.objs.delete('n');
    r.listeners.objects.forEach((l) => l(new Set(['n'])));
    expect(r.source(o)).toBeNull();
  });

  it('keeps the cache bounded', async () => {
    const r = rig();
    for (let i = 0; i < 230; i++) r.objs.set(`b${i}`, r.code(`b${i}`));
    createCodeHighlightGlue(r.deps);
    for (let i = 0; i < 230; i++) {
      await r.advance(120);
      if (!r.requests[i]) break;
      await r.answer(i);
    }
    const shown = [...r.objs.values()].filter((o) => r.source(o)).length;
    expect(shown).toBeLessThanOrEqual(200);
    expect(shown).toBeGreaterThan(150);
  });

  it('stop() clears timers, listeners, the idle callback and the token source', async () => {
    const r = rig();
    r.objs.set('a', r.code('a'));
    const stop = createCodeHighlightGlue(r.deps);
    await r.advance(10);
    r.setVp({ x: 1, y: 1, w: 1000, h: 800 });
    stop();
    expect(r.timers.size).toBe(0);
    expect(r.idle).toBe(0);
    expect(r.listeners.camera.size + r.listeners.theme.size + r.listeners.objects.size + r.listeners.editing.size).toBe(0);
    expect(r.source).toBeNull();
    await r.advance(2000);
    expect(r.requests.length).toBeLessThanOrEqual(1);
    // a request that was in flight does not repaint after stop
    const repaints = r.repaints;
    if (r.requests[0]) await r.answer(0);
    expect(r.repaints).toBe(repaints);
  });
});
