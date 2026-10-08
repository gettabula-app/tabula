import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktop, storedWhere } from '../src/desktop-env';
import { relayUrl } from '../src/sync';

interface Page { desktop?: boolean; protocol?: string; host?: string; relay?: string }

/** A page as the code sees it: Tauri defines `window.__TAURI_INTERNALS__` before any page script runs. */
function openPage({ desktop = false, protocol = 'http:', host = 'localhost:5173', relay }: Page = {}) {
  vi.stubGlobal('window', desktop ? { __TAURI_INTERNALS__: {} } : {});
  vi.stubGlobal('location', { protocol, host });
  vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'driftboard:relay' ? relay ?? null : null) });
}

afterEach(() => vi.unstubAllGlobals());

describe('desktop detection', () => {
  it('is off where there is no window at all (tests, the relay)', () => {
    expect(isDesktop()).toBe(false);
  });

  it('is off in a browser page', () => {
    openPage();
    expect(isDesktop()).toBe(false);
    expect(storedWhere()).toBe('in this browser');
  });

  it('is on when Tauri defined its internals', () => {
    openPage({ desktop: true });
    expect(isDesktop()).toBe(true);
    expect(storedWhere()).toBe('on this computer');
  });
});

describe('relay setting on the desktop', () => {
  it.each(['http:', 'https:', 'tauri:'])('auto means off whatever the page origin is (%s; Windows serves the app from http://tauri.localhost)', (protocol) => {
    openPage({ desktop: true, protocol, host: 'tauri.localhost' });
    expect(relayUrl()).toBeNull();
  });

  it('an explicit relay address still connects, without a trailing slash', () => {
    openPage({ desktop: true, protocol: 'http:', host: 'tauri.localhost', relay: 'wss://relay.example.com/sync/' });
    expect(relayUrl()).toBe('wss://relay.example.com/sync');
  });

  it('off stays off', () => {
    openPage({ desktop: true, relay: 'off' });
    expect(relayUrl()).toBeNull();
  });
});

describe('relay setting in a browser is unchanged', () => {
  it('auto is the origin that serves the app', () => {
    openPage({ protocol: 'http:', host: 'localhost:5173' });
    expect(relayUrl()).toBe('ws://localhost:5173/sync');
    openPage({ protocol: 'https:', host: 'board.example.com' });
    expect(relayUrl()).toBe('wss://board.example.com/sync');
  });

  it('auto is off on a page that is not http or https', () => {
    openPage({ protocol: 'file:', host: '' });
    expect(relayUrl()).toBeNull();
  });

  it('an explicit address and off work as before', () => {
    openPage({ relay: 'wss://relay.example.com/sync//' });
    expect(relayUrl()).toBe('wss://relay.example.com/sync');
    openPage({ relay: 'off' });
    expect(relayUrl()).toBeNull();
  });
});
