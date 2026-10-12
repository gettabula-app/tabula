import { describe, expect, it } from 'vitest';
import { OpsError } from '../server/board-ops.mjs';
import { requireTicketWrite, ticketAccess } from '../server/tracker/access.mjs';

const ticket = { id: 'ticket-1', key: 'TAB-1' };

function errorFrom(run: () => unknown) {
  try { run(); } catch (error) { return error as OpsError; }
  throw new Error('expected an OpsError');
}

describe('ticketAccess', () => {
  it.each([
    ['owner', { id: 'u-owner', role: 'owner' }, 'write'],
    ['admin', { id: 'u-admin', role: 'admin' }, 'write'],
    ['member', { id: 'u-member', role: 'member' }, 'write'],
    ['workspace viewer', { id: 'u-viewer', workspaceRole: 'viewer' }, 'read'],
  ])('grants workspace %s the expected tracker permission', (_name, actor, expected) => {
    expect(ticketAccess(actor, ticket)).toBe(expected);
  });

  it.each([
    ['guest', { id: 'u-guest', role: 'guest' }],
    ['disabled member', { id: 'u-disabled', role: 'member', disabled: true }],
    ['missing actor', null],
    ['board-only actor', { id: 'u-board', role: null }],
    ['board-only viewer', { id: 'u-board-viewer', role: 'viewer' }],
  ])('returns not_found for a %s', (_name, actor) => {
    const error = errorFrom(() => ticketAccess(actor, ticket));
    expect(error).toBeInstanceOf(OpsError);
    expect(error.code).toBe('not_found');
  });

  it.each([
    ['member tracker read scope', 'member', 'read', 'read'],
    ['member tracker write scope', 'member', 'write', 'write'],
    ['owner tracker read scope', 'owner', 'read', 'read'],
    ['viewer with tracker write scope', 'viewer', 'write', 'read'],
  ])('respects %s for MCP tokens', (_name, role, tracker, expected) => {
    const actor = {
      type: 'mcp_token', id: 'token-1', user: { id: 'u1', role, workspaceRole: role === 'viewer' ? 'viewer' : undefined, disabled: false }, tracker,
    };
    expect(ticketAccess(actor, ticket)).toBe(expected);
  });

  it.each([
    ['missing tracker scope', { type: 'mcp_token', id: 'token-1', user: { id: 'u1', role: 'member' } }],
    ['invalid tracker scope', { type: 'mcp_token', id: 'token-1', user: { id: 'u1', role: 'member' }, tracker: 'admin' }],
    ['guest owner', { type: 'mcp_token', id: 'token-1', user: { id: 'u1', role: 'guest' }, tracker: 'write' }],
    ['disabled owner', { type: 'mcp_token', id: 'token-1', user: { id: 'u1', role: 'member', disabled: true }, tracker: 'write' }],
  ])('returns not_found for MCP %s', (_name, actor) => {
    expect(errorFrom(() => ticketAccess(actor, ticket)).code).toBe('not_found');
  });

  it('keeps missing tickets indistinguishable from inaccessible tickets and forbids writes for viewers', () => {
    expect(errorFrom(() => ticketAccess({ id: 'u1', role: 'member' }, null)).code).toBe('not_found');
    const error = errorFrom(() => requireTicketWrite({ id: 'u-viewer', workspaceRole: 'viewer' }, ticket));
    expect(error.code).toBe('forbidden');
  });
});
