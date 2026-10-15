import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';
import { boardCard, editedLine, menuActionsFor, templateCard, type BoardCardData } from '../src/ui/board-card';
import type { PreviewModel } from '../src/ui/board-preview';

// TAB-375 slice 2: the board card and its line of text, the role rules of the ⋯ menu, the previews switch and the first-run template
// card. The popover itself is not driven here (it needs the layout); the menu's actions are a pure list.

const NOW = new Date(2026, 9, 15, 12, 0).getTime();
let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  browser.uninstall();
});

const asEl = (node: unknown) => node as FakeElement;
const base = (over: Partial<BoardCardData> = {}): BoardCardData => ({ id: 'q4', name: 'Q4 roadmap', updatedAt: NOW - 12 * 60_000, ...over });
const one: PreviewModel = { shapes: [{ t: 'card', x: 0, y: 0, w: 10, h: 10 }] };

describe('editedLine', () => {
  it('names the person and how long ago', () => {
    expect(editedLine(base({ editedBy: { name: 'Maja' } }), NOW)).toBe('Maja · 12 min ago');
  });

  it('marks an agent as an agent', () => {
    expect(editedLine(base({ editedBy: { name: 'Claude', agent: true }, updatedAt: NOW - 5 * 60_000 }), NOW)).toBe('Claude (agent) · 5 min ago');
  });

  it('shows the date when nobody is recorded as the last editor', () => {
    const t = NOW - 3 * 86_400_000;
    expect(editedLine(base({ updatedAt: t }), NOW)).toBe(`Edited ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
  });

  it('says on this device for an open-mode board, before any name', () => {
    expect(editedLine(base({ onDevice: true, editedBy: { name: 'Maja' } }), NOW)).toBe('On this device');
  });

  it('says no content yet for an empty drawing while previews are on, and the date when they are off', () => {
    const empty = base({ preview: { shapes: [] } });
    expect(editedLine(empty, NOW)).toBe('No content yet');
    expect(editedLine(empty, NOW, false)).toMatch(/^Edited /);
  });

  it('does not call a board without a drawing yet empty', () => {
    expect(editedLine(base({ editedBy: { name: 'Maja' } }), NOW)).toBe('Maja · 12 min ago');
  });
});

describe('menuActionsFor', () => {
  it('gives an owner, an editor and an unknown role the full menu, in order', () => {
    const full = ['open', 'rename', 'move', 'duplicate', 'delete'];
    expect(menuActionsFor('owner')).toEqual(full);
    expect(menuActionsFor('editor')).toEqual(full);
    expect(menuActionsFor(undefined)).toEqual(full);
  });

  it('gives a viewer and a commenter only Open', () => {
    expect(menuActionsFor('viewer')).toEqual(['open']);
    expect(menuActionsFor('commenter')).toEqual(['open']);
  });
});

describe('boardCard', () => {
  it('shows the quiet tile with the first letter when previews are off', () => {
    const li = asEl(boardCard(base({ preview: one }), { tile: 'tint', previews: false }));
    expect(li.querySelector('.bc-quiet')).not.toBeNull();
    expect(li.querySelector('svg')).toBeNull();
    expect(textOf(asEl(li.querySelector('.bc-quiet-mark')))).toBe('Q');
  });

  it('draws the preview when previews are on', () => {
    const li = asEl(boardCard(base({ preview: one }), { tile: 'tint', previews: true }));
    expect(li.querySelector('svg')).not.toBeNull();
    expect(li.querySelector('.bc-quiet')).toBeNull();
  });

  it('links the name to the board and names the ⋯ button after the board', () => {
    const li = asEl(boardCard(base(), { tile: 'tint', previews: true }));
    expect(li.querySelector('a.bc-name')?.getAttribute('href')).toBe('#/b/q4');
    expect(li.querySelector('button.bc-more')?.getAttribute('aria-label')).toBe('More actions for Q4 roadmap');
  });

  it('shows a role badge only for a viewer or a commenter', () => {
    const viewer = asEl(boardCard(base({ role: 'viewer' }), { tile: 'tint', previews: true }));
    expect(textOf(asEl(viewer.querySelector('.badge')))).toBe('Viewer');
    const owner = asEl(boardCard(base({ role: 'owner' }), { tile: 'tint', previews: true }));
    expect(owner.querySelector('.badge')).toBeNull();
  });
});

describe('templateCard', () => {
  it('is one link that creates the board, with no menu, and a quiet tile when previews are off', () => {
    const li = asEl(templateCard({
      id: 'sprint-board', name: 'Sprint board', description: 'To do, doing and done.', category: 'Planning', tone: 'blue', preview: one,
    }, { tile: 'tint', previews: false }));
    const links = li.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('#/new/sprint-board');
    expect(li.querySelector('.bc-more')).toBeNull();
    expect(li.querySelector('.bc-quiet')).not.toBeNull();
    expect(li.querySelector('svg')).toBeNull();
  });
});
