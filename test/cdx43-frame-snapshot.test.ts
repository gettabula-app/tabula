import { describe, expect, it } from 'vitest';
import { clearTrackerSnapshots, renderTrackerSnapshot, publishTrackerSnapshot } from '../src/tracker/ui/frame-snapshot';
import { setTrackerGuest, setTrackerMember } from '../src/tracker-frame';
import type { BaseObj } from '../src/types';
import type { TrackerStateCategory, TrackerTicket } from '../src/tracker-types';

// snapshots are keyed by the frame object's id (the test's `objectId` argument is that id)
function frame(objectId: string, w = 360, h = 280): BaseObj {
  return { id: objectId, type: 'tracker', x: 0, y: 0, w, h, rotation: 0, z: 'a0', trackerId: 'workspace-tracker' };
}

function ticket(key: string, category: TrackerStateCategory): TrackerTicket {
  return { key, title: `Ticket ${key}`, state: { name: category, category } } as TrackerTicket;
}

describe('tracker frame snapshots', () => {
  it('draws the card with its serif title and the counts of the loaded tickets, and no ticket text', () => {
    publishTrackerSnapshot('frame-counts', [
      ticket('TAB-1', 'started'), ticket('TAB-2', 'started'), ticket('TAB-3', 'unstarted'),
      ticket('TAB-4', 'completed'), ticket('TAB-5', 'canceled'), ticket('TAB-6', 'backlog'),
    ]);

    const svg = renderTrackerSnapshot(frame('frame-counts'));

    expect(svg).toContain('rx="12"');
    expect(svg).toContain('>Tracker</text>');
    expect(svg).toContain('font-size="28"');
    expect(svg).toContain('var(--font-serif');
    expect(svg).toContain('>4 open · 2 in progress</text>');
    expect(svg).not.toContain('TAB-');
    expect(svg).not.toContain('Ticket TAB');
    expect(svg).not.toContain('<foreignObject');
  });

  it('draws four skeleton lines of 10px at 10% ink tint, with varying widths', () => {
    publishTrackerSnapshot('frame-skeleton', [ticket('TAB-1', 'started')]);

    const bars = [...renderTrackerSnapshot(frame('frame-skeleton')).matchAll(/<rect x="20" y="\d+" width="(\d+)" height="10" rx="3" fill="var\(--ink[^"]*" fill-opacity="0\.1"\/>/g)];

    expect(bars).toHaveLength(4);
    const widths = bars.map((match) => Number(match[1]));
    expect(new Set(widths).size).toBeGreaterThan(1);
  });

  it('drops the skeleton lines that do not fit a short card', () => {
    publishTrackerSnapshot('frame-short', []);

    expect(renderTrackerSnapshot(frame('frame-short', 360, 130)).match(/height="10"/g)).toHaveLength(1);
  });

  it('shows zero counts for an empty list', () => {
    publishTrackerSnapshot('frame-empty', []);

    expect(renderTrackerSnapshot(frame('frame-empty'))).toContain('>0 open · 0 in progress</text>');
  });

  it('keys snapshots by object, so two elements on one tracker keep their own counts', () => {
    publishTrackerSnapshot('frame-mine', [ticket('TAB-7', 'started')]);
    publishTrackerSnapshot('frame-all', [ticket('TAB-8', 'unstarted'), ticket('TAB-9', 'unstarted')]);

    expect(renderTrackerSnapshot(frame('frame-mine'))).toContain('>1 open · 1 in progress</text>');
    expect(renderTrackerSnapshot(frame('frame-all'))).toContain('>2 open · 0 in progress</text>');
  });

  it('asks for a sign-in when no snapshot exists', () => {
    expect(renderTrackerSnapshot(frame('frame-never-published'))).toContain('>Sign in to a workspace to see tickets.</text>');
  });

  it('does not ask a signed-in member to sign in when a frame has no snapshot yet', () => {
    setTrackerMember(true);
    try {
      const svg = renderTrackerSnapshot(frame('frame-over-cap'));
      expect(svg).toContain('>Zoom in or select this tracker to load its tickets.</text>');
      expect(svg).not.toContain('Sign in to a workspace');
    } finally {
      setTrackerMember(false);
    }
  });

  it('tells a guest that tickets are for workspace members, not to sign in', () => {
    setTrackerGuest(true);
    try {
      const svg = renderTrackerSnapshot(frame('frame-guest'));
      expect(svg).toContain('>Tickets are for workspace members.</text>');
      expect(svg).not.toContain('Sign in to a workspace');
    } finally {
      setTrackerGuest(false);
    }
  });

  it('clears every snapshot on sign-out or access loss', () => {
    publishTrackerSnapshot('frame-cleared', [ticket('TAB-9', 'started')]);
    clearTrackerSnapshots();
    expect(renderTrackerSnapshot(frame('frame-cleared'))).not.toContain('1 open');
    expect(renderTrackerSnapshot(frame('frame-cleared'))).toContain('Sign in to a workspace to see tickets.');
  });
});
