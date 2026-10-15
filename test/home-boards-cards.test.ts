import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerBoard } from '../src/api';
import { accountPage, keepFocus, type HomeNav } from '../src/ui/home';
import { openTeamManager } from '../src/ui/teams';
import { featuredTemplates } from '../src/ui/templates-page';
import { FakeDOMParser, FakeElement, installFakeBrowser, need, textOf, type FakeBrowser, control, hasControl } from './fake-dom';

// TAB-375 slice 2: the account Boards page as cards. One section per team, Personal, Shared with you, this device; the menu of a card
// by role; the dev-only Move to… and drag; offline; the list view; the first-run cards. The popover is driven as the existing tests drive it.

vi.mock('../src/ui/teams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/teams')>()),
  openCreateTeam: vi.fn<(...args: unknown[]) => unknown>(),
  openWorkspaceMembers: vi.fn<(...args: unknown[]) => unknown>(),
  openTeamManager: vi.fn<(...args: unknown[]) => unknown>(),
}));
vi.mock('../src/ui/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/common')>()),
  toast: vi.fn<(...args: unknown[]) => unknown>(),
}));

const NOW = new Date(2026, 9, 15, 12, 0).getTime();
let browser: FakeBrowser;
let values: Map<string, string>;

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('DOMParser', FakeDOMParser);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  values = new Map([['driftboard:boards', '[]']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  });
  vi.stubEnv('DEV', true);
});

afterEach(async () => {
  (await import('../src/ui/common')).closePopover();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  browser.uninstall();
});

const sb = (over: Partial<ServerBoard> & { id: string }): ServerBoard => ({
  title: over.id, teamId: null, ownerId: 'u1', role: 'owner', createdAt: 1, updatedAt: NOW - 60_000, ...over,
});
const TEAMS = [
  { id: 't1', name: 'Design team', role: 'admin' as const, memberCount: 3, archived: false },
  { id: 't2', name: 'Retro team', role: 'member' as const, memberCount: 4, archived: false },
  { id: 't3', name: 'Growth team', role: null, memberCount: 2, archived: false },
];
const BOARDS: ServerBoard[] = [
  sb({ id: 'q4', title: 'Q4 roadmap', teamId: 't1', lastEditedBy: 'Maja', lastEditedKind: 'person', lastEditedAt: NOW - 12 * 60_000 }),
  sb({ id: 'draft', title: 'Shared draft', teamId: 't1', ownerId: 'u9', role: 'editor' }),
  sb({ id: 'retro', title: 'Sprint retro', teamId: 't2', ownerId: 'u9', role: 'viewer', lastEditedBy: 'Claude', lastEditedKind: 'agent', lastEditedAt: NOW - 5 * 60_000 }),
  sb({ id: 'notes', title: 'Notes', teamId: null }),
  sb({ id: 'lin', title: 'Launch review', teamId: null, ownerId: 'u9', role: 'viewer' }),
];
const nav = (): HomeNav & { open: ReturnType<typeof vi.fn<HomeNav['open']>> } => ({ open: vi.fn<HomeNav['open']>() }) as never;

function account(opts: { role?: string; down?: boolean; boards?: ServerBoard[]; teams?: typeof TEAMS; display?: { view: 'cards' | 'list'; previews: boolean }; query?: string; navigation?: HomeNav } = {}) {
  const refresh = vi.fn<() => void>();
  const n = opts.navigation ?? nav();
  const me = { user: { id: 'u1', name: 'Ana', email: 'ana@example.test', role: opts.role ?? 'member' }, teams: [] };
  const page = accountPage({
    nav: n, me, down: opts.down ?? false, refresh, query: { value: opts.query ?? '' }, display: opts.display ?? { view: 'cards', previews: true },
  } as never, { teams: opts.teams ?? TEAMS, boards: opts.boards ?? BOARDS, unreachable: false } as never) as unknown as FakeElement;
  browser.mount().appendChild(page);
  return { page, refresh, nav: n };
}

