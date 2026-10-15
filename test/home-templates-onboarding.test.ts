import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPage, renderHome, type HomeNav } from '../src/ui/home';
import { resolveRoute } from '../src/route';
import { renderTemplates } from '../src/ui/templates-page';
import { createTopbar } from '../src/ui/topbar';
import { control, FakeElement, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const templateStore = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../src/template-store', () => ({
  duplicateSavedTemplate: vi.fn<(...args: unknown[]) => unknown>(),
  getTemplate: vi.fn<(...args: unknown[]) => unknown>(),
  listTemplates: async () => templateStore.rows,
  onTemplatesChange: () => () => undefined,
  putTemplate: vi.fn<(...args: unknown[]) => unknown>(),
  removeTemplate: vi.fn<(...args: unknown[]) => unknown>(),
  templatesShared: () => false,
}));

type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
type MemoryStorage = Storage & { values: Map<string, string> };

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  templateStore.rows = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
});

afterEach(async () => {
  // a popover arms its outside-click listener on a timer (src/ui/common.ts): let that run while the fake window is still here
  (await import('../src/ui/common')).closePopover();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  browser.uninstall();
});

function memoryStorage(boards: unknown[] = []): MemoryStorage {
  const values = new Map<string, string>();
  values.set('driftboard:boards', JSON.stringify(boards));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function useStorage(storage: Storage) {
  vi.stubGlobal('localStorage', storage);
}

const openNav = (): HomeNav => ({ open: vi.fn<HomeNav['open']>() });
const localBoard = (id = 'b1') => ({ id, name: 'Board', createdAt: 1, updatedAt: 1 });
const serverBoard = (teamId: string | null = null) => ({
  id: 'b1', title: 'Board', ownerId: 'u1', teamId, role: 'owner', updatedAt: 1,
});
const accountView = (nav: HomeNav, role = 'member', id = 'u1', down = false) => ({
  nav, me: { user: { id, name: 'Ana', email: 'ana@example.test', role }, teams: [] }, down, refresh: () => undefined, query: { value: '' },
}) as never;
const emptyAccountData = { teams: [], boards: [], unreachable: false } as never;

function openHome(nav = openNav()) {
  const root = browser.mount();
  renderHome(root as unknown as HTMLElement, nav, { mode: 'open' });
  return root;
}

function menuItems() {
  return browser.document.body.querySelectorAll('[role="menuitem"]');
}

describe('template suggestions on the Boards page', () => {
  it('shows with no boards and stays dismissed after a board has existed', () => {
    const storage = memoryStorage();
    useStorage(storage);
    const first = openHome();
    expect(need(first, '.home-templates').hidden).toBe(false);

    storage.setItem('driftboard:boards', JSON.stringify([localBoard()]));
    const withBoard = openHome();
    expect(need(withBoard, '.home-templates').hidden).toBe(true);
    expect(storage.getItem('driftboard:home-template-suggestions:open')).toBe('board-exists');

    storage.setItem('driftboard:boards', JSON.stringify([]));
    const afterRemoval = openHome();
    expect(need(afterRemoval, '.home-templates').hidden).toBe(true);
  });

  it('Hide hides suggestions and keeps that choice after a reload', () => {
    const storage = memoryStorage();
    useStorage(storage);
    const first = openHome();
    const strip = need(first, '.home-templates');
    const hide = control(strip, 'Hide the template suggestions');
    expect(textOf(hide)).toBe('Hide');
    hide.click();
    expect(strip.hidden).toBe(true);
    expect(storage.getItem('driftboard:home-template-suggestions:open')).toBe('hidden');

    const afterReload = openHome();
    expect(need(afterReload, '.home-templates').hidden).toBe(true);
  });

  it('keeps showing suggestions with no boards when local storage throws on read and write', () => {
    useStorage({
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(() => openHome()).not.toThrow();
    const strip = browser.document.body.querySelector('.home-templates') as FakeElement;
    expect(strip.hidden).toBe(false);
  });

  it('stores Hide separately for each signed-in person', () => {
    const storage = memoryStorage();
    useStorage(storage);
    const page = accountPage(accountView(openNav(), 'member', 'u1'), emptyAccountData) as unknown as FakeElement;
    const strip = need(page, '.home-templates');
    control(strip, 'Hide the template suggestions').click();
    expect(storage.getItem('driftboard:home-template-suggestions:u1')).toBe('hidden');
    expect(storage.getItem('driftboard:home-template-suggestions:open')).toBeNull();
  });
});

describe('the New board menu', () => {
  it.each(['open', 'accounts'] as const)('offers working actions in %s mode', async (mode) => {
    const storage = memoryStorage([localBoard()]);
    useStorage(storage);
    const nav = openNav();
    let page: FakeElement;
    if (mode === 'open') page = openHome(nav);
    else page = accountPage(accountView(nav), { teams: [], boards: [serverBoard()], unreachable: false } as never) as unknown as FakeElement;
    const toolbar = need(page, '.home-toolbar');
    const opener = need(toolbar, '.home-actions .btn.primary');
    const fileInput = page.querySelector('input[type="file"]')!;
    const clickFile = vi.spyOn(fileInput, 'click');

    const openMenu = () => {
      opener.click();
      const items = menuItems();
      expect(items.map(textOf)).toEqual(['Blank board', 'From a template…', 'Import a file…']);
      expect(browser.document.body.querySelector('.popover[role="menu"]')).not.toBeNull();
      expect(opener.getAttribute('aria-haspopup')).toBe('menu');
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      return items;
    };

    openMenu().find((item) => textOf(item) === 'Blank board')!.click();
    expect(nav.open).toHaveBeenCalledTimes(1);
    openMenu().find((item) => textOf(item) === 'From a template…')!.click();
    expect(browser.location.hash).toBe('#/templates');
    openMenu().find((item) => textOf(item) === 'Import a file…')!.click();
    expect(clickFile).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('is disabled when an account is offline', () => {
    const page = accountPage(accountView(openNav(), 'member', 'u1', true), emptyAccountData) as unknown as FakeElement;
    expect(need(page, '.home-toolbar .home-actions .btn.primary').disabled).toBe(true);
  });
});

describe('template navigation', () => {
  it('has no Templates navbar link and keeps #/templates as a rendered route', async () => {
    const bar = createTopbar('boards', null) as unknown as FakeElement;
    const links = bar.querySelectorAll('.topbar-nav a');
    expect(links.map((link) => link.getAttribute('href'))).not.toContain('#/templates');

    expect(resolveRoute('#/templates', 'open')).toEqual({ name: 'templates' });
    const root = browser.mount();
    renderTemplates(root as unknown as HTMLElement, openNav(), { mode: 'open' });
    await flush();
    expect(browser.document.title).toBe('Templates - Tabula');
    expect(textOf(need(root, '.home-title'))).toBe('Templates');
  });

  it('keeps the template strip hidden while account data is loading', () => {
    useStorage(memoryStorage());
    const page = accountPage(accountView(openNav()), null) as unknown as FakeElement;
    expect(need(page, '.home-templates').hidden).toBe(true);
  });

  it('shows an empty team state with a team-scoped New board and template link', () => {
    useStorage(memoryStorage());
    const nav = openNav();
    const data = {
      teams: [{ id: 't1', name: 'Team one', role: 'member', memberCount: 1, archived: false }],
      boards: [serverBoard()], unreachable: false,
    } as never;
    const page = accountPage(accountView(nav), data) as unknown as FakeElement;
    const team = groupLabelled(page, 'Team one');
    const empty = need(team, '.team-empty-state');
    expect(textOf(empty)).toContain('New board');
    expect(textOf(empty)).toContain('Start from a template');
    controlWithin(empty, 'New board').click();
    expect(nav.open).toHaveBeenCalledWith(expect.any(String), { teamId: 't1' });
  });
});

/** The board group whose aria-label is `label`. Found by walking the tree: the fake DOM's selectors cannot read a quoted value with a space in it. */
function groupLabelled(root: FakeElement, label: string) {
  const found = root.querySelectorAll('.board-group').find((el) => el.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no board group labelled ${label} in: ${textOf(root).slice(0, 300)}`);
  return found;
}

function controlWithin(root: FakeElement, label: string) {
  const found = root.querySelectorAll('button, a').find((el) => textOf(el) === label);
  if (!found) throw new Error(`missing control ${label}`);
  return found;
}
