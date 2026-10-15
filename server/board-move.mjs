/**
 * Permission rules for moving one board between teams. `source` and `dest` are snapshots read
 * from the directory inside the move transaction; this function does no I/O.
 *
 * @param {{ user: { id: string, role: string, disabled?: boolean }, board: { ownerId: string | null, deletedAt?: number | null }, source: { id: string | null, role: string | null, exists?: boolean, hasEnabledAdmin?: boolean }, dest: { id: string | null, role: string | null, exists: boolean } }} input
 * @returns {{ ok: true, override: 'admin' | 'creator' } | { ok: false, reason: string }}
 */
export function canMoveBoard({ user, board, source, dest }) {
  if (!user || user.disabled || user.role === 'guest') return { ok: false, reason: 'user_unavailable' };
  if (!board || board.deletedAt != null) return { ok: false, reason: 'board_deleted' };
  if (source.id === dest.id) return { ok: false, reason: 'same_team' };

  const workspaceAdmin = user.role === 'owner' || user.role === 'admin';
  if (workspaceAdmin) {
    return dest.id === null || dest.exists
      ? { ok: true, override: 'admin' }
      : { ok: false, reason: 'destination_missing' };
  }

  if (board.ownerId !== user.id) return { ok: false, reason: 'not_creator' };
  if (source.id === null) {
    return dest.id !== null && dest.exists && dest.role !== null
      ? { ok: true, override: 'creator' }
      : { ok: false, reason: 'destination_unavailable' };
  }

  if (source.role === null) return { ok: false, reason: 'source_membership_required' };
  if (dest.id === null) {
    return source.hasEnabledAdmin === false
      ? { ok: true, override: 'creator' }
      : { ok: false, reason: 'source_has_admin' };
  }
  return dest.exists && dest.role !== null
    ? { ok: true, override: 'creator' }
    : { ok: false, reason: 'destination_unavailable' };
}
