import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPrivacy, AdminPrivacyPreview, Me } from '../src/api';
import { renderAdmin } from '../src/ui/admin';
import { PRIVACY_COPY } from '../src/ui/privacy-logic';
import { FakeElement, FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const hosted = (): Me['workspace'] => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 1 });
const owner: Me = { user: { id: 'u1', email: 'owner@example.test', name: 'Owner', role: 'owner' }, teams: [], workspace: hosted(), mcpOauth: false };
const admin: Me = { user: { id: 'u2', email: 'admin@example.test', name: 'Admin', role: 'admin' }, teams: [], workspace: hosted(), mcpOauth: false };
const selfOwner: Me = { user: { id: 'u3', email: 'self@example.test', name: 'Self owner', role: 'owner' }, teams: [], mcpOauth: false };

const settings = (patch: Partial<AdminPrivacy> = {}): AdminPrivacy => ({
  enabled: true,
  locked: null,
  mode: 'hosted',
  operational: ['performance', 'error_codes', 'backup state', 'workspace_scale', 'last activity'],
  categories: ['feature_counts'],
  lastBuiltAt: Date.UTC(2026, 9, 12, 9, 0),
  lastChangedBy: { name: 'Owner', at: Date.UTC(2026, 9, 12, 9, 0) },
  ...patch,
});

let state: AdminPrivacy;
let preview: AdminPrivacyPreview;
let calls: { method: string; path: string; body?: unknown }[];
let failLoads = 0;
let failPreviews = 0;
let browser: FakeBrowser;
let root: FakeElement;

function serve() {
  calls = [];
  failLoads = 0;
  failPreviews = 0;
  state = settings();
  preview = { preview: { schema: 1, marker: '<script>not markup</script>' }, builtAt: Date.UTC(2026, 9, 12, 9, 0), note: 'Nothing has been sent' };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/admin/privacy') {
      if (failLoads > 0) {
        failLoads--;
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PUT' && path === '/api/admin/privacy') {
      state = { ...state, enabled: (body as { enabled: boolean }).enabled };
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && path === '/api/admin/privacy/preview') {
      if (failPreviews > 0) {
        failPreviews--;
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }));
}

const panel = () => need(root, '.admin-panel');
const toggle = () => need(panel(), 'input[type=checkbox]');
const previewButton = () => need(panel(), '[data-focus=preview]');

beforeEach(() => {
  browser = installFakeBrowser();
  root = browser.mount();
  serve();
});

afterEach(() => {
  browser.uninstall();
  vi.restoreAllMocks();
});

