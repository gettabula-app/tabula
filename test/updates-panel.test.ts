import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUpdates, Me } from '../src/api';
import { renderAdmin } from '../src/ui/admin';
import { FakeElement, FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const hosted = (): Me['workspace'] => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 1 });
const owner: Me = { user: { id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'owner' }, teams: [], workspace: hosted() };
const admin: Me = { user: { id: 'u2', email: 'admin@example.test', name: 'Admin', role: 'admin' }, teams: [], workspace: hosted() };

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let state: AdminUpdates;
let nextSynced: boolean;
let browser: FakeBrowser;
let root: FakeElement;

function serve() {
  calls = [];
  nextSynced = false;
  state = { auto: true, synced: true, securityAlwaysApplied: true };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/admin/updates') {
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PUT' && path === '/api/admin/updates') {
      state = { auto: (body as { auto: boolean }).auto, synced: nextSynced, securityAlwaysApplied: true };
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }));
}

const panel = () => need(root, '.admin-panel');
const toggle = () => need(panel(), 'input');

beforeEach(() => {
  browser = installFakeBrowser();
  root = browser.mount();
  serve();
});

afterEach(() => {
  browser.uninstall();
  vi.restoreAllMocks();
});

describe('hosted Admin Settings', () => {
  it('pins the Settings tab, Automatic updates label and update note', async () => {
    renderAdmin(root as unknown as HTMLElement, 'settings', owner);
    await flush();

    const tab = root.querySelectorAll('.admin-tab').find((el) => el.getAttribute('href') === '#/admin/settings');
    expect(tab && textOf(tab).replace(/^\d+/, '')).toBe('Settings');
    expect(textOf(need(panel(), 'label'))).toBe('Automatic updates');
    expect(textOf(panel())).toContain('Other updates install automatically unless you turn this off.');
    expect(textOf(panel())).toContain('Security updates are always installed.');
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
  });

  it('saves the switch and shows whether Tabula Cloud reached the control plane', async () => {
    renderAdmin(root as unknown as HTMLElement, 'settings', owner);
    await flush();

    toggle().checked = false;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/admin/updates', body: { auto: false } }]);
    expect(textOf(panel())).toContain('Saved. Tabula Cloud could not be reached; we will keep trying.');
    expect(toggle().checked).toBe(false);
  });

  it('shows Saved when the push succeeds', async () => {
    nextSynced = true;
    renderAdmin(root as unknown as HTMLElement, 'settings', owner);
    await flush();
    toggle().checked = false;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(textOf(panel())).toContain('Saved.');
    expect(textOf(panel())).not.toContain('could not be reached');
  });

  it('lets admins see the setting read-only', async () => {
    renderAdmin(root as unknown as HTMLElement, 'settings', admin);
    await flush();
    expect(toggle().disabled).toBe(true);
    expect(textOf(panel())).toContain('Only the owner can change this.');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });
});