const sectionHeads = (page: FakeElement) => page.querySelectorAll('.bc-group h2').map(textOf);
const cardNamed = (page: FakeElement, name: string) => {
  const found = page.querySelectorAll('article.bc').find((el) => el.getAttribute('aria-label')?.startsWith(name));
  if (!found) throw new Error(`no card named ${name}`);
  return found;
};
const menuItems = () => browser.document.body.querySelectorAll('[role="menuitem"]');
/** The labels of the open menu; the › hint of a sub-menu item is not part of its label. */
const labels = () => menuItems().map((item) => textOf(item).replace(/›$/u, ''));
const openMenuOf = (page: FakeElement, name: string) => {
  control(cardNamed(page, name), `More actions for ${name}`).click();
  return labels();
};
const bodyEl = () => browser.document.body as unknown as FakeElement;

describe('the account Boards page as cards', () => {
  it('draws one section per team, then Personal and Shared with you, each with its boards as cards', () => {
    const { page } = account();
    expect(sectionHeads(page)).toEqual(['Design team', 'Growth team', 'Retro team', 'Personal', 'Shared with you']);
    expect(page.querySelectorAll('article.bc')).toHaveLength(BOARDS.length);
    expect(page.querySelector('.board-group')).toBeNull();
  });

  it('gives a team you are in a dashed New board tile, and a team you are not in neither a tile nor a New board button', () => {
    const { page } = account();
    const team = (name: string) => page.querySelectorAll('.bc-group').find((el) => textOf(el.querySelector('h2')) === name)!;
    expect(team('Design team').querySelectorAll('.bc-new')).toHaveLength(1);
    expect(team('Retro team').querySelectorAll('.bc-new')).toHaveLength(1);
    expect(team('Growth team').querySelectorAll('.bc-new')).toHaveLength(0);
    expect(team('Growth team').querySelectorAll('button').map(textOf)).toEqual(['Manage']);
    expect(textOf(need(team('Growth team'), '.bc-empty'))).toContain('No boards in Growth team yet.');
  });

  it('keeps Manage on every team head, which opens the team manager', () => {
    const { page } = account();
    const design = page.querySelectorAll('.bc-group').find((el) => textOf(el.querySelector('h2')) === 'Design team')!;
    control(design, 'Manage').click();
    expect(openTeamManager).toHaveBeenCalledWith(TEAMS[0], expect.anything(), expect.any(Function));
  });

  it('shows the last editor from the server with the time, the agent mark, and the role chip for a viewer only', () => {
    const { page } = account();
    expect(textOf(need(cardNamed(page, 'Q4 roadmap'), '.bc-sub'))).toBe('Maja · 12 min ago');
    expect(textOf(need(cardNamed(page, 'Sprint retro'), '.bc-sub'))).toBe('Claude (agent) · 5 min ago');
    expect(textOf(need(cardNamed(page, 'Sprint retro'), '.badge'))).toBe('Viewer');
    expect(cardNamed(page, 'Q4 roadmap').querySelector('.badge')).toBeNull();
  });

  it('links each card name to its board', () => {
    const { page } = account();
    expect(need(cardNamed(page, 'Q4 roadmap'), 'a.bc-name').getAttribute('href')).toBe('#/b/q4');
  });

  it('keeps the ⋯ button reachable and named after its board', () => {
    const { page } = account();
    expect(control(cardNamed(page, 'Notes'), 'More actions for Notes').tagName).toBe('BUTTON');
  });

  it('shows the list view as rows, with the same sections', () => {
    const { page } = account({ display: { view: 'list', previews: true } });
    expect(sectionHeads(page)).toEqual(['Design team', 'Growth team', 'Retro team', 'Personal', 'Shared with you']);
    expect(page.querySelectorAll('.bc-row')).toHaveLength(BOARDS.length);
    expect(page.querySelectorAll('.bc-grid')).toHaveLength(0);
  });

  it('keeps the search: a team with no matching board is left out, and no match says so', () => {
    expect(sectionHeads(account({ query: 'notes' }).page)).toEqual(['Personal']);
    const { page } = account({ query: 'zzz-nothing' });
    expect(textOf(page)).toContain('No boards match “zzz-nothing”.');
  });
});

