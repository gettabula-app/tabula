import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { openChatNotifications } from '../src/ui/chat-prefs';
import { FakeEvent, flush, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Mentions: the mention email, on until turned off. docs/notifications.md, Settings: the four switches of the bell.
// The one dialog, "Notification settings", holds both: "In your notifications" and "Email". Each switch is saved as it is changed.

let browser: FakeBrowser;
let stored = true;
let chatOn = true;
let notif = { mentions: true, replies: true, cards: true, shares: true };

vi.mock('../src/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth')>()),
  chatAvailable: () => chatOn,
}));

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800 });
  stored = true;
  chatOn = true;
  notif = { mentions: true, replies: true, cards: true, shares: true };
  vi.spyOn(api, 'chatPrefs').mockImplementation(async () => ({ emailMentions: stored }));
  vi.spyOn(api, 'setChatPrefs').mockImplementation(async (p) => {
    stored = p.emailMentions;
    return { emailMentions: stored };
  });
  vi.spyOn(api, 'notificationPrefs').mockImplementation(async () => ({ prefs: { ...notif } }));
  vi.spyOn(api, 'setNotificationPrefs').mockImplementation(async (p) => {
    notif = { ...notif, ...p };
    return { prefs: { ...notif } };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  browser.uninstall();
});

const dialogEl = () => browser.document.body.querySelector('.modal')!;
/** The switch whose label contains the text. */
const switchFor = (text: string) => {
  const label = [...dialogEl().querySelectorAll('label')].find((l) => textOf(l).includes(text));
  if (!label) throw new Error(`no switch labelled "${text}"`);
  return label.querySelector('input') as unknown as HTMLInputElement;
};
const emailBox = () => switchFor('Email me when I am mentioned in chat');
const toggle = (box: HTMLInputElement, on: boolean) => {
  box.checked = on;
  box.dispatchEvent(new FakeEvent('change') as unknown as Event);
};

const SWITCH_LABELS = [
  'Mentions of me in chats and comments',
  'Replies to my comments',
  'Cards that are due or assigned to me',
  'Boards and teams shared with me',
];

describe('notification settings dialog', () => {
  it('opens as a named dialog with the email switch off until the setting has loaded', async () => {
    stored = false;
    openChatNotifications();
    expect(dialogEl().getAttribute('aria-labelledby')).toBeTruthy();
    expect(textOf(dialogEl())).toContain('Notification settings');
    expect(emailBox().disabled).toBe(true);
    await flush();
    expect(emailBox().disabled).toBe(false);
    expect(emailBox().checked).toBe(false);
    expect(textOf(dialogEl())).toContain('Email me when I am mentioned in chat');
  });

  it('shows the email switch on for someone who never changed it', async () => {
    openChatNotifications();
    await flush();
    expect(emailBox().checked).toBe(true);
  });

  it('says when the email goes and what is in it', () => {
    openChatNotifications();
    expect(textOf(dialogEl())).toContain('10 minutes');
    expect(textOf(dialogEl())).toContain('first words');
  });

  it('saves a change to the email switch as it is made', async () => {
    openChatNotifications();
    await flush();
    toggle(emailBox(), false);
    await flush();
    expect(api.setChatPrefs).toHaveBeenCalledWith({ emailMentions: false });
    expect(stored).toBe(false);
    expect(emailBox().disabled).toBe(false);
  });

  it('puts the email switch back when it could not be saved', async () => {
    openChatNotifications();
    await flush();
    vi.mocked(api.setChatPrefs).mockRejectedValue(new Error('offline'));
    toggle(emailBox(), false);
    await flush();
    expect(emailBox().checked).toBe(true);
    expect(emailBox().disabled).toBe(false);
  });

  it('says so when the email setting could not be loaded', async () => {
    vi.mocked(api.chatPrefs).mockRejectedValue(new Error('offline'));
    openChatNotifications();
    await flush();
    expect(textOf(dialogEl())).toContain('Could not load your settings');
    expect(emailBox().disabled).toBe(true);
  });
});

describe('notification settings: in your notifications', () => {
  it('has the two sections, with the four switches under the first and the email switch under the second', async () => {
    openChatNotifications();
    await flush();
    const headings = [...dialogEl().querySelectorAll('h3')].map((el) => textOf(el));
    expect(headings).toEqual(['In your notifications', 'Email']);
    for (const label of SWITCH_LABELS) expect(switchFor(label)).toBeTruthy();
    expect(dialogEl().querySelectorAll('input[type="checkbox"]')).toHaveLength(5);
  });

  it('shows each switch as the person has it, with all four on for someone who never changed them', async () => {
    notif = { mentions: false, replies: true, cards: false, shares: true };
    openChatNotifications();
    expect(switchFor(SWITCH_LABELS[0]).disabled).toBe(true);
    await flush();
    expect(switchFor(SWITCH_LABELS[0]).checked).toBe(false);
    expect(switchFor(SWITCH_LABELS[1]).checked).toBe(true);
    expect(switchFor(SWITCH_LABELS[2]).checked).toBe(false);
    expect(switchFor(SWITCH_LABELS[3]).checked).toBe(true);
    expect(switchFor(SWITCH_LABELS[0]).disabled).toBe(false);
  });

  it('saves only the switch that was changed, as it is changed', async () => {
    openChatNotifications();
    await flush();
    toggle(switchFor(SWITCH_LABELS[2]), false);
    await flush();
    expect(api.setNotificationPrefs).toHaveBeenCalledTimes(1);
    expect(api.setNotificationPrefs).toHaveBeenCalledWith({ cards: false });
    expect(notif).toEqual({ mentions: true, replies: true, cards: false, shares: true });
    expect(switchFor(SWITCH_LABELS[2]).disabled).toBe(false);
    expect(switchFor(SWITCH_LABELS[2]).checked).toBe(false);
  });

  it('puts a switch back when it could not be saved', async () => {
    openChatNotifications();
    await flush();
    vi.mocked(api.setNotificationPrefs).mockRejectedValue(new Error('offline'));
    toggle(switchFor(SWITCH_LABELS[3]), false);
    await flush();
    expect(switchFor(SWITCH_LABELS[3]).checked).toBe(true);
    expect(switchFor(SWITCH_LABELS[3]).disabled).toBe(false);
  });

  it('says so when the switches could not be loaded, and leaves them off', async () => {
    vi.mocked(api.notificationPrefs).mockRejectedValue(new Error('offline'));
    openChatNotifications();
    await flush();
    expect(textOf(dialogEl())).toContain('Could not load your notification settings');
    expect(switchFor(SWITCH_LABELS[0]).disabled).toBe(true);
  });

  it('leaves out the email section when chat is off, and asks for no chat setting', async () => {
    chatOn = false;
    openChatNotifications();
    await flush();
    const headings = [...dialogEl().querySelectorAll('h3')].map((el) => textOf(el));
    expect(headings).toEqual(['In your notifications']);
    expect(textOf(dialogEl())).not.toContain('Email me when I am mentioned in chat');
    expect(api.chatPrefs).not.toHaveBeenCalled();
    expect(switchFor(SWITCH_LABELS[0]).checked).toBe(true);
  });
});
