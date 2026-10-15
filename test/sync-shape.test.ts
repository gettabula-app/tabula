import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syncShape, type SyncShape } from '../src/ui/sync-shape';

// The sync status at the top left is only a shape: this pins which shape each state shows, and that the five are told apart.

const SHAPES: SyncShape[] = ['dot', 'ring', 'ringdot', 'bar', 'tri'];

describe('syncShape', () => {
  it('shows a live board as the filled dot', () => {
    expect(syncShape({ status: 'live', denied: null, guestEnded: false })).toBe('dot');
  });

  it('shows saved on this device, waiting for the relay, as a ring', () => {
    expect(syncShape({ status: 'connecting', denied: null, guestEnded: false })).toBe('ring');
  });

  it('shows a workspace being restored as a ring with a centre dot', () => {
    expect(syncShape({ status: 'denied', denied: 'restoring', guestEnded: false })).toBe('ringdot');
  });

  it('shows local only, with no sync, as a bar', () => {
    expect(syncShape({ status: 'local', denied: null, guestEnded: false })).toBe('bar');
  });

  it('shows a sign-in problem as the warning triangle', () => {
    expect(syncShape({ status: 'denied', denied: 'unauthenticated', guestEnded: false })).toBe('tri');
  });

  it('shows any other refusal as the warning triangle', () => {
    expect(syncShape({ status: 'denied', denied: 'no_access', guestEnded: false })).toBe('tri');
  });

  it('shows an ended guest link as the warning triangle', () => {
    expect(syncShape({ status: 'denied', denied: 'access_removed', guestEnded: true })).toBe('tri');
  });

  it('gives the five states five different shapes', () => {
    const shapes = [
      syncShape({ status: 'live', denied: null, guestEnded: false }),
      syncShape({ status: 'connecting', denied: null, guestEnded: false }),
      syncShape({ status: 'denied', denied: 'restoring', guestEnded: false }),
      syncShape({ status: 'local', denied: null, guestEnded: false }),
      syncShape({ status: 'denied', denied: 'no_access', guestEnded: false }),
    ];
    expect(new Set(shapes).size).toBe(5);
  });
});

// The shapes are drawn in styles.css (the sync-status rules, scoped under .chrome > .top-left).
const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const syncRules = css.slice(css.indexOf("[data-shape='dot']"));
const forcedStart = syncRules.indexOf('@media (forced-colors: active) {');
const forced = syncRules.slice(forcedStart, syncRules.indexOf('\n}', forcedStart));

describe('the sync status shapes (styles.css)', () => {
  it.each(SHAPES)('draws the %s shape with a [data-shape] rule on the dot', (shape) => {
    expect(css).toContain(`[data-shape='${shape}'] .sync-status-dot`);
  });

  it('keeps every shape visible in forced colours', () => {
    expect(forced).toContain('CanvasText');
  });
});
