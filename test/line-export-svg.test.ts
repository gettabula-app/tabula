import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BoardApp } from '../src/app';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

// TAB lines: a line is a connector with free ends, so the SVG export, the .drift/JSON export and print draw it as a stroked path
// with its width and dash and no arrowhead, and keep line:true.
let browser: FakeBrowser | undefined;
afterEach(() => {
  browser?.uninstall();
  browser = undefined;
});

function appWithLine(over: Record<string, unknown> = {}): BoardApp {
  const store = new Store(new Y.Doc());
  store.transact(() => {
    store.create({
      id: 'ln', type: 'connector', z: 'a0', from: { kind: 'free', x: 10, y: 10 }, to: { kind: 'free', x: 310, y: 130 },
      route: 'straight', startHead: 'none', endHead: 'none', strokeWidth: 3, dash: 'dashed', line: true, ...over,
    } as never);
  });
  return {
    store,
    conn: { comments: { list: () => [] } },
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    images: { blobOf: async () => null },
    r: { contentBounds: () => ({ x: 0, y: 0, w: 320, h: 140 }), ctx: { get: (id: string) => store.getPlaced(id), layout: () => new Map() } },
  } as unknown as BoardApp;
}

describe('exporting a line', () => {
  it('draws the SVG export as a dashed 3px stroke with no arrowhead', async () => {
    browser = installFakeBrowser();
    const exporters = await import('../src/exporters');
    const { svg } = exporters.exportSvg(appWithLine());
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toMatch(/stroke-dasharray="[^"]+"/);
    expect(svg).not.toContain('marker-end');
    expect(svg).not.toContain('marker-start');
  });

  it('draws an arrowhead only when one is chosen', async () => {
    browser = installFakeBrowser();
    const exporters = await import('../src/exporters');
    const plain = exporters.exportSvg(appWithLine()).svg;
    const arrow = exporters.exportSvg(appWithLine({ endHead: 'arrow' })).svg;
    expect(arrow.length).toBeGreaterThan(plain.length);
  });

  it('keeps line:true and the free ends in the JSON export', async () => {
    browser = installFakeBrowser();
    const exporters = await import('../src/exporters');
    const json = exporters.toJson(appWithLine(), undefined, []);
    const line = json.objects.find((o) => o.id === 'ln') as unknown as { line?: boolean; from: { kind: string }; to: { kind: string } };
    expect(line.line).toBe(true);
    expect([line.from.kind, line.to.kind]).toEqual(['free', 'free']);
  });
});
