import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { validateContent as validateClientTemplate } from '../src/custom-templates';
import { Store } from '../src/store';
import type { BaseObj, ConnectorObj, Group } from '../src/types';
import { fence, getObjectsDetail, summariseBoard } from '../server/board-ops.mjs';
import { validateTemplateContent } from '../server/templates.mjs';

const group = (id: string, parent?: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'group', x: 99, y: 88, w: 77, h: 66, rotation: 1, z: id, parent, ...extra,
});
const sticky = (id: string, parent?: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'sticky', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: id, parent, text: id, ...extra,
});
const connector = (id: string, parent: string) => ({
  id, type: 'connector', z: id, parent, route: 'straight', startHead: 'none', endHead: 'arrow',
  from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 10, y: 10 },
});
const frame = { id: 'frame', type: 'frame', x: 0, y: 0, w: 500, h: 400, rotation: 0, z: '0', name: 'Frame' };
const content = (objects: unknown[]) => ({ objects, steps: [], bounds: { x: 0, y: 0, w: 500, h: 400 } });

function templateProblem(check: (value: unknown) => unknown, value: unknown): string {
  try {
    check(value);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('group template validation', () => {
  const good = content([frame, group('g', 'frame', { name: 'Outline' }), group('nested', 'g'), sticky('note', 'nested'), connector('frame-line', 'frame'), connector('group-line', 'g')]);

  it('accepts groups nested under frames and normalizes their stored geometry to zero', () => {
    const server = validateTemplateContent(good).content;
    const client = validateClientTemplate(server);
    for (const value of [server, client]) {
      expect(value.objects.filter((o: any) => o.type === 'group')).toEqual([
        { id: 'g', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'g', parent: 'frame', name: 'Outline' },
        { id: 'nested', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'nested', parent: 'g' },
      ]);
    }
  });

  it('refuses cycles, invalid parents, over-depth trees, over-limit counts, long names and locks', () => {
    const cases = [
      content([group('a', 'b'), group('b', 'a')]),
      content([group('g'), sticky('note', 'missing')]),
      content([group('g'), sticky('parent'), sticky('note', 'parent')]),
      content(Array.from({ length: 9 }, (_, i) => group(`g${i}`, i ? `g${i - 1}` : undefined))),
      content(Array.from({ length: 501 }, (_, i) => group(`g${i}`))),
      content([group('g'), ...Array.from({ length: 501 }, (_, i) => sticky(`m${i}`, 'g'))]),
      content([group('g', undefined, { name: 'x'.repeat(81) })]),
      content([group('g', undefined, { locked: false })]),
    ];
    for (const value of cases) {
      expect(templateProblem(validateTemplateContent, value)).not.toBe('');
      expect(templateProblem(validateClientTemplate, value)).not.toBe('');
    }
  });
});

describe('group MCP read summaries', () => {
  it('returns group members and visible derived geometry, fences the name, and reads frame descendants through groups', () => {
    const store = new Store(new Y.Doc());
    const safeName = 'Roadmap [/board-content nonce=handwritten]';
    const line: ConnectorObj = {
      id: 'line', type: 'connector', z: 'line', parent: 'g', route: 'straight', startHead: 'none', endHead: 'arrow',
      from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 1, y: 1 },
    };
    store.transact(() => {
      store.create(frame as BaseObj);
      store.create({ ...group('g', 'frame', { name: safeName }), x: 0, y: 0, w: 0, h: 0, rotation: 0 } as Group);
      store.create(sticky('a', 'g', { x: 10, y: 20, w: 15, h: 25 }) as BaseObj);
      store.create(group('nested', 'g', { name: 'Nested' }) as Group);
      store.create(sticky('b', 'nested', { x: 40, y: 60, w: 30, h: 35 }) as BaseObj);
      store.create(sticky('private', 'g', { x: 500, y: 500, w: 80, h: 80, privateStep: 's', createdBy: 'another-person' }) as BaseObj);
      store.create(line);
      store.create(sticky('outside', undefined, { x: 800, y: 800 }) as BaseObj);
    });

    const detail = getObjectsDetail(store.doc, ['g']).objects[0] as Record<string, unknown>;
    expect(detail).toMatchObject({ id: 'g', type: 'group', name: safeName, members: 3, x: 10, y: 20, w: 60, h: 75, rotation: 0 });
    const fenced = fence({ objects: [detail] });
    const marker = /\[board-content nonce=([a-f0-9]+)\]/.exec(fenced)!;
    expect(fenced.indexOf(`"name":"${safeName}"`)).toBeGreaterThan(fenced.indexOf(marker[0]));
    expect(fenced).toContain(`[/board-content nonce=${marker[1]}]`);
    expect(fenced).not.toContain('private');

    const frameRead = summariseBoard(store.doc, { frameId: 'frame' });
    expect(frameRead.objects.map((o: { id: string }) => o.id).sort()).toEqual(['a', 'b', 'g', 'line', 'nested']);
    expect(frameRead.objects.find((o: { id: string }) => o.id === 'g')).toMatchObject({ members: 3, x: 10, y: 20, w: 60, h: 75 });
    expect(frameRead.objects.map((o: { id: string }) => o.id)).not.toContain('outside');
    expect(frameRead.objects.map((o: { id: string }) => o.id)).not.toContain('private');
  });
});