describe('Admin Privacy', () => {
  it('shows the Privacy tab on hosted and self-hosted installs', async () => {
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    const tab = root.querySelectorAll('.admin-tab').find((el) => el.getAttribute('href') === '#/admin/privacy');
    expect(tab && textOf(tab).replace(/^\d+/, '')).toBe('Privacy');
    expect(tab?.getAttribute('aria-current')).toBe('page');
    expect(textOf(panel())).toContain(PRIVACY_COPY.switchLabel);

    state = settings({ mode: 'self', enabled: false, lastBuiltAt: null });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();
    expect(root.querySelectorAll('.admin-tab').some((el) => el.getAttribute('href') === '#/admin/privacy')).toBe(true);
    expect(textOf(panel())).toContain(PRIVACY_COPY.selfIntro);
  });

  it('keeps Backups, Privacy and Audit in that order in the rendered Admin tabs', async () => {
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    const hrefs = root.querySelectorAll('.admin-tab').map((el) => el.getAttribute('href'));
    const at = (name: string) => hrefs.indexOf(`#/admin/${name}`);
    expect(at('backups')).toBeGreaterThanOrEqual(0);
    expect(at('backups')).toBeLessThan(at('privacy'));
    expect(at('privacy')).toBeLessThan(at('audit'));
    expect(at('audit')).toBe(hrefs.length - 1);
  });

  it('keeps saying nothing is sent yet on a server you run yourself', async () => {
    state = settings({ mode: 'self', enabled: false });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.hourlyNote);
    expect(textOf(panel())).not.toContain(PRIVACY_COPY.hourlyNoteHosted);
    expect(textOf(previewButton())).toBe(PRIVACY_COPY.previewButton);
  });

  it('lays out the switch, its description, the state note, then the lists under their subheadings', async () => {
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    const kids = need(panel(), '.privacy-admin').children.map((el) => ({ cls: el.className }));
    const at = (cls: string) => kids.findIndex((k) => k.cls.split(' ').includes(cls));
    // the description sits directly under the switch, then the state note, then the first rule (the first section)
    expect(at('privacy-description')).toBe(at('privacy-toggle') + 1);
    expect(at('privacy-state-note')).toBe(at('privacy-description') + 1);
    expect(at('privacy-section')).toBeGreaterThan(at('privacy-state-note'));
    expect(textOf(need(panel(), '.privacy-description'))).toBe(PRIVACY_COPY.analyticsText);
    const subheads = panel().querySelectorAll('.privacy-subhead').map((el) => textOf(el));
    expect(subheads).toEqual(['What this switch covers', 'Stays on either way']);
    // the error-reports line is under "Stays on either way", not in the switch list
    const lists = panel().querySelectorAll('.privacy-section');
    expect(textOf(lists[0])).not.toContain('Error reports');
    expect(textOf(lists[1])).toContain('Error reports (with an error code and the version; not collected yet)');

    state = settings({ mode: 'self', enabled: false });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();
    expect(panel().querySelectorAll('.privacy-subhead').map((el) => textOf(el))[0]).toBe('Sent when this is on');
  });

  it('leaves out a category key this build has no sentence for', async () => {
    state = settings({ categories: ['feature_counts', 'device_class'], operational: ['performance', 'something_new'] });
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    expect(textOf(panel())).not.toContain('device_class');
    expect(textOf(panel())).not.toContain('something_new');
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.feature_counts);
  });

  it('lists only operating categories on a server you run, and keeps feature_counts off that list', async () => {
    state = settings({ mode: 'self', categories: ['feature_counts'], operational: ['performance', 'backup state', 'workspace_scale'] });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.performance);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories['backup state']);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.workspace_scale);
    expect(textOf(panel())).not.toContain(PRIVACY_COPY.categories.feature_counts);
    expect(textOf(panel())).not.toContain('Also sent when this is on');
    expect(panel().querySelectorAll('.privacy-subhead').map((el) => textOf(el))).toEqual(['Sent when this is on']);

    state = settings();
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    expect(panel().querySelectorAll('.privacy-subhead').map((el) => textOf(el))).toEqual(['What this switch covers', 'Stays on either way']);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.feature_counts);
  });

  it('lets an owner change the setting and reports the saved state', async () => {
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(textOf(panel())).toContain(PRIVACY_COPY.hourlyNoteHosted);
    expect(textOf(panel())).not.toContain('Nothing has been sent');
    expect(textOf(previewButton())).toBe(PRIVACY_COPY.previewButtonHosted);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.performance);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.error_codes);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories['backup state']);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.workspace_scale);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.performance);
    expect(textOf(panel())).toContain(PRIVACY_COPY.categories.feature_counts);
    expect(textOf(panel())).toContain(PRIVACY_COPY.operationalLead);
    expect(textOf(panel())).toContain(PRIVACY_COPY.neverSent[0]);
    expect(textOf(panel())).toContain('Last changed by Owner, ');
    expect(need(panel(), 'details').hasAttribute('open')).toBe(false);
    expect(textOf(need(panel(), 'details summary'))).toBe('What is never sent');

    toggle().checked = false;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/admin/privacy', body: { enabled: false } }]);
    expect(toggle().checked).toBe(false);
    expect(textOf(panel())).toContain(PRIVACY_COPY.saved);
    expect(browser.document.body.querySelector('.modal')).toBeNull();

    toggle().checked = true;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    expect(toggle().checked).toBe(true);
    expect(browser.document.body.querySelector('.modal')).toBeNull();
  });

  it('lets admins read the setting without changing it', async () => {
    renderAdmin(root as unknown as HTMLElement, 'privacy', admin);
    await flush();
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(textOf(panel())).toContain(PRIVACY_COPY.ownerOnly);
    toggle().checked = false;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
  });

  it('explains an environment lock and keeps the switch disabled', async () => {
    state = settings({ enabled: false, locked: 'env', mode: 'self', lastBuiltAt: null });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(textOf(panel())).toContain(PRIVACY_COPY.envLocked);
    expect(textOf(panel())).toContain(PRIVACY_COPY.neverBuilt);
    expect(textOf(panel())).toContain(PRIVACY_COPY.selfIntro);
  });

  it('confirms self-hosted opt-in and leaves the setting off when canceled', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    state = settings({ mode: 'self', enabled: false, lastBuiltAt: null });
    renderAdmin(root as unknown as HTMLElement, 'privacy', selfOwner);
    await flush();

    toggle().checked = true;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    const modal = browser.document.body.querySelector('.modal') as FakeElement;
    expect(textOf(modal)).toContain('Send telemetry to Tabula?');
    expect(textOf(modal)).toContain('This server will prepare the operating data listed on this page once an hour, and nothing else. Nothing is sent yet; sending starts in a later version. You can turn it off at any time.');
    const buttons = modal.querySelectorAll('.modal-actions button');
    expect(buttons.map(textOf)).toEqual(['Cancel', 'Turn on']);
    buttons[0].click();
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    expect(toggle().checked).toBe(false);

    toggle().checked = true;
    toggle().dispatchEvent(new FakeEvent('change'));
    await flush();
    const confirm = browser.document.body.querySelector('.modal') as FakeElement;
    confirm.querySelectorAll('.modal-actions button')[1].click();
    await flush();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/admin/privacy', body: { enabled: true } }]);
    expect(state.enabled).toBe(true);
    expect(browser.document.body.querySelector('.modal')).toBeNull();
  });

  it('shows, copies and safely renders the exact report preview while keeping focus', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn<(text: string) => Promise<void>>(async (text) => { copied.push(text); }) } });
    state = settings({ lastBuiltAt: null });
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();

    previewButton().focus();
    previewButton().click();
    await flush();
    expect(calls.filter((call) => call.path === '/api/admin/privacy/preview')).toHaveLength(1);
    expect(previewButton().getAttribute('aria-expanded')).toBe('true');
    expect(textOf(previewButton())).toBe(PRIVACY_COPY.hidePreviewButton);
    expect(textOf(panel())).toContain(PRIVACY_COPY.lastBuilt);
    expect(textOf(panel())).not.toContain(PRIVACY_COPY.neverBuilt);
    const json = need(panel(), '.privacy-json');
    const expected = JSON.stringify(preview.preview, null, 2);
    expect(json.textContent).toBe(expected);
    expect(json.innerHTML).toBe('');
    expect(json.getAttribute('tabindex')).toBe('0');
    expect(json.getAttribute('aria-label')).toBe('Telemetry report preview');
    const previewContainer = need(panel(), '.privacy-preview');
    const previewContent = previewContainer.children[0];
    expect(previewContent.children.findIndex((el) => el.getAttribute('class') === 'privacy-actions')).toBeLessThan(previewContent.children.indexOf(json));
    expect(browser.document.activeElement.dataset.focus).toBe('preview');

    need(panel(), '[data-focus=copy]').click();
    await flush();
    expect(copied).toEqual([expected]);
    expect(textOf(panel())).toContain(PRIVACY_COPY.copied);
    expect(need(panel(), '.privacy-doc-link').getAttribute('href')).toBe(PRIVACY_COPY.catalogueHref);
  });

  it('explains that sending starts later when no report has been sent', async () => {
    preview = { preview: null, builtAt: Date.UTC(2026, 9, 12, 9, 0), note: 'Nothing has been sent' };
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    previewButton().click();
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.noSentHosted);
    expect(panel().querySelector('.privacy-json')).toBeNull();
    expect(panel().querySelector('[data-focus=copy]')).toBeNull();
  });

  it('says plainly that the workspace id is not valid for telemetry when no report can be built', async () => {
    preview = { preview: null, problem: 'workspace_id', builtAt: Date.UTC(2026, 9, 12, 9, 0), note: 'Collected by Tabula once an hour, as shown' };
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    previewButton().click();
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.workspaceIdInvalid);
    expect(textOf(panel())).not.toContain(PRIVACY_COPY.noSentHosted);
    expect(panel().querySelector('.privacy-json')).toBeNull();
  });

  it('can retry a failed preview request', async () => {
    failPreviews = 1;
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    previewButton().click();
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.previewFailed);
    need(panel(), '.privacy-preview [data-focus=preview]').click();
    await flush();
    expect(need(panel(), '.privacy-json').textContent).toBe(JSON.stringify(preview.preview, null, 2));
    expect(calls.filter((call) => call.path === '/api/admin/privacy/preview')).toHaveLength(2);
  });

  it('can retry a failed settings load', async () => {
    failLoads = 1;
    renderAdmin(root as unknown as HTMLElement, 'privacy', owner);
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.loadFailed);
    need(panel(), '[data-focus=retry]').click();
    await flush();
    expect(textOf(panel())).toContain(PRIVACY_COPY.switchLabel);
    expect(calls.filter((call) => call.path === '/api/admin/privacy')).toHaveLength(2);
  });
});
