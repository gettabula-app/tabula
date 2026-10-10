import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardApp } from '../src/app';
import type { AiConfig, UserRole } from '../src/api';
import { aiBarFor, aiBarShown, mountAiBar } from '../src/ui/ai-bar';
import { openAiConfig } from '../server/ai/routes.mjs';
import { aiCreditsAvailable } from '../server/ai/settings.mjs';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

const auth = vi.hoisted(() => ({ mode: 'signed-in' as 'signed-in' | 'open', role: 'member' as UserRole, listeners: new Set<() => void>() }));
vi.mock('../src/auth', () => ({
  authState: () => auth.mode === 'open' ? { mode: 'open' } : { mode: 'signed-in', me: { user: { role: auth.role } } },
  onAuth: (fn: () => void) => { auth.listeners.add(fn); return () => auth.listeners.delete(fn); },
}));

let browser: FakeBrowser;
let destroyers: (() => void)[];

beforeEach(() => {
  browser = installFakeBrowser();
  destroyers = [];
  auth.mode = 'signed-in';
  auth.role = 'member';
  auth.listeners.clear();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('Element', FakeElement);
  class NoObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', NoObserver);
  vi.stubGlobal('MutationObserver', NoObserver);
});

afterEach(() => {
  destroyers.forEach((destroy) => destroy());
  browser.uninstall();
  vi.unstubAllGlobals();
});

const config = (enabled: boolean, keySource: AiConfig['keySource'], options: Partial<AiConfig> = {}): AiConfig => ({
  enabled, features: ['summarise', 'cluster', 'generate'], keySource, provider: keySource ? 'anthropic' : null, model: 'claude-haiku-5-5',
  personalKeys: false, hasSecret: false, myKey: null, credits: false, ...options,
});
const personalKey: NonNullable<AiConfig['myKey']> = { provider: 'anthropic', hint: '1234', baseUrl: null, model: null, createdAt: 1, lastUsedAt: null };

function mount(role: UserRole, answer: AiConfig, mode: 'signed-in' | 'open' = 'signed-in') {
  auth.mode = mode;
  auth.role = role;
  const chrome = browser.document.createElement('div');
  browser.document.body.appendChild(chrome);
  const root = browser.document.createElement('div');
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  const store = { cache: new Map(), get: () => undefined, frameOf: () => undefined };
  const r = {
    root, cursorLayer, cam: { x: 0, y: 0, zoom: 1 }, bounds: () => ({ x: 0, y: 0, w: 1, h: 1 }), isHidden: () => false, contentBounds: () => null,
    toScreen: (p: { x: number; y: number }) => p, setOverlay: () => undefined, onCamera: () => () => undefined,
    viewport: () => ({ x: 0, y: 0, w: 800, h: 600 }),
  };
  const app = {
    r, store, selection: [], flow: { isHidden: () => false }, user: { id: 'u1', name: 'Johan', color: '#2F6FED' },
    readOnly: false,
    on: () => () => undefined,
    onDestroy: (fn: () => void) => destroyers.push(fn),
  } as unknown as BoardApp;
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  mountAiBar(app, chrome as unknown as HTMLElement);
  return { app, chrome, fetchMock };
}

async function waitForConfig(fetchMock: ReturnType<typeof mount>['fetchMock']) {
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/ai/config')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectNoBar(t: ReturnType<typeof mount>) {
  expect(t.chrome.querySelector('.aibar')).toBeNull();
  expect(t.chrome.querySelector('.aibar-fab')).toBeNull();
  expect(aiBarFor(t.app)).toBeNull();
  expect(aiBarShown()).toBe(false);
}

