import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, OAuthConsentRequest } from '../src/api';
import { renderOAuthConsent } from '../src/ui/oauth-consent';
import { renderVerify } from '../src/ui/signin';
import { FakeElement, FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const ENVELOPE = 'opaque_123-xy';
const signedIn: Me = {
  user: { id: 'u1', email: 'ana@example.test', name: 'Ana', role: 'member' },
  teams: [],
  mcpOauth: true,
};
const consentRequest = (patch: Partial<OAuthConsentRequest> = {}): OAuthConsentRequest => ({
  clientName: 'Claude', clientNameIsClaim: true, redirectHost: 'claude.ai',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback', verified: true,
  maxScope: 'write', nonce: 'nonce-first', readOnly: false, ...patch,
});
const boardConsentRequest = (patch: Partial<OAuthConsentRequest> = {}): OAuthConsentRequest => consentRequest({
  pickerAvailable: true,
  scopes: { unrestricted: 'write', boards: 'write' },
  boards: [
    { id: 'board-a', name: 'Alpha', role: 'editor' },
    { id: 'board-b', name: 'Beta', role: 'commenter' },
  ],
  ...patch,
});

interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
interface ServerOptions {
  me?: Me;
  meStatus?: number;
  requests?: OAuthConsentRequest[];
  decisions?: Reply[];
}
interface Call { method: string; url: string; body?: Record<string, unknown> }

let calls: Call[] = [];
let browser: FakeBrowser;
let root: FakeElement;

function response(reply: Reply = {}): Response {
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    headers: { 'content-type': 'application/json', ...reply.headers },
  });
}

function serve(options: ServerOptions = {}): void {
  calls = [];
  let requestAt = 0;
  let decisionAt = 0;
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call: Call = { method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) };
    calls.push(call);
    if (method === 'GET' && url === '/api/me') {
      return response(options.meStatus ? { status: options.meStatus, body: { error: 'unauthenticated', message: 'sign in' } } : { body: options.me ?? signedIn });
    }
    if (method === 'GET' && url.startsWith('/api/oauth/requests?')) {
      const index = Math.min(requestAt++, (options.requests?.length ?? 1) - 1);
      return response({ body: options.requests?.[index] ?? consentRequest() });
    }
    if (method === 'POST' && url === '/api/oauth/requests/decision') {
      const reply = options.decisions?.[decisionAt++] ?? { body: { redirect: 'https://claude.ai/callback?code=one' } };
      return response(reply);
    }
    if (method === 'POST' && url === '/api/auth/request') return response({ body: { ok: true } });
    if (method === 'POST' && url === '/api/auth/verify') return response({ body: { user: signedIn.user } });
    if (method === 'POST' && url === '/api/auth/logout') return response({ status: 204 });
    return response({ status: 404, body: { error: 'not_found', message: 'missing' } });
  });
  vi.stubGlobal('fetch', fetchFn);
}

const page = () => need(root, '.oauth-consent');
const button = (label: string) => page().querySelectorAll('button').find((el) => textOf(el) === label)!;
const apiCalls = (method: string, path: string) => calls.filter((call) => call.method === method && call.url.startsWith(path));

beforeEach(() => {
  browser = installFakeBrowser();
  root = browser.mount();
  (browser.location as unknown as { host: string }).host = 'workspace.example.test';
});

afterEach(() => {
  browser.uninstall();
});

async function open(options: ServerOptions = {}) {
  serve(options);
  renderOAuthConsent(root as unknown as HTMLElement, ENVELOPE);
  await flush();
}

// A real browser unchecks the other radios of the group; the fake DOM does not.
function choose(value: string): void {
  const radios = page().querySelectorAll('input[type="radio"]');
  const target = radios.find((radio) => radio.value === value)!;
  const group = target.getAttribute('name');
  for (const radio of radios) {
    if (radio.getAttribute('name') === group) radio.checked = radio === target;
  }
  target.dispatchEvent(new FakeEvent('change'));
}

