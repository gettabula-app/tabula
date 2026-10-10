import { actorInfo, forbidden, notFound } from './shared.mjs';

/** Return read/write for an authorized actor; conceal missing and inaccessible tickets alike. */
export function ticketAccess(actor, ticket) {
  if (!ticket) throw notFound();
  let info;
  try {
    info = actorInfo(actor);
  } catch {
    throw notFound();
  }
  if (!actor || info.disabled || !info.id && info.type !== 'system') throw notFound();

  if (info.type === 'mcp_token') {
    if (!['read', 'write'].includes(info.trackerScope)) throw notFound();
    if (!info.userId || !['owner', 'admin', 'member', 'viewer'].includes(info.role)) {
      throw notFound();
    }
    if (info.role === 'viewer' || info.trackerScope === 'read') return 'read';
    return 'write';
  }

  if (info.type === 'system') {
    if (actor?.ticketAccess === 'write') return 'write';
    if (actor?.ticketAccess === 'read') return 'read';
    throw notFound();
  }

  if (['owner', 'admin', 'member'].includes(info.role)) return 'write';
  if (info.role === 'viewer') return 'read';
  throw notFound();
}

export function requireTicketRead(actor, ticket) {
  ticketAccess(actor, ticket);
}

export function requireTicketWrite(actor, ticket) {
  if (ticketAccess(actor, ticket) !== 'write') throw forbidden('This ticket is read-only for this actor.');
}
