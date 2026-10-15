import { describe, expect, it } from 'vitest';
import type { Workspace } from '../src/api';
import { createRestartNotice, restartText, type RestartStorage } from '../src/restart-notice';

// docs/cloud.md, Restart: the countdown the page shows before a planned server restart. The clock is injected; the server's
// seconds arrive in /api/me and are counted from the moment the page received them, never from a server time.

const MINUTE_TEXT = (n: number) => `The server restarts in about ${n} ${n === 1 ? 'minute' : 'minutes'}. Your changes are kept and the page reconnects by itself.`;
const SOON = 'The server restarts in less than a minute. Your changes are kept and the page reconnects by itself.';

function workspace(restart?: { secondsLeft: number; id: string } | null): Workspace {
  return { readOnly: false, banner: null, seatLimit: null, seatsUsed: 1, restart };
}

function memoryStorage(): RestartStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const brokenStorage: RestartStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

/** A page clock in milliseconds that the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advanceSeconds: (s: number) => {
      t += s * 1000;
    },
    advanceMs: (ms: number) => {
      t += ms;
    },
  };
}

describe('restartText', () => {
  it('rounds whole minutes up: 61 s is about 2 minutes, 60 s about 1 minute', () => {
    expect(restartText(61)).toBe(MINUTE_TEXT(2));
    expect(restartText(60)).toBe(MINUTE_TEXT(1));
    expect(restartText(120)).toBe(MINUTE_TEXT(2));
    expect(restartText(121)).toBe(MINUTE_TEXT(3));
  });

  it('says less than a minute below 60 s, and at 0', () => {
    expect(restartText(59)).toBe(SOON);
    expect(restartText(0)).toBe(SOON);
  });
});

describe('createRestartNotice', () => {
  it('shows nothing until an answer carries a restart', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    expect(notice.view()).toBeNull();
    notice.update(workspace());
    expect(notice.view()).toBeNull();
  });

  it('shows the countdown for the answer it was given, with the id', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 61, id: 'r1' }));
    expect(notice.view()).toEqual({ id: 'r1', text: MINUTE_TEXT(2) });
  });

  it('counts down by the page clock from the moment the answer arrived', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    c.advanceSeconds(130); // 170 s left: 3 minutes when rounded up
    expect(notice.view()?.text).toBe(MINUTE_TEXT(3));
    c.advanceSeconds(111); // 59 s left
    expect(notice.view()?.text).toBe(SOON);
  });

  it('ignores server time: only the seconds left and the page clock matter', () => {
    // Two pages whose clocks disagree by hours see the same countdown: nothing about the server's clock is read.
    const early = clock(0);
    const late = clock(9_999_999_999);
    const a = createRestartNotice({ now: early.now, storage: null });
    const b = createRestartNotice({ now: late.now, storage: null });
    a.update(workspace({ secondsLeft: 200, id: 'r1' }));
    b.update(workspace({ secondsLeft: 200, id: 'r1' }));
    early.advanceSeconds(50);
    late.advanceSeconds(50);
    expect(a.view()).toEqual(b.view());
  });

  it('re-bases on a repeated answer with the same id', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 600, id: 'r1' }));
    c.advanceSeconds(100); // 500 s left by the first answer
    notice.update(workspace({ secondsLeft: 200, id: 'r1' })); // the server says 200 s now
    expect(notice.view()).toEqual({ id: 'r1', text: MINUTE_TEXT(4) });
    c.advanceSeconds(150); // 50 s left from the newer answer
    expect(notice.view()?.text).toBe(SOON);
  });

  it('clears when an answer has no restart, or the workspace is missing', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.update(workspace(null));
    expect(notice.view()).toBeNull();
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.update(null);
    expect(notice.view()).toBeNull();
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.update(undefined);
    expect(notice.view()).toBeNull();
  });

  it('ignores a restart it cannot read, and clears the notice on it', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.update(workspace({ secondsLeft: Number.NaN, id: 'r1' }));
    expect(notice.view()).toBeNull();
    notice.update(workspace({ secondsLeft: 300, id: '' }));
    expect(notice.view()).toBeNull();
  });

  it('expires two minutes after the restart time, not before', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 60, id: 'r1' })); // the restart is at +60 s
    c.advanceSeconds(60);
    expect(notice.view()?.text).toBe(SOON); // at the restart time: 0 left, still shown
    c.advanceSeconds(120);
    expect(notice.view()?.text).toBe(SOON); // exactly two minutes after: still shown
    c.advanceMs(1);
    expect(notice.view()).toBeNull();
  });

  it('hides a dismissed id, and shows a new id again', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.dismiss('r1');
    expect(notice.view()).toBeNull();
    notice.update(workspace({ secondsLeft: 300, id: 'r2' }));
    expect(notice.view()?.id).toBe('r2');
  });

  it('keeps a dismissed id hidden when the same restart is answered again', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.dismiss('r1');
    c.advanceSeconds(10);
    notice.update(workspace({ secondsLeft: 290, id: 'r1' }));
    expect(notice.view()).toBeNull();
  });

  it('remembers a dismissed id for the session, in storage, across page loads', () => {
    const c = clock();
    const storage = memoryStorage();
    createRestartNotice({ now: c.now, storage }).dismiss('r1');
    expect(storage.data.size).toBe(1);
    const reloaded = createRestartNotice({ now: c.now, storage });
    reloaded.update(workspace({ secondsLeft: 300, id: 'r1' }));
    expect(reloaded.view()).toBeNull();
    reloaded.update(workspace({ secondsLeft: 300, id: 'r2' }));
    expect(reloaded.view()?.id).toBe('r2');
  });

  it('survives storage that throws: the dismissal still holds for this page', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: brokenStorage });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    expect(notice.view()?.id).toBe('r1');
    expect(() => notice.dismiss('r1')).not.toThrow();
    expect(notice.view()).toBeNull();
    notice.update(workspace({ secondsLeft: 300, id: 'r2' }));
    expect(notice.view()?.id).toBe('r2');
  });

  it('works with no storage at all (memory only)', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: null });
    notice.update(workspace({ secondsLeft: 300, id: 'r1' }));
    notice.dismiss('r1');
    expect(notice.view()).toBeNull();
  });

  it('never shows the server id or any server words as text', () => {
    const c = clock();
    const notice = createRestartNotice({ now: c.now, storage: memoryStorage() });
    notice.update(workspace({ secondsLeft: 300, id: '<img onerror=x>' }));
    const view = notice.view();
    expect(view?.id).toBe('<img onerror=x>');
    expect(view?.text).toBe(MINUTE_TEXT(5));
    expect(view?.text).not.toContain('<img');
  });
});