function checkBoard(id: string): FakeElement {
  const checkbox = page().querySelectorAll('input[type="checkbox"]').find((input) => input.value === id)!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new FakeEvent('change'));
  return checkbox;
}

function uncheckBoard(id: string): FakeElement {
  const checkbox = page().querySelectorAll('input[type="checkbox"]').find((input) => input.value === id)!;
  checkbox.checked = false;
  checkbox.dispatchEvent(new FakeEvent('change'));
  return checkbox;
}

describe('OAuth consent panel', () => {
  it('sends Deny without a scope and navigates to the server redirect', async () => {
    await open();
    expect(textOf(page())).toContain('An app that claims to be ‘Claude’ wants access to workspace.example.test');
    expect(browser.document.activeElement).toBe(need(page(), 'h1'));
    button('Deny').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[0].body).toEqual({
      request: ENVELOPE, decision: 'deny', nonce: 'nonce-first',
    });
    expect(browser.location.assign).toHaveBeenCalledWith('https://claude.ai/callback?code=one');
  });

  it('sends the selected access level on Allow', async () => {
    await open();
    choose('comment');
    button('Allow').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[0].body).toEqual({
      request: ENVELOPE, decision: 'allow', scope: 'comment', nonce: 'nonce-first',
    });
    expect(browser.location.assign).toHaveBeenCalledWith('https://claude.ai/callback?code=one');
  });

  it('limits displayed options to maxScope and disables Allow for a read-only workspace', async () => {
    await open({ requests: [consentRequest({ maxScope: 'read', readOnly: true })] });
    expect(page().querySelectorAll('input[type="radio"]')).toHaveLength(1);
    expect(button('Allow').disabled).toBe(true);
    expect(button('Deny').disabled).toBe(false);
    expect(textOf(page())).toContain('Your role limits this app to reading.');
    expect(textOf(page())).toContain('This workspace is read-only. Ask the workspace owner to check billing.');
  });

  it('hides the picker when pickerAvailable is false', async () => {
    await open({ requests: [boardConsentRequest({ pickerAvailable: false })] });
    expect(page().querySelector('.oauth-consent-picker')).toBeNull();
    expect(page().querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('treats an omitted pickerAvailable field as unavailable on older servers', async () => {
    await open({ requests: [consentRequest({ boards: boardConsentRequest().boards })] });
    expect(page().querySelector('.oauth-consent-picker')).toBeNull();
    expect(page().querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('hides the picker when there are no boards', async () => {
    await open({ requests: [boardConsentRequest({ boards: [] })] });
    expect(page().querySelector('.oauth-consent-picker')).toBeNull();
    expect(page().querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('requires at least one chosen board before Allow', async () => {
    await open({ requests: [boardConsentRequest()] });
    choose('boards');
    expect(button('Allow').disabled).toBe(true);
    button('Allow').click();
    expect(apiCalls('POST', '/api/oauth/requests/decision')).toHaveLength(0);
    checkBoard('board-a');
    expect(button('Allow').disabled).toBe(false);
  });

  it('caps the board selection at fifty and disables remaining boards', async () => {
    const boards = Array.from({ length: 51 }, (_, index) => ({
      id: `board-${index + 1}`, name: `Board ${index + 1}`, role: 'editor',
    }));
    await open({ requests: [boardConsentRequest({ boards })] });
    choose('boards');
    for (const board of boards.slice(0, 50)) checkBoard(board.id);
    const checkboxes = page().querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(51);
    expect(checkboxes[49].disabled).toBe(false);
    expect(checkboxes[50].disabled).toBe(true);
    expect(need(page(), '.oauth-consent-board-count').textContent).toBe('50 boards chosen, the most allowed.');
  });

  it('snaps the selected scope to Read when the chosen-board ceiling is lower', async () => {
    await open({ requests: [boardConsentRequest()] });
    choose('boards');
    checkBoard('board-a');
    choose('write');
    checkBoard('board-b');
    uncheckBoard('board-a');
    const scopes = page().querySelectorAll('input[name="oauth-scope"]');
    expect(scopes).toHaveLength(2);
    expect(scopes[0].value).toBe('read');
    expect(scopes[0].checked).toBe(true);
    expect(scopes[1].value).toBe('comment');
  });

  it('sends no boardIds when Allow uses all boards', async () => {
    await open({ requests: [boardConsentRequest()] });
    button('Allow').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[0].body).toEqual({
      request: ENVELOPE, decision: 'allow', scope: 'read', nonce: 'nonce-first',
    });
  });

  it('sends selected boardIds when Allow uses the board picker', async () => {
    await open({ requests: [boardConsentRequest()] });
    choose('boards');
    checkBoard('board-b');
    choose('comment');
    button('Allow').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[0].body).toEqual({
      request: ENVELOPE, decision: 'allow', scope: 'comment', nonce: 'nonce-first', boardIds: ['board-b'],
    });
  });

  it('never sends boardIds on Deny from board mode', async () => {
    await open({ requests: [boardConsentRequest()] });
    choose('boards');
    checkBoard('board-a');
    button('Deny').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[0].body).toEqual({
      request: ENVELOPE, decision: 'deny', nonce: 'nonce-first',
    });
  });

  it.each([
    [429, 'rate_limited', { 'retry-after': '12' }, 'Too many requests. Try again in 12 seconds.'],
    [402, 'read_only', undefined, 'This workspace is read-only. Ask the workspace owner to check billing.'],
    [409, 'grant_limit', undefined, 'You can have at most 20 connected apps. Disconnect one first.'],
  ] as const)('shows the %i %s decision error', async (status, code, headers, sentence) => {
    await open({ decisions: [{ status, body: { error: code, message: 'server details' }, headers }] });
    button('Allow').click();
    await flush();
    expect(textOf(root)).toContain(sentence);
    expect(textOf(root)).not.toContain('server details');
    expect(button('Deny').disabled).toBe(false);
    expect(button('Allow').disabled).toBe(false);
    expect(apiCalls('GET', '/api/oauth/requests?')).toHaveLength(1);
  });

  it('shows one line and no buttons when the decision answers 404', async () => {
    await open({ decisions: [{ status: 404, body: { error: 'not_found', message: 'server details' } }] });
    button('Allow').click();
    await flush();
    expect(textOf(root)).toContain('This connection request is no longer valid. Go back to the app and start again.');
    expect(textOf(root)).not.toContain('server details');
    expect(root.children).toHaveLength(1);
    expect(root.querySelectorAll('button')).toHaveLength(0);
  });

  it('re-fetches consent after invalid_scope and uses the fresh nonce', async () => {
    await open({
      requests: [consentRequest(), consentRequest({ nonce: 'nonce-fresh' })],
      decisions: [{ status: 400, body: { error: 'invalid_scope', message: 'server details' } }, { body: { redirect: 'https://claude.ai/callback?code=two' } }],
    });
    choose('write');
    button('Allow').click();
    await flush();
    expect(textOf(page())).toContain('The available access level changed. Review the updated request.');
    expect(apiCalls('GET', '/api/oauth/requests?')).toHaveLength(2);
    choose('comment');
    button('Allow').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[1].body).toEqual({
      request: ENVELOPE, decision: 'allow', scope: 'comment', nonce: 'nonce-fresh',
    });
    expect(browser.location.assign).toHaveBeenCalledWith('https://claude.ai/callback?code=two');
  });

  it('refreshes the list after invalid_boards and keeps still-available ticks', async () => {
    await open({
      requests: [
        boardConsentRequest(),
        boardConsentRequest({
          nonce: 'nonce-fresh',
          boards: [
            { id: 'board-a', name: 'Alpha updated', role: 'editor' },
            { id: 'board-c', name: 'Gamma', role: 'commenter' },
          ],
        }),
      ],
      decisions: [
        { status: 400, body: { error: 'invalid_boards', message: 'server details' } },
        { body: { redirect: 'https://claude.ai/callback?code=two' } },
      ],
    });
    choose('boards');
    checkBoard('board-a');
    button('Allow').click();
    await flush();
    expect(textOf(page())).toContain('A chosen board is no longer available. Review the updated list.');
    expect(apiCalls('GET', '/api/oauth/requests?')).toHaveLength(2);
    expect(page().querySelectorAll('input[type="checkbox"]')[0].checked).toBe(true);
    expect(page().querySelectorAll('input[type="checkbox"]')[1].value).toBe('board-c');
    button('Allow').click();
    await flush();
    expect(apiCalls('POST', '/api/oauth/requests/decision')[1].body).toEqual({
      request: ENVELOPE, decision: 'allow', scope: 'read', nonce: 'nonce-fresh', boardIds: ['board-a'],
    });
  });

  it('shows no client name before sign-in and passes the envelope into the login request', async () => {
    await open({ meStatus: 401 });
    expect(textOf(root)).toContain('Sign in to connect an app to Tabula.');
    expect(textOf(root)).not.toContain('Claude');
    need(root, 'input[name="email"]').value = 'ana@example.test';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(apiCalls('POST', '/api/auth/request')[0].body).toEqual({ email: 'ana@example.test', oauthRequest: ENVELOPE });
  });

  it('returns a successful email verification with the same OAuth envelope', async () => {
    serve();
    const done = vi.fn<(me: Me, oauthRequest?: string) => void>();
    await renderVerify(root as unknown as HTMLElement, 'login-token', done, ENVELOPE);
    expect(done).toHaveBeenCalledWith(signedIn, ENVELOPE);
  });

  it('keeps the same envelope when the person signs out before connecting', async () => {
    await open();
    page().querySelectorAll('button').find((el) => textOf(el) === 'Not you? Sign out')!.click();
    await flush();
    expect(textOf(root)).toContain('Sign in to connect an app to Tabula.');
    need(root, 'input[name="email"]').value = 'ana@example.test';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(apiCalls('POST', '/api/auth/logout')).toHaveLength(1);
    expect(apiCalls('POST', '/api/auth/request')[0].body).toEqual({ email: 'ana@example.test', oauthRequest: ENVELOPE });
  });

  it('does not reveal a consent request to a guest session', async () => {
    await open({ me: { ...signedIn, user: { ...signedIn.user, role: 'guest' } } });
    expect(textOf(root)).toBe('This connection request is no longer valid. Go back to the app and start again.');
    expect(apiCalls('GET', '/api/oauth/requests?')).toHaveLength(0);
  });

  it('renders hostile client names as text and shows the unverified destination warning', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    await open({ requests: [consentRequest({ clientName: hostile, verified: false })] });
    const heading = need(page(), 'h1');
    expect(textOf(heading)).toContain(hostile);
    expect(heading.innerHTML).toBe('');
    expect(page().querySelectorAll('img')).toHaveLength(0);
    expect(textOf(page())).toContain('Tabula has not verified this destination. Only continue if you started this connection yourself.');
    expect(textOf(page())).not.toContain('Verified host');
  });

  it('renders hostile board names as text', async () => {
    const hostile = '<img src=x onerror=1>';
    await open({ requests: [boardConsentRequest({ boards: [{ id: 'board-x', name: hostile, role: 'editor' }] })] });
    const boardName = need(page(), '.oauth-consent-board-name');
    expect(textOf(boardName)).toBe(hostile);
    expect(boardName.innerHTML).toBe('');
    expect(page().querySelectorAll('img')).toHaveLength(0);
  });

  it('renders only the plain framing line and does not call the API inside a frame', () => {
    const oldWindow = window as unknown as Record<string, unknown>;
    vi.stubGlobal('window', { ...oldWindow, top: {}, self: {} });
    serve();
    renderOAuthConsent(root as unknown as HTMLElement, ENVELOPE);
    expect(textOf(root)).toBe('This page cannot be shown inside another page.');
    expect(root.children).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed envelope before making any API call', () => {
    serve();
    renderOAuthConsent(root as unknown as HTMLElement, 'bad envelope!');
    expect(textOf(root)).toBe('This connection request is no longer valid. Go back to the app and start again.');
    expect(root.children).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});
