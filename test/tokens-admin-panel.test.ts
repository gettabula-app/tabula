import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type AdminAccessToken, type AdminGrant, type ConnectedGrant, type CreatedAccessToken, type Me } from '../src/api';
import { openTokensDialog, tokensAdminPanel, type AdminKit } from '../src/ui/tokens';
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

    const me: Me = { user: { id: 'u1', name: 'Admin', email: 'admin@example.test', role: 'owner' }, teams: [], mcp: true, mcpOauth: false };
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

  it('shows connector rows in the merged table and arms single and workspace disconnect actions', async () => {
    browser = installFakeBrowser();
    const me: Me = { user: { id: 'u1', name: 'Admin', email: 'admin@example.test', role: 'owner' }, teams: [], mcp: true, mcpOauth: true };
    const first: AdminGrant = {
      id: 'g1', clientId: 'c1', clientName: 'Claude Desktop', redirectHost: 'claude.ai', scope: 'read', boardCount: null,
      createdAt: 1_800_000_000_000, lastUsedAt: null, expiresAt: 1_802_592_000_000,
      userId: 'u2', userName: 'Member', email: 'member@example.test', userRole: 'member',
    };
    const second: AdminGrant = { ...first, id: 'g2', clientId: 'c2', clientName: 'Editor App', boardCount: 2, userId: 'u3', userName: 'Other', email: 'other@example.test' };
    let grantList = [first, second];
    const grantFetch = vi.spyOn(api, 'adminGrants').mockImplementation(async () => [...grantList]);
    vi.spyOn(api, 'adminAccessTokens').mockResolvedValue([]);
    const disconnect = vi.spyOn(api, 'adminDisconnectGrant').mockImplementation(async (id) => {
      grantList = grantList.filter((grant) => grant.id !== id);
    });
    const revokeAll = vi.spyOn(api, 'adminRevokeAllGrants').mockImplementation(async () => {
      const revoked = grantList.length;
      grantList = [];
      return { revoked };
    });

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
          void fetchData().then((data) => { if (current === run && box.isConnected) show(data); });
        };
        reload();
        return reload;
      },
      change: async (run) => { await run(); return true; },
      armable: (label, armedLabel, run) => {
        const button = document.createElement('button');
        button.textContent = label;
        let armed = false;
        button.addEventListener('click', async () => {
          if (!armed) { armed = true; button.textContent = armedLabel; return; }
          await run();
        });
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
    await vi.waitFor(() => expect(textOf(root)).toContain('Claude Desktop'));
    expect(textOf(root)).toContain('Type');
    expect(textOf(root)).toContain('Person');
    expect(textOf(root)).toContain('Connector');
    expect(textOf(root)).toContain('All boards you can open');
    expect(textOf(root)).toContain('Disconnect all apps');
    expect(grantFetch).toHaveBeenCalledTimes(1);

    const disconnectButtons = root.querySelectorAll('button').filter((button) => button.textContent === 'Disconnect');
    expect(disconnectButtons).toHaveLength(2);
    disconnectButtons[0].click();
    expect(disconnectButtons[0].textContent).toBe('Click again to disconnect');
    disconnectButtons[0].click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('g1'));
    await vi.waitFor(() => expect(textOf(root)).not.toContain('Claude Desktop'));
    expect(textOf(root)).toContain('Disconnect all apps');

    const all = control(root, 'Disconnect all apps');
    all.click();
    expect(all.textContent).toBe('Click again to disconnect all apps');
    all.click();
    await vi.waitFor(() => expect(revokeAll).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(textOf(root)).toContain('No active access tokens or connected apps.'));
  });

  it('shows connected apps in the member dialog and reloads after disconnect', async () => {
    browser = installFakeBrowser();
    const proto = FakeElement.prototype as unknown as { scrollTo?: (x: number, y: number) => void };
    hadScrollTo = 'scrollTo' in proto;
    originalScrollTo = proto.scrollTo;
    proto.scrollTo = () => {};
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
    const me: Me = { user: { id: 'u1', name: 'Member', email: 'member@example.test', role: 'member' }, teams: [], mcp: true, mcpOauth: true };
    const grant: ConnectedGrant = {
      id: 'g1', clientId: 'c1', clientName: '<Claude>', redirectHost: 'claude.ai', scope: 'comment', boardCount: 1,
      createdAt: 1_800_000_000_000, lastUsedAt: null, expiresAt: 1_802_592_000_000,
    };
    const myGrants = vi.spyOn(api, 'myGrants').mockResolvedValueOnce([grant]).mockResolvedValue([]);
    vi.spyOn(api, 'accessTokens').mockResolvedValue([]);
    vi.spyOn(api, 'boards').mockResolvedValue([]);
    const disconnect = vi.spyOn(api, 'disconnectGrant').mockResolvedValue(undefined);
    openTokensDialog(me);
    const modal = need(browser.document.body as unknown as FakeElement, '.tokens-dialog');
    await vi.waitFor(() => expect(textOf(modal)).toContain('Connected apps'));
    expect(textOf(modal)).toContain('<Claude>');
    expect(textOf(modal)).toContain('claude.ai');
    expect(textOf(modal)).toContain('Read and comment');
    expect(textOf(modal)).toContain('1 board');
    expect(textOf(modal)).toContain('Never used');
    expect(modal.querySelector('.tokens-name')?.textContent).toBe('<Claude>');
    const revokeAll = control(modal, 'Revoke all');
    revokeAll.click();
    expect(revokeAll.textContent).toBe('Click again to revoke all tokens and disconnect connected apps');
    revokeAll.dispatchEvent(new FakeEvent('blur', false));
    const button = control(modal, 'Disconnect');
    button.click();
    expect(button.textContent).toBe('Click again to disconnect');
    button.click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith('g1'));
    await vi.waitFor(() => expect(textOf(modal)).toContain('No apps are connected.'));
    expect(myGrants).toHaveBeenCalledTimes(2);
  });
});
