import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTrackerApi } from '../src/tracker-mock';
import type { TrackerNotificationPrefs } from '../src/tracker-types';
import { mountNotificationPrefs } from '../src/tracker/ui/notification-prefs';
import { FakeElement, control, flush, need, textOf } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

const preferences: TrackerNotificationPrefs = {
  kinds: ['assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity'],
  prefs: {
    assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
    relation_changed: 'app', integration_activity: 'app',
  },
};

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => {
  browser?.uninstall();
  browser = null;
  vi.useRealTimers();
});

function mount(api = createMockTrackerApi({ notificationPrefs: preferences })) {
  const host = browser!.document.createElement('div') as unknown as HTMLElement;
  browser!.document.body.appendChild(host as unknown as FakeElement);
  const announced: string[] = [];
  const controller = mountNotificationPrefs(host, { api, announce: (text) => announced.push(text) });
  return { api, host: host as unknown as FakeElement, controller, announced };
}

describe('tracker notification preferences UI', () => {
  it('renders all kinds, applies changes immediately and announces a successful choice', async () => {
    browser = installTrackerUiBrowser();
    const { api, host, announced } = mount();
    await flush();
    expect(textOf(host)).toContain('Email goes out two minutes after the notice, only if you have not read it.');
    expect(host.querySelectorAll('.trk-prefs-row')).toHaveLength(7);
    expect(textOf(host)).toContain('When someone assigns a ticket to you.');
    expect(host.querySelectorAll('.trk-prefs-select')).toHaveLength(7);
    expect(host.querySelectorAll('[role="radio"], [role="radiogroup"]')).toHaveLength(0);
    const assigned = host.querySelector('[data-kind="assigned"]')!;
    expect(assigned.getAttribute('aria-haspopup')).toBe('listbox');
    expect(assigned.getAttribute('aria-label')).toBe('Assigned to me: In Tabula and email');

    assigned.click();
    const options = browser.document.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options.map((option) => textOf(option))).toEqual(['In Tabula and email', 'In Tabula only', 'Off']);
    options.find((option) => textOf(option) === 'In Tabula only')!.click();
    await flush();
    expect(host.querySelector('[data-kind="assigned"]')?.textContent).toContain('In Tabula only');
    expect((await api.notificationPrefs()).prefs.assigned).toBe('app');
    expect(announced).toEqual(['Assigned to me: In Tabula only']);
  });

  it('keeps focus on a preference picker after choosing a value rerenders its row', async () => {
    browser = installTrackerUiBrowser();
    const { host } = mount();
    await flush();
    const assigned = need(host, '.trk-prefs-select[data-kind="assigned"]');
    assigned.focus();
    assigned.click();
    browser.document.querySelectorAll('[role="option"]')
      .find((option) => textOf(option) === 'In Tabula only')!
      .click();
    await flush();
    const active = browser.document.activeElement as unknown as FakeElement;
    expect(active.classList.contains('trk-prefs-select')).toBe(true);
    expect(active.getAttribute('data-kind')).toBe('assigned');
  });

  it('uses the picker listbox keyboard controls and leaves Tab to move between settings', async () => {
    browser = installTrackerUiBrowser();
    const { host } = mount();
    await flush();
    host.querySelector('[data-kind="assigned"]')!.click();
    const list = browser.document.querySelector('[role="listbox"]')!;
    const event = uiEvent('keydown', { key: 'ArrowDown' });
    list.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    list.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(host.querySelector('[data-kind="assigned"]')?.textContent).toContain('In Tabula only');

    const tab = uiEvent('keydown', { key: 'Tab' });
    host.querySelector('[data-kind="assigned"]')!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(tab.propagationStopped).toBe(false);
  });

  it('rolls back a failed update and retries the requested choice', async () => {
    browser = installTrackerUiBrowser();
    const api = createMockTrackerApi({ notificationPrefs: preferences });
    const save = api.updateNotificationPrefs.bind(api);
    let attempts = 0;
    api.updateNotificationPrefs = async (patch, options) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary preference failure');
      return save(patch, options);
    };
    const { host, announced } = mount(api);
    await flush();

    host.querySelector('[data-kind="assigned"]')!.click();
    browser.document.querySelectorAll('[role="option"]').find((option) => textOf(option) === 'Off')!.click();
    await flush();
    expect(host.querySelector('[data-kind="assigned"]')?.textContent).toContain('In Tabula and email');
    expect(textOf(need(host, '.trk-prefs-row-error'))).toContain('Could not save this preference.');
    control(host, 'Retry').click();
    await flush();
    expect(host.querySelector('[data-kind="assigned"]')?.textContent).toContain('Off');
    expect(textOf(host)).not.toContain('Could not save this preference.');
    expect(announced).toEqual(['Assigned to me: Off']);
  });

  it('shows a loading skeleton and a retryable load error', async () => {
    browser = installTrackerUiBrowser();
    const pendingApi = createMockTrackerApi();
    pendingApi.notificationPrefs = () => new Promise(() => undefined);
    const loading = mount(pendingApi);
    expect(loading.host.querySelectorAll('.trk-prefs-skeleton-row')).toHaveLength(3);
    expect(need(loading.host, '.trk-prefs-skeleton').getAttribute('aria-busy')).toBe('true');
    loading.controller.destroy();

    const api = createMockTrackerApi({ notificationPrefs: preferences });
    const get = api.notificationPrefs.bind(api);
    let loads = 0;
    api.notificationPrefs = async (options) => {
      loads++;
      if (loads === 1) throw new Error('settings unavailable');
      return get(options);
    };
    const retry = mount(api);
    await flush();
    expect(textOf(need(retry.host, '.trk-prefs-load-error'))).toContain('Could not load notification settings.');
    control(retry.host, 'Retry').click();
    await flush();
    expect(retry.host.querySelectorAll('.trk-prefs-select')).toHaveLength(7);
  });
});
