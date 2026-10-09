import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import type { Id, Obj } from '../src/types';

class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {}, remove() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  attrs = new Map<string, string>();
  private html = '';
  get innerHTML() { return this.html; }
  set innerHTML(value: string) { this.html = value; }
  append() {}
  appendChild() {}
  insertBefore() {}
  remove() {}
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  querySelector() { return new FakeEl(); }
  getBoundingClientRect() { return { width: 1600, height: 1200, left: 0, top: 0 }; }
  getContext() { return null; }
}

const group = (id: Id, z: string, parent?: Id, locked = false): Obj => ({
  id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z, parent, locked: locked || undefined,
});
const sticky = (id: Id, z: string, parent: Id, x: number): Obj => ({
  id, type: 'sticky', x, y: 20, w: 80, h: 60, rotation: 0, z, parent, text: id,
});

function expectThemePaints(out: string) {
  const paints = [...out.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1]);
  expect(paints.filter((paint) => paint !== 'none' && !/^var\(--[\w-]+\)$/.test(paint))).toEqual([]);
}

describe('group renderer overlays', () => {
  let store: Store;
  let renderer: Renderer;
  const drawOverlay = () => (renderer as unknown as { renderOverlay(): void }).renderOverlay();
  const svg = () => (renderer as unknown as { overlayLayer: FakeEl }).overlayLayer.innerHTML;
  const dimPath = () => (renderer as unknown as { groupDimPath: FakeEl }).groupDimPath;

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(group('outer', 'a0', undefined, true));
      store.create(group('g', 'a1', 'outer'));
      store.create(sticky('a', 'a2', 'g', 10));
      store.create(sticky('b', 'a3', 'g', 120));
      store.create(group('nested', 'a4', 'g'));
      store.create(sticky('c', 'a5', 'nested', 230));
    });
    renderer = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  });

  afterEach(() => {
    renderer.destroy();
    vi.unstubAllGlobals();
  });

  it('draws a selected group body and member outlines with theme tokens only', () => {
    renderer.setOverlay({ selection: ['g'] });
    drawOverlay();
    const out = svg();
    expect(out).toContain('stroke="var(--group-member-line)"');
    expect(out).toContain('stroke="var(--group-line)"');
    expect(out).toContain('stroke-width="1.5"');
    expect(out).not.toContain('#');
    expect(out).not.toContain('#2F6FED');
  });

  it('uses the group hover, entered, and dim tokens in their overlays', () => {
    renderer.setOverlay({ hover: 'g' });
    drawOverlay();
    expect(svg()).toContain('stroke="var(--group-hover)"');
    expect(svg()).not.toContain('#');

    renderer.setOverlay({ hover: null, enteredGroup: 'g' });
    drawOverlay();
    expect(svg()).toContain('stroke="var(--group-line)"');
    expect(svg()).toContain('stroke-dasharray="6 4"');
    expect(dimPath().getAttribute('fill')).toBe('var(--group-dim)');
    expect(dimPath().getAttribute('class')).toBe('group-dim-wash active');
    expect(dimPath().getAttribute('fill-rule')).toBe('evenodd');
    const dimD = dimPath().getAttribute('d') ?? '';
    expect(svg()).toContain('stroke="var(--canvas)" stroke-opacity="0.8" stroke-width="3"');
    expect(dimD).toContain('M10 20h80v60h-80z');
    expect(dimD).toContain('M120 20h80v60h-80z');
    expect(dimD).toContain('M230 20h80v60h-80z');
    expect(dimD).not.toContain('M10 20h300v60h-300z');
    expect(`${svg()}${dimPath().getAttribute('fill')}${dimD}`).not.toContain('#');
  });

  it('uses the same theme-aware hover color for a single item', () => {
    renderer.setOverlay({ hover: 'a' });
    drawOverlay();
    expect(svg()).toContain('stroke="var(--group-hover)"');
    expect(svg()).not.toContain('#');
  });

  it('uses theme tokens for single-item selection outlines and handles', () => {
    renderer.setOverlay({ selection: ['a'] });
    drawOverlay();
    const out = svg();
    expect(out).toContain('stroke="var(--wire)"');
    expect(out).toContain('stroke="var(--selection-handle-stroke)"');
    expect(out).toContain('fill="var(--selection-handle-fill)"');
    expectThemePaints(out);
  });

  it('uses theme tokens for connection anchors', () => {
    renderer.setOverlay({ anchorsFor: 'a', anchorHot: 'a:top' });
    drawOverlay();
    const out = svg();
    expect(out).toContain('fill="var(--wire)"');
    expect(out).toContain('fill="var(--selection-handle-fill)"');
    expect(out).toContain('stroke="var(--wire)"');
    expectThemePaints(out);
  });

  it('lifts a lock hover to the outermost locked group and uses the tray badge tokens', () => {
    renderer.setOverlay({ enteredGroup: null, lockedHover: 'a' });
    drawOverlay();
    const out = svg();
    expect(out).toContain('stroke="var(--group-locked)"');
    expect(out).toContain('fill="var(--group-chip-bg)"');
    expect(out).toContain('stroke="var(--group-chip-ink)"');
    expect(out).not.toContain('#');
  });
});
