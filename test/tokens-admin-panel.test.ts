import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type AdminAccessToken, type CreatedAccessToken, type Me } from '../src/api';
import { tokensAdminPanel, type AdminKit } from '../src/ui/tokens';
import { FakeElement, FakeEvent, control, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

let browser: FakeBrowser | undefined;
let originalScrollTo: ((x: number, y: number) => void) | undefined;
let hadScrollTo = false;
afterEach(() => {
  vi.restoreAllMocks();
  browser?.uninstall();
  browser = undefined;
  const proto = FakeElement.prototype as unknown as { scrollTo?: (x: number, y: number) => void };
  if (hadScrollTo) proto.scrollTo = originalScrollTo;
  else delete proto.scrollTo;
  originalScrollTo = undefined;
  hadScrollTo = false;
});

describe('Admin access tokens panel', () => {
  it('opens token creation, refreshes the admin list, and restores focus to its button', async () => {
    browser = installFakeBrowser();
    const proto = FakeElement.prototype as unknown as { scrollTo?: (x: number, y: number) => void };
    hadScrollTo = 'scrollTo' in proto;
    originalScrollTo = proto.scrollTo;
    proto.scrollTo = () => {};
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });

    const me: Me = { user: { id: 'u1', name: 'Admin', email: 'admin@example.test', role: 'owner' }, teams: [], mcp: true };
    const adminToken: AdminAccessToken = {
      id: 't1', userId: 'u1', userName: 'Admin', email: 'admin@example.test', userRole: 'owner',
      name: 'Claude Code', scope: 'read', boardIds: null, hint: 'abcd', createdAt: 1_800_000_000_000,
      expiresAt: 1_802_592_000_000, lastUsedAt: null,
    };
    const made: CreatedAccessToken = {
      ...adminToken, token: 'tbl_secret', url: 'https://tabula.example.test/mcp',
    };
    const adminList = vi.spyOn(api, 'adminAccessTokens')
      .mockResolvedValueOnce([])
      .mockResolvedValue([adminToken]);
    vi.spyOn(api, 'accessTokens').mockResolvedValue([]);
    vi.spyOn(api, 'boards').mockResolvedValue([]);
    const createToken = vi.spyOn(api, 'createAccessToken').mockResolvedValue(made);

    const kit: AdminKit = {
      head: (cells) => {
        const row = document.createElement('div');
        row.textContent = cells.join(' · ');
        return row;
      },
      loadList: <T,>(box: HTMLElement, fetchData: () => Promise<T>, show: (data: T) => void) => {
        let run = 0;
        const reload = () => {
          const current = ++run;
          void fetchData().then((data) => {
            if (current === run && box.isConnected) show(data);
          });
        };
        reload();
        return reload;
      },
      change: async () => true,
      armable: (label) => {
        const button = document.createElement('button');
        button.textContent = label;
        return button as HTMLButtonElement;
      },
      emptyLine: (text) => {
        const line = document.createElement('p');
        line.textContent = text;
        return line;
      },
    };
    const root = browser.mount();
    root.appendChild(tokensAdminPanel(me, kit) as unknown as FakeElement);
    await vi.waitFor(() => expect(textOf(root)).toContain('No active access tokens.'));

    const create = control(root, 'Create a token');
    expect(create.tagName).toBe('BUTTON');
    expect(create.type).toBe('button');
    expect(textOf(root)).toContain('Connect AI tools like Claude Code to this workspace over MCP.');
    create.click();

    const modal = need(browser.document.body as unknown as FakeElement, '.tokens-dialog');
    await vi.waitFor(() => expect(textOf(modal)).toContain('New token'));
    control(modal, 'New token').click();
    const name = need(modal, 'input');
    expect(name.getAttribute('aria-label')).toMatch(/^Token name/);
    name.value = 'Claude Code';
    name.dispatchEvent(new FakeEvent('input'));
    control(modal, 'Create token').click();

    await vi.waitFor(() => expect(createToken).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(adminList).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(textOf(root)).toContain('Claude Code'));
    expect(textOf(root)).not.toContain('No active access tokens.');

    control(modal, 'Close').click();
    expect(browser.document.activeElement).toBe(create);
  });
});
