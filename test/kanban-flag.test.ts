import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardApp } from '../src/app';
import { kanbanFlag } from '../src/flags';
import { shapesTab } from '../src/ui/library';
import { FakeElement, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// The kanban flag (src/flags.ts): without `?kanban` or localStorage `driftboard:flag:kanban` = 1 the Shapes drawer has no
// Boards heading and no Kanban tile. The app side (the tool, Make kanban, loose cards) is in test/kanban-app.test.ts.

let browser: FakeBrowser;
let stored: Map<string, string>;
beforeEach(() => {
  browser = installFakeBrowser();
  stored = new Map();
  vi.stubGlobal('location', { ...browser.location, search: '' });
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem() {}, removeItem() {} });
});
afterEach(() => browser.uninstall());

const app = () => ({ readOnly: false, tool: { kind: 'select' }, setTool: vi.fn<() => void>() }) as unknown as BoardApp;
const drawer = () => shapesTab(app(), () => {}) as unknown as FakeElement;
const hasKanban = (el: FakeElement) => el.querySelectorAll('button').some((b) => b.getAttribute('aria-label') === 'Kanban');

describe('kanbanFlag', () => {
  it('is off by default, and when storage cannot be read', () => {
    expect(kanbanFlag()).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(kanbanFlag()).toBe(false);
  });
  it('is on with ?kanban in the URL', () => {
    vi.stubGlobal('location', { search: '?debug&kanban' });
    expect(kanbanFlag()).toBe(true);
  });
  it('is on with driftboard:flag:kanban = 1, and only 1', () => {
    stored.set('driftboard:flag:kanban', 'yes');
    expect(kanbanFlag()).toBe(false);
    stored.set('driftboard:flag:kanban', '1');
    expect(kanbanFlag()).toBe(true);
  });
});

describe('the Shapes drawer', () => {
  it('has no Boards heading and no Kanban tile without the flag', () => {
    const el = drawer();
    expect(hasKanban(el)).toBe(false);
    expect(textOf(el)).not.toContain('Boards');
  });
  it('has both with the flag', () => {
    stored.set('driftboard:flag:kanban', '1');
    const el = drawer();
    expect(hasKanban(el)).toBe(true);
    expect(textOf(el)).toContain('Boards');
  });
});
