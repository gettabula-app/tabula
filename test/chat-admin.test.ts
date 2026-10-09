import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatSettings } from '../src/api';
import { RETENTION_OPTIONS, chatAdminPanel, retentionNote } from '../src/ui/chat-admin';
import type { AdminKit } from '../src/ui/tokens';
import { FakeEvent, FakeElement, flush, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md, Interface: the admin Chat tab. Rendered into the fake DOM over a stubbed API.

let browser: FakeBrowser;
let stored: ChatSettings;
const calls: Partial<ChatSettings>[] = [];

const kit: AdminKit = {
  head: () => document.createElement('div') as never,
  loadList: () => () => undefined,
  change: async (run) => {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  },
  armable: () => document.createElement('button') as never,
  emptyLine: () => document.createElement('p') as never,
};

beforeEach(() => {
  browser = installFakeBrowser();
  stored = { viewersMayPost: false, retentionDays: 365, workspaceChannel: true };
  calls.length = 0;
  vi.spyOn(api, 'adminChat').mockImplementation(async () => ({ ...stored }));
  vi.spyOn(api, 'setAdminChat').mockImplementation(async (patch) => {
    calls.push(patch);
    stored = { ...stored, ...patch };
    return { ...stored };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  browser.uninstall();
});

const radios = (el: FakeElement) => el.querySelectorAll('[role="radio"]');
const boxes = (el: FakeElement) => el.querySelectorAll('input');
const change = (box: FakeElement, on: boolean) => {
  box.checked = on;
  box.dispatchEvent(new FakeEvent('change'));
};

describe('chatAdminPanel', () => {
  it('shows the three settings as they are stored', async () => {
    const panel = chatAdminPanel(kit) as unknown as FakeElement;
    await flush();
    expect(textOf(panel)).toContain('Workspace channel');
    expect(boxes(panel).map((b) => b.checked)).toEqual([true, false]);
    expect(radios(panel).map((r) => [textOf(r), r.getAttribute('aria-checked')])).toEqual([
      ['1 year', 'true'], ['90 days', 'false'], ['30 days', 'false'], ['Forever', 'false'],
    ]);
    expect(textOf(panel)).toContain('older than 1 year are deleted once a day');
  });

  it('saves the retention choice as it is clicked and says what it means', async () => {
    const panel = chatAdminPanel(kit) as unknown as FakeElement;
    await flush();
    radios(panel)[1].click();
    await flush();
    expect(calls).toEqual([{ retentionDays: 90 }]);
    expect(radios(panel).map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(textOf(panel)).toContain('older than 90 days');
    radios(panel)[3].click();
    await flush();
    expect(calls.at(-1)).toEqual({ retentionDays: null });
    expect(textOf(panel)).toContain('kept until someone deletes them');
  });

  it('does not save the choice that is already made', async () => {
    const panel = chatAdminPanel(kit) as unknown as FakeElement;
    await flush();
    radios(panel)[0].click();
    await flush();
    expect(calls).toEqual([]);
  });

  it('saves the two switches', async () => {
    const panel = chatAdminPanel(kit) as unknown as FakeElement;
    await flush();
    change(boxes(panel)[0], false);
    await flush();
    change(boxes(panel)[1], true);
    await flush();
    expect(calls).toEqual([{ workspaceChannel: false }, { viewersMayPost: true }]);
    expect(boxes(panel).map((b) => b.checked)).toEqual([false, true]);
  });

  it('says so when the settings cannot be loaded', async () => {
    vi.spyOn(api, 'adminChat').mockRejectedValue(new Error('offline'));
    const panel = chatAdminPanel(kit) as unknown as FakeElement;
    await flush();
    expect(textOf(panel)).toContain('could not be loaded');
  });
});

describe('the retention choices', () => {
  it('are a year, 90 days, 30 days and forever, in that order, a year first', () => {
    expect(RETENTION_OPTIONS.map((o) => o.value)).toEqual([365, 90, 30, null]);
  });

  it('say what they do', () => {
    expect(retentionNote(30)).toContain('older than 30 days');
    expect(retentionNote(null)).toContain('until someone deletes');
    expect(retentionNote(365)).toContain('Backups keep them until they expire');
  });
});
