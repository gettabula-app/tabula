import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEvent, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';
import { mayToggleBoardPreview, PREVIEW_TOGGLE_TEXT, previewToggle, type PreviewToggleDeps } from '../src/ui/board-preview-toggle';

// The switch in the board menu that keeps a board's picture off its card (src/ui/board-preview-toggle.ts). The server keeps `off`; the switch
// shows the opposite. These tests drive the switch the way a person does (set `checked`, then a change event) and read the answers back.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
});
afterEach(() => browser.uninstall());

type ReadFn = () => Promise<{ off: boolean }>;
type WriteFn = (id: string, off: boolean) => Promise<{ off: boolean }>;

function deps(over: { read?: ReadFn; write?: WriteFn } = {}) {
  const read = vi.fn<ReadFn>(over.read ?? (async () => ({ off: false })));
  const write = vi.fn<WriteFn>(over.write ?? (async (_id: string, off: boolean) => ({ off })));
  const notify = vi.fn<(message: string) => void>(() => undefined);
  const toggleDeps = { read, write, notify } as unknown as PreviewToggleDeps;
  return { read, write, notify, toggleDeps };
}

const box = (el: HTMLElement) => (el as unknown as FakeElement).querySelector('input') as unknown as FakeElement & { checked: boolean; disabled: boolean };
/** A person turns the switch: its state changes, then the change event arrives. */
function turn(el: HTMLElement, on: boolean) {
  const control = box(el);
  control.checked = on;
  control.dispatchEvent(new FakeEvent('change'));
}

describe('the row', () => {
  it('is hidden until the server answers, then shows the stored setting: the switch is on when the picture is shown', async () => {
    const d = deps({ read: async () => ({ off: true }) });
    const toggle = previewToggle('board-1', d.toggleDeps);
    expect(toggle.el.hidden).toBe(true);
    await toggle.load();
    expect(toggle.el.hidden).toBe(false);
    expect(d.read).toHaveBeenCalledWith('board-1');
    expect(box(toggle.el).checked).toBe(false);
    expect(textOf(toggle.el as unknown as FakeElement)).toContain(PREVIEW_TOGGLE_TEXT.label);
    expect(textOf(toggle.el as unknown as FakeElement)).toContain(PREVIEW_TOGGLE_TEXT.help);
  });

  it('stays hidden when the server refuses the read (403: not the owner or a workspace admin)', async () => {
    const d = deps({ read: async () => { throw Object.assign(new Error('no'), { status: 403 }); } });
    const toggle = previewToggle('board-1', d.toggleDeps);
    await toggle.load();
    expect(toggle.el.hidden).toBe(true);
  });

  it('a change is sent as the opposite (off), and the answer sets the switch', async () => {
    const d = deps();
    const toggle = previewToggle('board-1', d.toggleDeps);
    await toggle.load();
    turn(toggle.el, false);
    await vi.waitFor(() => expect(d.write).toHaveBeenCalledTimes(1));
    expect(d.write).toHaveBeenCalledWith('board-1', true);
    expect(d.notify).not.toHaveBeenCalled();
    turn(toggle.el, true);
    await vi.waitFor(() => expect(d.write).toHaveBeenCalledTimes(2));
    expect(d.write).toHaveBeenLastCalledWith('board-1', false);
    expect(box(toggle.el).checked).toBe(true);
  });

  it('a failed change puts the switch back where it was, with a quiet notice, and nothing is thrown', async () => {
    const d = deps({ write: async () => { throw new Error('offline'); } });
    const toggle = previewToggle('board-1', d.toggleDeps);
    await toggle.load();
    turn(toggle.el, false);
    await vi.waitFor(() => expect(d.notify).toHaveBeenCalledWith(PREVIEW_TOGGLE_TEXT.failed));
    expect(box(toggle.el).checked).toBe(true);
    expect(box(toggle.el).disabled).toBe(false);
  });

  it('the switch is disabled while a change is sent, and for a read-only board', async () => {
    let finish: (value: { off: boolean }) => void = () => undefined;
    const d = deps({ write: () => new Promise<{ off: boolean }>((resolve) => { finish = resolve; }) });
    const toggle = previewToggle('board-1', d.toggleDeps);
    await toggle.load();
    turn(toggle.el, false);
    expect(box(toggle.el).disabled).toBe(true);
    finish({ off: true });
    await vi.waitFor(() => expect(box(toggle.el).disabled).toBe(false));

    const locked = previewToggle('board-1', deps().toggleDeps, { readOnly: true });
    expect(box(locked.el).disabled).toBe(true);
  });

  it('a menu search keeps it only when the search is part of its wording', () => {
    const toggle = previewToggle('board-1', deps().toggleDeps);
    expect(toggle.matches('picture')).toBe(true);
    expect(toggle.matches('export')).toBe(false);
  });
});

describe('who is offered the switch', () => {
  const base = { signedIn: true, boardRole: 'editor', workspaceRole: 'member', serverOn: true };

  it('the board owner, a workspace owner, and a workspace admin; an editor who is only a member is not', () => {
    expect(mayToggleBoardPreview({ ...base, boardRole: 'owner' })).toBe(true);
    expect(mayToggleBoardPreview({ ...base, workspaceRole: 'owner' })).toBe(true);
    expect(mayToggleBoardPreview({ ...base, workspaceRole: 'admin' })).toBe(true);
    expect(mayToggleBoardPreview(base)).toBe(false);
    expect(mayToggleBoardPreview({ ...base, boardRole: 'viewer', workspaceRole: 'guest' })).toBe(false);
  });

  it('nobody when signed out, when the server has previews off, or when no role is known', () => {
    expect(mayToggleBoardPreview({ ...base, signedIn: false, boardRole: 'owner' })).toBe(false);
    expect(mayToggleBoardPreview({ ...base, serverOn: false, boardRole: 'owner' })).toBe(false);
    expect(mayToggleBoardPreview({ ...base, boardRole: null, workspaceRole: undefined })).toBe(false);
  });
});