describe('AI bar availability', () => {
  it('reports credits only for a hosted workspace whose pushed limits enable them', () => {
    const hosted = { authEnabled: true, cloud: { token: 'secret', url: 'https://cloud.example', workspaceId: 'ws-1' } };
    const enabled = { limits: () => ({ aiCredits: true }) };
    const disabled = { limits: () => ({ aiCredits: false }) };

    expect(aiCreditsAvailable(hosted, enabled)).toBe(true);
    expect(aiCreditsAvailable(hosted, disabled)).toBe(false);
    expect(aiCreditsAvailable(hosted, { limits: () => ({ aiCredits: 'true' }) })).toBe(false);
    expect(aiCreditsAvailable({ authEnabled: true, cloud: null }, enabled)).toBe(false);
    expect(aiCreditsAvailable({ authEnabled: false, cloud: hosted.cloud }, enabled)).toBe(false);
    expect(aiCreditsAvailable(hosted, null)).toBe(false);
  });

  it.each(['member', 'admin', 'owner'] as const)('shows nothing to a workspace %s without a key or credits', async (role) => {
    const t = mount(role, config(true, null));
    await waitForConfig(t.fetchMock);
    expect(t.chrome.querySelector('.aibar')).toBeNull();
    expectNoBar(t);
  });

  it('mounts for a workspace key', async () => {
    const t = mount('member', config(true, 'workspace'));
    await waitForConfig(t.fetchMock);
    await vi.waitFor(() => expect(t.chrome.querySelector('.aibar')).not.toBeNull());
    expect(t.chrome.querySelector('.aibar-fab')).not.toBeNull();
    expect(aiBarFor(t.app)).not.toBeNull();
  });

  it('follows the relay config in open mode', async () => {
    const relayConfig = openAiConfig({ ai: { open: 'operator-key', provider: 'anthropic', model: 'claude-haiku-5-5' }, cloud: null }) as AiConfig;
    expect(relayConfig).toMatchObject({ enabled: true, keySource: 'workspace', credits: false });
    const t = mount('guest', relayConfig, 'open');
    await waitForConfig(t.fetchMock);
    await vi.waitFor(() => expect(t.chrome.querySelector('.aibar')).not.toBeNull());
    expect(t.fetchMock.mock.calls.map(([input]) => String(input))).toContain('/api/ai/config');
  });

  it('mounts when a personal key is allowed and available', async () => {
    const t = mount('member', config(true, 'user', { personalKeys: true, myKey: personalKey }));
    await waitForConfig(t.fetchMock);
    await vi.waitFor(() => expect(t.chrome.querySelector('.aibar')).not.toBeNull());
  });

  it('mounts when the config grants credits without a key', async () => {
    const t = mount('member', config(true, null, { credits: true }));
    await waitForConfig(t.fetchMock);
    await vi.waitFor(() => expect(t.chrome.querySelector('.aibar')).not.toBeNull());
  });

  it('does not use a personal key when personal keys are not allowed', async () => {
    const t = mount('member', config(true, 'user', { personalKeys: false, myKey: personalKey }));
    await waitForConfig(t.fetchMock);
    expect(t.chrome.querySelector('.aibar-fab')).toBeNull();
    expectNoBar(t);
  });

  it('requires AI to be enabled even when a key or credits are available', async () => {
    const t = mount('member', config(false, 'workspace', { credits: true }));
    await waitForConfig(t.fetchMock);
    expect(t.chrome.querySelector('.aibar')).toBeNull();
    expectNoBar(t);
  });
});

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return textFiles(path);
    return /\.(?:css|html|js|json|md|mjs|ts)$/.test(entry.name) ? [path] : [];
  });
}

describe('the AI bar has no feature-flag opt-in', () => {
  it('keeps the old local-storage key, URL parameter and flag reader out of the app and its docs', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = ['src', 'server', 'scripts', 'test', 'docs', 'changelog.d'].flatMap((dir) => textFiles(join(root, dir)));
    // CHANGELOG.md is history and stays as written; the fragments in changelog.d are scanned instead
    const localStorageFlag = ['driftboard:flag:', 'aibar'].join('');
    const urlParameter = ['?', 'aibar'].join('');
    const flagReader = ['aiBar', 'Flag'].join('');
    const queryParameter = /[?&]aibar(?:[=&#]|$)/;
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      expect(contents).not.toContain(localStorageFlag);
      expect(contents).not.toContain(urlParameter);
      expect(contents).not.toMatch(queryParameter);
      expect(contents).not.toContain(flagReader);
    }
  });
});
