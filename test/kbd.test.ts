import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tipContent } from '../src/tooltip';
import { kbdHint } from '../src/ui/kbd';
import { installFakeBrowser, type FakeBrowser, type FakeElement } from './fake-dom';

let browser: FakeBrowser;
beforeEach(() => { browser = installFakeBrowser(); });
afterEach(() => browser.uninstall());

describe('kbdHint()', () => {
  it('renders platform shortcut keys as individual keycaps', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const hint = kbdHint('Ctrl/Cmd+Shift+L');
    expect(hint.getAttribute('aria-label')).toBe('Ctrl/Cmd+Shift+L');
    expect(Array.from((hint as unknown as FakeElement).querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(['⌘', '⇧', 'L']);
  });

  it('uses key names on other platforms and accepts tooltip shortcuts directly', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const hint = kbdHint('Ctrl/Cmd+Enter');
    expect(Array.from((hint as unknown as FakeElement).querySelectorAll('kbd')).map((key) => key.textContent)).toEqual(['Ctrl', 'Enter']);
    expect(tipContent({ tip: 'Create issue', ariaLabel: null, keyId: null, keys: 'Ctrl/Cmd+Enter' }, () => undefined))
      .toEqual({ label: 'Create issue', keys: 'Ctrl/Cmd+Enter' });
  });
});
