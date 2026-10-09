import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { openChatNotifications } from '../src/ui/chat-prefs';
import { FakeEvent, flush, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Mentions: the person's one chat setting, mention emails, on until turned off, saved as it is changed.

let browser: FakeBrowser;
let stored = true;

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800 });
  stored = true;
  vi.spyOn(api, 'chatPrefs').mockImplementation(async () => ({ emailMentions: stored }));
  vi.spyOn(api, 'setChatPrefs').mockImplementation(async (p) => {
    stored = p.emailMentions;
    return { emailMentions: stored };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  browser.uninstall();
});

const dialogEl = () => browser.document.body.querySelector('.modal')!;
const box = () => dialogEl().querySelector('input')!;
const toggle = (on: boolean) => {
  box().checked = on;
  box().dispatchEvent(new FakeEvent('change'));
};

describe('chat notifications', () => {
  it('opens as a named dialog, with the switch off until the setting has loaded', async () => {
    stored = false;
    openChatNotifications();
    expect(dialogEl().getAttribute('aria-labelledby')).toBeTruthy();
    expect(box().disabled).toBe(true);
    await flush();
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    expect(textOf(dialogEl())).toContain('Email me when I am mentioned in chat');
  });

  it('shows the switch on for someone who never changed it', async () => {
    openChatNotifications();
    await flush();
    expect(box().checked).toBe(true);
  });

  it('says when the email goes and what is in it', () => {
    openChatNotifications();
    expect(textOf(dialogEl())).toContain('10 minutes');
    expect(textOf(dialogEl())).toContain('first words');
  });

  it('saves a change as it is made', async () => {
    openChatNotifications();
    await flush();
    toggle(false);
    await flush();
    expect(api.setChatPrefs).toHaveBeenCalledWith({ emailMentions: false });
    expect(stored).toBe(false);
    expect(box().disabled).toBe(false);
  });

  it('puts the switch back when it could not be saved', async () => {
    openChatNotifications();
    await flush();
    vi.mocked(api.setChatPrefs).mockRejectedValue(new Error('offline'));
    toggle(false);
    await flush();
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
  });

  it('says so when the setting could not be loaded', async () => {
    vi.mocked(api.chatPrefs).mockRejectedValue(new Error('offline'));
    openChatNotifications();
    await flush();
    expect(textOf(dialogEl())).toContain('Could not load your settings');
    expect(box().disabled).toBe(true);
  });
});