describe('the ⋯ menu by role', () => {
  it('an owner gets Open, Move to… (the teams they are in) and Delete', () => {
    const { page } = account();
    expect(openMenuOf(page, 'Q4 roadmap')).toEqual(['Open', 'Move to…', 'Delete']);
    control(bodyEl(), /^Move to/u).click();
    expect(labels()).toEqual(['Back', 'Personal', 'Retro team']);
  });

  it('an editor gets Open only: no Delete, and no Move to… for a board they do not own', () => {
    const { page } = account();
    expect(openMenuOf(page, 'Shared draft')).toEqual(['Open']);
  });

  it('a viewer gets Open only', () => {
    const { page } = account();
    expect(openMenuOf(page, 'Sprint retro')).toEqual(['Open']);
  });

  it('a workspace admin may move a board they do not own to any team', () => {
    const { page } = account({ role: 'admin' });
    expect(openMenuOf(page, 'Launch review')).toEqual(['Open', 'Move to…']);
    control(bodyEl(), /^Move to/u).click();
    expect(labels()).toEqual(['Back', 'Design team', 'Growth team', 'Retro team']);
  });

  it('in a production build there is no Move to…, and no board can be dragged', () => {
    vi.stubEnv('DEV', false);
    const { page } = account();
    expect(openMenuOf(page, 'Q4 roadmap')).toEqual(['Open', 'Delete']);
    expect(page.querySelectorAll('li.bc-li').every((li) => li.getAttribute('draggable') === null)).toBe(true);
  });

  it('offline: every menu item but Open is disabled', () => {
    const { page } = account({ down: true });
    openMenuOf(page, 'Q4 roadmap');
    const items = menuItems();
    expect(items.map((item) => item.disabled)).toEqual([false, true, true]);
  });
});

