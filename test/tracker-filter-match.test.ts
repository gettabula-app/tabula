import { describe, expect, it } from 'vitest';
import { createHttpTrackerApi, createTrackerStore, matchesFilters, type TrackerTicket } from '../src/tracker-data';

// A list row as the server sends it: state has no id, labels are absent.
function slim(overrides: Record<string, unknown> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-1', trackerId: 't', title: 'Fix', description: '',
    state: { key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'high',
    assignee: { userId: 'user-me', name: 'You' }, project: null, milestone: null, estimate: null,
    due: '2026-10-09', parent: null, aliases: [], archivedAt: null, createdAt: 1, updatedAt: 2, updatedSeq: 3,
    ...overrides,
  } as unknown as TrackerTicket;
}
const ctx = { me: 'user-me', today: '2026-10-10' };

describe('client filter matcher on server-shaped rows', () => {
  it('does not throw on a state without an id and matches by key or name', () => {
    expect(matchesFilters(slim(), ['state:todo'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['state:TO DO'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['state:done'], ctx)).toBe(false);
  });

  it('reads negation and any-of the way the server does', () => {
    expect(matchesFilters(slim(), ['-state:done'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['-state:todo'], ctx)).toBe(false);
    expect(matchesFilters(slim(), ['state:todo,in_progress'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['state:done,cancelled'], ctx)).toBe(false);
    expect(matchesFilters(slim(), ['priority:high,urgent'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['-priority:high'], ctx)).toBe(false);
    expect(matchesFilters(slim({ assignee: null }), ['assignee:none'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['assignee:none'], ctx)).toBe(false);
    expect(matchesFilters(slim(), ['assignee:me,none'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['due:overdue'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['-due:overdue'], ctx)).toBe(false);
    expect(matchesFilters(slim(), ['due:after-2026-10-09'], ctx)).toBe(true);
  });

  it('keeps a row it cannot judge instead of hiding it or throwing', () => {
    expect(matchesFilters(slim(), ['label:UI'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['priority:banana', 'nosuchfield:abc', 'creator:agent', 'has:link'], ctx)).toBe(true);
    expect(matchesFilters(slim({ state: undefined }), ['state:done', '-category:started'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['assignee:maya@example.com'], ctx)).toBe(true);
  });

  it('keeps the archive rule', () => {
    expect(matchesFilters(slim({ archivedAt: 5 }), [], ctx)).toBe(false);
    expect(matchesFilters(slim({ archivedAt: 5 }), ['is:archived'], ctx)).toBe(true);
    expect(matchesFilters(slim(), ['is:archived'], ctx)).toBe(false);
  });
});

describe('list store with filters', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('keeps server rows for a negated filter after a poll updates them', async () => {
    const rows = [slim(), slim({ id: 'ticket-2', key: 'TAB-2' })];
    const api = createHttpTrackerApi((async () => json(200, { tickets: rows, nextCursor: null })) as typeof fetch);
    const store = createTrackerStore(api);
    const cache = await store.loadList({ filter: ['-state:done'] });
    expect(cache.tickets.map((row) => row.key)).toEqual(['TAB-1', 'TAB-2']);
  });

  it('exposes invalid_filter on the list cache so the filter bar can show it', async () => {
    const api = createHttpTrackerApi((async () => json(400, { error: 'invalid_filter', message: 'Invalid filter: priority:banana', path: 'priority:banana' })) as typeof fetch);
    const store = createTrackerStore(api);
    await expect(store.loadList({ filter: ['priority:banana'] })).rejects.toMatchObject({ code: 'invalid_filter' });
    expect(store.list({ filter: ['priority:banana'] }).error).toMatchObject({ code: 'invalid_filter', message: 'Invalid filter: priority:banana' });
  });
});
