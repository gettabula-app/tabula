import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/tracker/shared.mjs';
import { createTrackerRoutes } from '../server/tracker/api-routes.mjs';

const opened: ReturnType<typeof openDirectory>[] = [];

function fixture() {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner Person', role: 'owner' })!;
  const member = directory.createUser({ email: 'member@example.com', name: 'Member Person', role: 'member' })!;
  const audit = (user: { id: string }, action: string, detail: any) => directory.audit(user.id, action, detail);
  const routes = createTrackerRoutes({
    directory,
    audit,
    now: () => 100,
    compile: (method: string, pattern: string, options: Record<string, unknown>, handler: (...args: any[]) => unknown) => ({
      method, parts: pattern.split('/'), handler, ...options,
    }),
  });
  const call = (method: string, pathname: string, user = owner, body: Record<string, unknown> = {}, query = new URLSearchParams()) => {
    const segments = pathname.split('/');
    const route = routes.find((candidate: any) => candidate.method === method
      && candidate.parts.length === segments.length
      && candidate.parts.every((part: string, index: number) => part.startsWith(':') || part === segments[index])) as any;
    if (!route) throw new Error(`route not found: ${method} ${pathname}`);
    const params: Record<string, string> = {};
    route.parts.forEach((part: string, index: number) => {
      if (part.startsWith(':')) params[part.slice(1)] = segments[index];
    });
    return route.handler({ user, params, body, query });
  };
  return { directory, owner, member, call };
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker REST route handlers', () => {
  it('returns ticket commands through the session route shapes and resolves aliases', () => {
    const { directory, owner, member, call } = fixture();
    const [metaStatus, meta] = call('GET', 'tracker/meta') as [number, any];
    expect(metaStatus).toBe(200);
    expect(meta.me).toEqual({ userId: owner.id, canWrite: true });
    expect(meta.members.every((row: any) => !Object.hasOwn(row, 'email'))).toBe(true);

    const [createdStatus, createdPayload] = call('POST', 'tracker/tickets', owner, {
      title: 'Route handler ticket', assigneeId: member.id, idempotencyKey: 'route-handler-create-1',
    }) as [number, any];
    expect(createdStatus).toBe(201);
    const ticket = createdPayload.ticket;
    expect(ticket.assignee).toEqual({ userId: member.id, name: member.name });

    const [listStatus, listed] = call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('filter=state%3Atodo')) as [number, any];
    expect(listStatus).toBe(200);
    expect(listed.tickets.map((row: any) => row.id)).toContain(ticket.id);
    const [searchStatus, searched] = call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('q=handler')) as [number, any];
    expect(searchStatus).toBe(200);
    expect(searched.tickets[0].snippet).toContain('<mark>handler</mark>');

    const alias = 'legacy-import-11';
    directory.db.prepare(
      `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at)
       VALUES ('route-handler-alias', ?, 'legacy', ?, 'LEGACY-11', 101)`,
    ).run(ticket.id, alias);
    const [detailStatus, detail] = call('GET', `tracker/tickets/${alias}`) as [number, any];
    expect(detailStatus).toBe(200);
    expect(detail).toMatchObject({ ticket: { key: ticket.key }, resolvedKey: ticket.key, comments: [], events: [{ eventType: 'created' }], subscribed: true });

    const [commentStatus, commentPayload] = call('POST', `tracker/tickets/${ticket.key}/comments`, owner, { body: 'Route comment', clientId: 'route-comment-1' }) as [number, any];
    expect(commentStatus).toBe(201);
    expect(commentPayload.comment).toMatchObject({ author: owner.name, body: 'Route comment' });
    const [subscriptionStatus, subscription] = call('PUT', `tracker/tickets/${ticket.key}/subscription`) as [number, any];
    expect(subscriptionStatus).toBe(200);
    expect(subscription).toEqual({ subscribed: true });
    expect(call('GET', `tracker/tickets/${ticket.key}`)).toMatchObject([200, { subscribed: true }]);
    expect(call('DELETE', `tracker/tickets/${ticket.key}/subscription`)).toMatchObject([200, { subscribed: false }]);
    expect(call('POST', `tracker/tickets/${ticket.key}/transition`, owner, { state: 'Done' })).toMatchObject([200, { ticket: { state: { key: 'done' } } }]);

    const [feedStatus, feed] = call('GET', 'tracker/feed', owner, {}, new URLSearchParams('since=1')) as [number, any];
    expect(feedStatus).toBe(200);
    expect(feed.events.map((event: any) => event.eventType)).toContain('commented');
    expect(feed.events).toHaveLength(2);
    expect(feed.events[0].id).toBeLessThan(feed.events[1].id);

    const auditRows = directory.listAudit(100).filter((row: any) => row.action.startsWith('tracker.ticket.'));
    expect(auditRows.map((row: any) => row.action)).toEqual(expect.arrayContaining([
      'tracker.ticket.create', 'tracker.ticket.comment', 'tracker.ticket.unsubscribe', 'tracker.ticket.transition',
    ]));
    expect(auditRows.every((row: any) => Object.keys(row.detail).every((key) => ['ticketId', 'commentId'].includes(key)))).toBe(true);
    expect(JSON.stringify(auditRows)).not.toContain('Route handler ticket');
    expect(JSON.stringify(auditRows)).not.toContain('Route comment');
  });

  it('returns the current ticket on stale update conflicts and maps command errors to typed OpsErrors', () => {
    const { owner, call } = fixture();
    const [, made] = call('POST', 'tracker/tickets', owner, { title: 'Conflict ticket', idempotencyKey: 'route-conflict-create' }) as [number, any];
    const ticket = made.ticket;
    call('PATCH', `tracker/tickets/${ticket.key}`, owner, { title: 'Current title', ifUpdatedSeq: ticket.updatedSeq });
    let stale: any;
    try {
      call('PATCH', `tracker/tickets/${ticket.key}`, owner, { title: 'Stale title', ifUpdatedSeq: ticket.updatedSeq });
    } catch (error) { stale = error; }
    expect(stale).toBeInstanceOf(OpsError);
    expect(stale).toMatchObject({ code: 'conflict', ticket: { id: ticket.id, title: 'Current title' } });

    let invalidFilter: any;
    try { call('GET', 'tracker/tickets', owner, {}, new URLSearchParams('filter=bogus%3Ax')); } catch (error) { invalidFilter = error; }
    expect(invalidFilter).toMatchObject({ code: 'invalid_filter', path: 'bogus:x' });
  });
});