describe('dev-only Move to… (the stub)', () => {
  it('moves the board in this tab, says so with Undo, and Undo puts it back', async () => {
    const { toast } = await import('../src/ui/common') as unknown as { toast: ReturnType<typeof vi.fn> };
    const { page, refresh } = account();
    openMenuOf(page, 'Notes');
    control(bodyEl(), /^Move to/u).click();
    menuItems().find((item) => textOf(item) === 'Retro team')!.click();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith('Moved (dev stub: not saved on the server yet)', expect.any(Number), expect.objectContaining({ label: 'Undo' }));
    const action = toast.mock.calls.at(-1)![2] as { onClick: () => void };
    action.onClick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('the device section', () => {
  it('lists the boards kept on this device as cards, with Add to workspace… and Delete in the menu', () => {
    values.set('driftboard:boards', JSON.stringify([{ id: 'dev1', name: 'Sketch', createdAt: 1, updatedAt: NOW - 60_000 }]));
    const { page } = account();
    expect(sectionHeads(page).at(-1)).toBe('On this device');
    expect(textOf(need(cardNamed(page, 'Sketch'), '.bc-sub'))).toBe('On this device');
    expect(openMenuOf(page, 'Sketch')).toEqual(['Open', 'Add to workspace…', 'Delete']);
    control(bodyEl(), /^Add to workspace/u).click();
    expect(labels()).toEqual(['Back', 'Personal', 'Design team', 'Retro team']);
  });
});

describe('the first-run cards', () => {
  it('with no boards, offers the built-in templates and a blank board, and a template card creates its board', () => {
    const navigation = nav();
    const { page } = account({ boards: [], teams: [], navigation });
    const welcome = need(page, '.bc-welcome');
    expect(welcome.querySelectorAll('article.bc')).toHaveLength(featuredTemplates(5).length + 1);
    expect(welcome.querySelectorAll('.bc-name').map(textOf)).toContain('Blank board');
    const first = featuredTemplates(5)[0];
    welcome.querySelectorAll('a.bc-name').find((a) => textOf(a) === first.name)!.click();
    // a template card opens a board made from that template
    expect(navigation.open.mock.calls[0]).toEqual([expect.any(String), { template: first.id }]);
  });

  it('Hide keeps the cards away for this person', () => {
    const { page } = account({ boards: [], teams: [] });
    control(need(page, '.bc-welcome'), 'Hide the template suggestions').click();
    expect(values.get('driftboard:home-template-suggestions:u1')).toBe('hidden');
    expect(page.querySelector('.bc-welcome')).toBeNull();
  });

  it('once the person has had a board, no cards are shown, and that is remembered', () => {
    const { page } = account({ boards: [sb({ id: 'x', title: 'X' })], teams: [] });
    expect(page.querySelector('.bc-welcome')).toBeNull();
    expect(values.get('driftboard:home-template-suggestions:u1')).toBe('board-exists');
  });

  it('shows no cards while offline (a board needs the server)', () => {
    const { page } = account({ boards: [], teams: [], down: true });
    expect(page.querySelector('.bc-welcome')).toBeNull();
  });
});

describe('focus across a repaint', () => {
  it('puts the focus back on the same control after the groups are rebuilt, and on the same one of two with the same name', () => {
    const host = browser.mount() as unknown as FakeElement;
    const button = (text: string) => {
      const el = browser.document.createElement('button') as unknown as FakeElement;
      el.textContent = text;
      return el;
    };
    host.replaceChildren(button('Manage'), button('New board'), button('New board'));
    const newBoards = host.querySelectorAll('button').filter((b) => textOf(b) === 'New board');
    newBoards[1].focus();
    keepFocus(host as unknown as HTMLElement, () => host.replaceChildren(button('Manage'), button('New board'), button('New board')));
    const after = host.querySelectorAll('button').filter((b) => textOf(b) === 'New board');
    expect(browser.document.activeElement).toBe(after[1]);
  });

  it('leaves the focus alone when it is outside the groups, and still repaints', () => {
    const host = browser.mount() as unknown as FakeElement;
    const outside = browser.document.createElement('button') as unknown as FakeElement;
    host.replaceChildren();
    browser.mount().appendChild(outside);
    outside.focus();
    const repaint = vi.fn<() => void>();
    keepFocus(host as unknown as HTMLElement, repaint);
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(browser.document.activeElement).toBe(outside);
  });
});

describe('the Boards page toolbar', () => {
  it('keeps the search, New board, New team and Members, and adds Cards | List and Show previews', () => {
    const { page } = account({ role: 'admin' });
    const toolbar = need(page, '.home-toolbar');
    for (const label of ['New board', 'New team', 'Members']) expect(hasControl(toolbar, label)).toBe(true);
    const bar = need(page, '.bc-toolbar');
    expect(textOf(bar)).toContain('Cards');
    expect(textOf(bar)).toContain('List');
    expect(textOf(bar)).toContain('Show previews');
  });

  it('offline: the New board buttons, the team tiles and Manage are disabled', () => {
    const { page } = account({ down: true });
    expect(need(page, '.home-toolbar .btn.primary').disabled).toBe(true);
    const personal = page.querySelectorAll('.bc-group').find((el) => textOf(el.querySelector('h2')) === 'Personal')!;
    expect(control(personal, 'New board').disabled).toBe(true);
    const design = page.querySelectorAll('.bc-group').find((el) => textOf(el.querySelector('h2')) === 'Design team')!;
    expect(control(design, 'Manage').disabled).toBe(true);
    expect(need(design, '.bc-new').disabled).toBe(true);
  });
});
