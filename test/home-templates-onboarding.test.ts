import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPage, renderHome, type HomeNav } from '../src/ui/home';
import { openCreateTeam, openWorkspaceMembers } from '../src/ui/teams';
import { resolveRoute } from '../src/route';
import { renderTemplates } from '../src/ui/templates-page';
import { createTopbar } from '../src/ui/topbar';
import { control, FakeElement, FakeEvent, flush, hasControl, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

vi.mock('../src/ui/teams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/teams')>()),
  openCreateTeam: vi.fn<(...args: unknown[]) => unknown>(),
  openWorkspaceMembers: vi.fn<(...args: unknown[]) => unknown>(),
}));

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

  it('Hide is a text button, styled like the All templates link', () => {
    useStorage(memoryStorage());
    const strip = need(openHome(), '.home-templates');
    const hide = control(strip, 'Hide the template suggestions');
    expect(hide.tagName).toBe('BUTTON');
    expect(hide.getAttribute('type')).toBe('button');
    expect(hide.classList.contains('link-more')).toBe(true);
    expect(textOf(hide)).toBe('Hide');
    expect(control(strip, /All templates/).classList.contains('link-more')).toBe(true);
  });

  it('the empty state of the Boards page has New board only; the strip below carries the templates', () => {
    useStorage(memoryStorage());
    const root = openHome();
    expect(need(root, '.home-empty-state').querySelectorAll('button, a').map(textOf)).toEqual(['New board']);
    expect(need(root, '.home-templates').hidden).toBe(false);
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

  it('starts with Blank board focused, and closes on an outside click but not on a press inside', async () => {
    useStorage(memoryStorage([localBoard()]));
    const fire = recordWindowListeners();
    const opener = need(openHome(), '.home-actions .btn.primary');
    opener.click();
    const blank = menuItems().find((item) => textOf(item) === 'Blank board')!;
    expect(browser.document.activeElement).toBe(blank);
    // the popover arms its outside-click listener on a timer: let that run before the first press
    await new Promise((resolve) => setTimeout(resolve, 0));
    fire('pointerdown', pressOn(blank));
    expect(menuOpen()).toBe(true);
    fire('pointerdown', pressOn(browser.document.body));
    expect(menuOpen()).toBe(false);
    expect(opener.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the account toolbar under 480 px', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStorage(memoryStorage());
  });

  /** The toolbar of an account with the given role, and its refresh and person, so the menu items can be checked against them. */
  function toolbarFor(role: string, down = false) {
    const nav = openNav();
    const refresh = vi.fn<() => void>();
    const me = { user: { id: 'u1', name: 'Ana', email: 'ana@example.test', role }, teams: [] };
    const page = accountPage({ nav, me, down, refresh, query: { value: '' } } as never, emptyAccountData) as unknown as FakeElement;
    // mounted, as the app mounts it: focus only goes back to a button that is still on the page
    browser.mount().appendChild(page);
    return { actions: need(page, '.home-actions'), refresh, me };
  }

  it('puts New team and Members behind More actions, and each item does what its button does', () => {
    const { actions, refresh, me } = toolbarFor('admin');
    expect(hasControl(actions, 'New team')).toBe(true);
    expect(hasControl(actions, 'Members')).toBe(true);
    const more = control(actions, 'More actions');
    expect(textOf(more)).toBe('…');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');

    more.click();
    expect(menuItems().map(textOf)).toEqual(['New team', 'Members']);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    menuItems().find((item) => textOf(item) === 'New team')!.click();
    expect(openCreateTeam).toHaveBeenCalledWith(refresh);
    expect(menuOpen()).toBe(false);

    control(actions, 'More actions').click();
    menuItems().find((item) => textOf(item) === 'Members')!.click();
    expect(openWorkspaceMembers).toHaveBeenCalledWith(me, refresh);
  });

  it('offers only New team to a member', () => {
    const { actions } = toolbarFor('member');
    expect(hasControl(actions, 'Members')).toBe(false);
    control(actions, 'More actions').click();
    expect(menuItems().map(textOf)).toEqual(['New team']);
  });

  it('gives a guest no More actions button, because a guest has neither New team nor Members', () => {
    const { actions } = toolbarFor('guest');
    expect(hasControl(actions, 'New team')).toBe(false);
    expect(hasControl(actions, 'Members')).toBe(false);
    expect(hasControl(actions, 'More actions')).toBe(false);
  });

  it('disables More actions, and its items, while the workspace is offline', () => {
    const { actions } = toolbarFor('admin', true);
    const more = control(actions, 'More actions');
    expect(more.disabled).toBe(true);
    // a disabled button sends no click, so this builds the menu the way a click would, to check the items' state
    more.dispatchEvent(new FakeEvent('click'));
    expect(menuItems().map((item) => item.disabled)).toEqual([true, true]);
  });

  it('Esc closes the menu and gives focus back to More actions', () => {
    const fire = recordWindowListeners();
    const { actions } = toolbarFor('member');
    const more = control(actions, 'More actions');
    more.click();
    expect(browser.document.activeElement).toBe(menuItems()[0]);
    fire('keydown', Object.assign(new FakeEvent('keydown'), { key: 'Escape' }));
    expect(menuOpen()).toBe(false);
    expect(browser.document.activeElement).toBe(more);
  });
});

describe('the Boards page stylesheet', () => {
  const css = readFileSync(new URL('../src/ui/home.css', import.meta.url), 'utf8');

  /** The body of the first `@media (<query>) { ... }` block. */
  const media = (query: string) => {
    const start = css.indexOf(`@media (${query})`);
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error('unbalanced');
  };

  it('makes Hide a 44px text button with no browser frame', () => {
    expect(css).toMatch(/\nbutton\.link-more \{ min-height: 44px; padding: 0 12px; border: 0; background: none; \}/);
  });

  it('shows More actions instead of New team and Members under 480 px, and the buttons from 480 px', () => {
    expect(css).toMatch(/\n\.home-actions \.home-more \{ display: none; \}/);
    expect(media('max-width: 479px')).toMatch(/\.home-actions \.home-action \{ display: none; \}/);
    expect(media('max-width: 479px')).toMatch(/\.home-actions \.home-more \{ display: inline-flex; \}/);
    expect(css).toMatch(/\.home-actions \.home-more \{ justify-self: start; min-width: 44px; \}/);
  });

  it('leaves the empty state on the page edge with no padding, minimum height or centring', () => {
    expect(css).not.toMatch(/\.home-empty-state \{[^}]*(min-height|padding|align-content|text-align|center)/);
    expect(css).not.toMatch(/\.home\.empty \{[^}]*(min-height|align-content)/);
    expect(css).not.toMatch(/\.home-empty-actions \{[^}]*center/);
  });

  it('has no team empty-state layout left', () => {
    expect(css).not.toMatch(/team-empty/);
  });
});

const menuOpen = () => browser.document.body.querySelector('.popover[role="menu"]') !== null;
/** A pointer press on `target`, as the popover's window listener receives it. */
const pressOn = (target: FakeElement) => Object.assign(new FakeEvent('pointerdown'), { target });

/**
 * The fake window keeps no listeners, so this stub records them: the popover's Escape and outside-click listeners are fired by the test.
 * Call it before the menu opens. Returns the function that fires a listener of the given type.
 */
function recordWindowListeners(): (type: string, event: FakeEvent) => void {
  const listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  vi.stubGlobal('window', {
    ...(window as unknown as object),
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: (event: FakeEvent) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((listener) => listener !== fn));
    },
  });
  return (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
}

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

  it('shows an empty team as one line with no buttons, and the team header New board creates its board', () => {
    useStorage(memoryStorage());
    const nav = openNav();
    const data = {
      teams: [{ id: 't1', name: 'Team one', role: 'member', memberCount: 1, archived: false }],
      boards: [serverBoard()], unreachable: false,
    } as never;
    const page = accountPage(accountView(nav), data) as unknown as FakeElement;
    const team = groupLabelled(page, 'Team one');
    const line = need(team, '.home-empty');
    expect(textOf(line)).toBe('No boards yet. Create the first one.');
    expect(line.querySelectorAll('button, a')).toHaveLength(0);
    controlWithin(need(team, '.group-actions'), 'New board').click();
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
