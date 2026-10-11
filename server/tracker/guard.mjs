import * as Y from 'yjs';
import { requireTicketWrite, ticketAccess } from './access.mjs';
import { createTicket, updateTicket, transitionTicket } from './tickets.mjs';
import { enqueueTicketProjection, enqueueTicketProjectionRemoval, reconcileTrackerProjection, SERVER_CARD_FIELDS } from './projection.mjs';
import { appendTicketEvent } from './events.mjs';
import { actorInfo, cleanTicketTitle, conflict, getDb, newId } from './shared.mjs';

const TRACKER_ACCESS_CHECK = Object.freeze({ id: 'tracker-access-check' });
const UPDATE_WINDOW_MS = 60_000;
const MAX_UPDATES_PER_WINDOW = 240;
const MAX_LINKED_CARDS_PER_UPDATE = 100;
const MAX_TICKETS_PER_UPDATE = 500;
const TITLE_QUIET_MS = 400;
const TITLE_MAX_WAIT_MS = 2000;
const RESTORE_WINDOW_MS = 15_000;

/** Ids changed in a Yjs transaction, including nested maps under `objects`. */
export function changedObjectIds(transaction, doc) {
  const objects = doc.getMap('objects');
  const ids = new Set();
  for (const [type, keys] of transaction?.changed ?? []) {
    if (type === objects) {
      for (const key of keys) if (key !== null && key !== undefined) ids.add(String(key));
      continue;
    }
    let current = type;
    while (current && current !== objects) {
      if (current.parent === objects) {
        const id = current._item?.parentSub;
        if (typeof id === 'string') ids.add(id);
        break;
      }
      current = current.parent;
    }
  }
  return ids;
}

function plainObject(value, id) {
  if (value instanceof Y.Map) return { ...value.toJSON(), id };
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value, id } : null;
}

function firstLine(value) {
  return (typeof value === 'string' ? value : '').split(/\r\n|\n|\r/u, 1)[0];
}

function withFirstLine(value, title) {
  const text = typeof value === 'string' ? value : '';
  const lineBreak = text.search(/\r\n|\n|\r/u);
  return `${title}${lineBreak < 0 ? '' : text.slice(lineBreak)}`;
}

function linkCache(directory, boardId) {
  const db = getDb({ directory });
  const kanbans = db.prepare(
    `SELECT id, kanban_id FROM kanban_tracker_links
      WHERE board_id = ? AND removed_at IS NULL ORDER BY kanban_id`,
  ).all(boardId);
  if (!kanbans.length) return { boardId, hasLinks: false };
  const maps = db.prepare(
    `SELECT m.kanban_link_id, kl.kanban_id, m.lane_id, m.state_id, s.state_key
       FROM kanban_state_mappings m
       JOIN kanban_tracker_links kl ON kl.id = m.kanban_link_id AND kl.removed_at IS NULL
       JOIN ticket_states s ON s.id = m.state_id
      WHERE kl.board_id = ? ORDER BY kl.kanban_id, m.lane_id`,
  ).all(boardId);
  const rows = db.prepare(
    `SELECT l.id AS link_id, l.ticket_id, l.board_id, l.kanban_id, l.card_id, l.removed_at,
            t.key AS ticket_key, t.title AS ticket_title, t.tracker_id, t.state_id, t.updated_seq, t.archived_at,
            version.event_seq AS state_event_seq, kl.id AS kanban_link_id
       FROM ticket_links l
       JOIN kanban_tracker_links kl ON kl.board_id = l.board_id AND kl.kanban_id = l.kanban_id AND kl.removed_at IS NULL
       JOIN tickets t ON t.id = l.ticket_id
       LEFT JOIN ticket_field_versions version ON version.ticket_id = t.id AND version.field = 'state'
      WHERE l.board_id = ? ORDER BY l.kanban_id, l.card_id, l.created_at, l.id`,
  ).all(boardId);
  const kanbanById = new Map(kanbans.map((row) => [row.kanban_id, row]));
  const mappingsByLane = new Map(maps.map((row) => [`${row.kanban_id}\u0000${row.lane_id}`, row]));
  const rowsByCard = new Map();
  const activeByCard = new Map();
  for (const row of rows) {
    const cardRows = rowsByCard.get(row.card_id) ?? [];
    cardRows.push(row);
    rowsByCard.set(row.card_id, cardRows);
    if (row.removed_at == null) activeByCard.set(row.card_id, row);
  }
  return {
    boardId,
    hasLinks: true,
    kanbans,
    kanbanById,
    maps,
    mappingsByLane,
    mappedLaneIds: new Set(maps.map((row) => row.lane_id)),
    rowsByCard,
    activeByCard,
  };
}

function roomSnapshot(doc, cache) {
  const objects = doc.getMap('objects');
  const snapshots = new Map();
  const laneIdsByKanban = new Map(cache.kanbans.map((row) => [row.kanban_id, new Set()]));
  for (const [id, value] of objects) {
    const object = plainObject(value, String(id));
    if (object?.type === 'lane' && laneIdsByKanban.has(object.parent)) {
      laneIdsByKanban.get(object.parent).add(object.id);
      snapshots.set(object.id, object);
    }
  }
  for (const row of cache.kanbans) {
    const container = plainObject(objects.get(row.kanban_id), row.kanban_id);
    if (container) snapshots.set(row.kanban_id, container);
  }
  for (const cardId of cache.rowsByCard.keys()) {
    const card = plainObject(objects.get(cardId), cardId);
    if (card) snapshots.set(cardId, card);
  }
  // Container deletion can cascade through every lane; mapped-lane deletion also includes plain cards.
  const linkedLaneIds = new Set([...laneIdsByKanban.values()].flatMap((ids) => [...ids]));
  if (linkedLaneIds.size) {
    for (const [id, value] of objects) {
      const card = plainObject(value, String(id));
      if (card?.type === 'card' && linkedLaneIds.has(card.parent)) snapshots.set(card.id, card);
    }
  }
  return { snapshots, laneIdsByKanban };
}

function activeLinkRow(db, boardId, cardId) {
  return db.prepare(
    `SELECT l.*, t.key AS ticket_key, t.title AS ticket_title, t.tracker_id, t.state_id, t.updated_seq, t.archived_at,
            version.event_seq AS state_event_seq, kl.id AS kanban_link_id
       FROM ticket_links l
       JOIN kanban_tracker_links kl ON kl.board_id = l.board_id AND kl.kanban_id = l.kanban_id AND kl.removed_at IS NULL
       JOIN tickets t ON t.id = l.ticket_id
       LEFT JOIN ticket_field_versions version ON version.ticket_id = t.id AND version.field = 'state'
      WHERE l.board_id = ? AND l.card_id = ? AND l.removed_at IS NULL LIMIT 1`,
  ).get(boardId, cardId) ?? null;
}

function mappedState(db, kanbanLinkId, laneId) {
  return db.prepare(
    `SELECT s.state_key, s.id AS state_id
       FROM kanban_state_mappings m JOIN ticket_states s ON s.id = m.state_id
      WHERE m.kanban_link_id = ? AND m.lane_id = ? AND s.archived_at IS NULL`,
  ).get(kanbanLinkId, laneId) ?? null;
}

function laneForState(db, link) {
  return db.prepare(
    `SELECT m.lane_id FROM kanban_state_mappings m
       JOIN ticket_states s ON s.id = m.state_id
      WHERE m.kanban_link_id = ? AND m.state_id = ? AND s.archived_at IS NULL`,
  ).get(link.kanban_link_id, link.state_id)?.lane_id ?? null;
}

function cardContext(doc, card) {
  if (!card || card.type !== 'card') return null;
  const objects = doc.getMap('objects');
  const lane = plainObject(objects.get(card.parent), card.parent);
  if (lane?.type !== 'lane') return null;
  return { lane, kanbanId: lane.parent };
}

function ticketWrite(actor) {
  if (!actor) return false;
  try { return ticketAccess(actor, TRACKER_ACCESS_CHECK) === 'write'; } catch { return false; }
}

function safeReason(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : 'error';
}

function restoredMap(doc, id, snapshot) {
  const objects = doc.getMap('objects');
  if (!snapshot) {
    objects.delete(id);
    return;
  }
  objects.set(id, new Y.Map(Object.entries(snapshot).filter(([key]) => key !== 'id')));
}

function restoreField(doc, id, snapshot, key) {
  const current = doc.getMap('objects').get(id);
  if (!(current instanceof Y.Map)) {
    if (snapshot) restoredMap(doc, id, snapshot);
    return;
  }
  if (Object.hasOwn(snapshot ?? {}, key)) current.set(key, snapshot[key]);
  else current.delete(key);
}

function setNotice(notices, cardId, reason) {
  if (typeof cardId !== 'string' || !cardId) return;
  if (!notices.some((entry) => entry.cardId === cardId)) notices.push({ cardId, reason });
}

/** Synchronous bidirectional guard for linked tracker cards.
 * @param {{ directory?: any, config?: { tracker?: boolean, readOnly?: boolean | (() => boolean) }, now?: () => number,
 *   log?: (...args: any[]) => void, setTimeoutFn?: typeof setTimeout, clearTimeoutFn?: typeof clearTimeout }} options
 */
export function createTrackerGuard({
  directory, config = {}, now = Date.now, log = () => {},
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  const caches = new Map();
  const rateWindows = new Map();
  const rejectAudits = new Map();
  const pendingTitles = new Map();
  const restoreWindows = new Map();
  const readOnly = () => typeof config.readOnly === 'function'
    ? config.readOnly() === true
    : config.readOnly === true;

  function cacheFor(boardId) {
    let entry = caches.get(boardId);
    if (!entry) {
      entry = linkCache(directory, boardId);
      caches.set(boardId, entry);
    }
    return entry;
  }

  function audit(actor, boardId, action, detail = {}) {
    if (!directory || typeof directory.audit !== 'function') return;
    const info = actorInfo(actor);
    directory.audit(info.userId ?? info.id, action, { boardId, ...detail });
  }

  function auditActions(actor, boardId, actions) {
    const grouped = new Map();
    for (const item of actions) {
      const group = grouped.get(item.action) ?? { cardIds: [], reactivated: 0 };
      group.cardIds.push(...item.cardIds);
      if (item.reactivated) group.reactivated++;
      grouped.set(item.action, group);
    }
    for (const [action, group] of grouped) {
      audit(actor, boardId, action, {
        count: group.cardIds.length,
        cardIds: [...new Set(group.cardIds)].slice(0, 100),
        ...(group.reactivated ? { reactivated: group.reactivated } : {}),
      });
    }
  }

  function rejectAudit(actor, boardId, notices) {
    if (!notices.length) return;
    const info = actorInfo(actor);
    const userId = info.userId ?? info.id ?? 'unknown';
    const minute = Math.floor(now() / UPDATE_WINDOW_MS);
    const key = `${userId}\u0000${boardId}`;
    if (rejectAudits.get(key) === minute) return;
    audit(actor, boardId, 'tracker.guard.reject', {
      reasons: [...new Set(notices.map((entry) => entry.reason))].sort(), count: notices.length,
    });
    rejectAudits.set(key, minute);
  }

  function rateLimited(actor, boardId) {
    const info = actorInfo(actor);
    const key = `${info.userId ?? info.id ?? 'unknown'}\u0000${boardId}`;
    const instant = now();
    const live = (rateWindows.get(key) ?? []).filter((stamp) => instant - stamp < UPDATE_WINDOW_MS);
    if (live.length >= MAX_UPDATES_PER_WINDOW) {
      rateWindows.set(key, live);
      return true;
    }
    live.push(instant);
    rateWindows.set(key, live);
    return false;
  }

  function pendingFor(boardId) {
    let pending = pendingTitles.get(boardId);
    if (!pending) pendingTitles.set(boardId, pending = new Map());
    return pending;
  }

  function cancelTitle(boardId, cardId) {
    const group = pendingTitles.get(boardId);
    const pending = group?.get(cardId);
    if (!pending) return;
    if (pending.timer) clearTimeoutFn(pending.timer);
    group.delete(cardId);
    if (!group.size) pendingTitles.delete(boardId);
  }

  function titleText(doc, cardId, title) {
    const card = doc.getMap('objects').get(cardId);
    if (!(card instanceof Y.Map)) return;
    const text = typeof card.get('text') === 'string' ? card.get('text') : '';
    const lineBreak = text.search(/\r\n|\n|\r/u);
    const replaced = `${title}${lineBreak < 0 ? '' : text.slice(lineBreak)}`;
    if (replaced !== text) card.set('text', replaced);
  }

  function scheduleTitle(boardId, cardId, pending) {
    const group = pendingFor(boardId);
    const prior = group.get(cardId);
    if (prior?.timer) clearTimeoutFn(prior.timer);
    const next = { ...pending, firstAt: prior?.firstAt ?? now(), timer: null };
    const quiet = Math.max(0, Math.min(TITLE_QUIET_MS, TITLE_MAX_WAIT_MS - (now() - next.firstAt)));
    next.timer = setTimeoutFn(() => {
      const current = group.get(cardId);
      if (!current || current !== next) return;
      current.timer = null;
      flushTitles(boardId, cardId);
    }, quiet);
    next.timer?.unref?.();
    group.set(cardId, next);
  }

  function flushTitles(boardId, onlyCardId = null) {
    const group = pendingTitles.get(boardId);
    if (!group?.size) return { committed: 0 };
    const work = [...group.entries()].filter(([cardId]) => onlyCardId === null || cardId === onlyCardId);
    if (!work.length) return { committed: 0 };
    for (const [cardId, entry] of work) {
      if (entry.timer) clearTimeoutFn(entry.timer);
      group.delete(cardId);
    }
    if (!group.size) pendingTitles.delete(boardId);
    const instant = now();
    const committed = [];
    try {
      directory.transaction(() => {
        for (const [cardId, entry] of work) {
          const link = activeLinkRow(getDb({ directory }), boardId, cardId);
          if (!link) throw new Error('tracker link disappeared');
          requireTicketWrite(entry.actor, { id: link.ticket_id });
          updateTicket({ directory, actor: entry.actor, key: link.ticket_id, patch: { title: entry.title }, source: entry.source, now: instant });
          committed.push({ cardId, actor: entry.actor });
        }
        const grouped = new Map();
        for (const entry of work) {
          const item = grouped.get(entry.actor) ?? [];
          item.push(entry.cardId);
          grouped.set(entry.actor, item);
        }
        for (const [actor, cardIds] of grouped) {
          audit(actor, boardId, 'tracker.card.title', { count: cardIds.length, cardIds: cardIds.slice(0, 100) });
        }
      });
      caches.delete(boardId);
      return { committed: committed.length };
    } catch (error) {
      try { log('tracker guard title commit failed', boardId, safeReason(error)); } catch { /* logging cannot expose text */ }
      const doc = work[0]?.[1]?.room?.doc;
      if (doc) {
        try {
          doc.transact(() => {
            for (const [cardId, entry] of work) {
              const title = getDb({ directory }).prepare('SELECT title FROM tickets WHERE id = ?').get(entry.ticketId)?.title ?? entry.previousTitle;
              if (typeof title === 'string') titleText(doc, cardId, title);
            }
          }, 'tracker-guard');
        } catch (correctionError) {
          try { log('tracker guard title correction failed', boardId, safeReason(correctionError)); } catch { /* do not log text */ }
        }
      }
      const byActor = new Map();
      for (const [cardId, entry] of work) {
        const list = byActor.get(entry.actor) ?? [];
        list.push({ cardId, reason: 'conflict' });
        byActor.set(entry.actor, list);
      }
      for (const [actor, undone] of byActor) {
        try { directory.transaction(() => rejectAudit(actor, boardId, undone)); }
        catch (auditError) {
          try { log('tracker guard reject audit failed', boardId, safeReason(auditError)); } catch { /* do not log card text */ }
        }
        try { actor.notify?.(undone); } catch { /* the socket may have closed */ }
      }
      return { committed: 0 };
    }
  }

  function clearTitles(boardId) {
    const group = pendingTitles.get(boardId);
    if (!group) return;
    for (const entry of group.values()) if (entry.timer) clearTimeoutFn(entry.timer);
    pendingTitles.delete(boardId);
  }

  function invalidate(boardId) {
    if (typeof boardId === 'string') caches.delete(boardId);
  }

  function finishRestoreWindow(boardId, expected = null) {
    const entry = restoreWindows.get(boardId);
    if (!entry || (expected && expected !== entry)) return { closed: false, projectionPending: false };
    if (entry.timer) clearTimeoutFn(entry.timer);
    restoreWindows.delete(boardId);
    let projectionPending = false;
    try {
      reconcileTrackerProjection({
        directory, roomAccess: entry.roomAccess, boardId, baseUrl: entry.baseUrl, now: now(), mode: 'sql-wins',
      });
    } catch (error) {
      projectionPending = true;
      try { log('tracker restore reconcile failed', boardId, safeReason(error)); } catch { /* do not log board text */ }
    }
    caches.delete(boardId);
    return { closed: true, projectionPending };
  }

  /** @param {string} boardId @param {string} userId @param {{ roomAccess: any, baseUrl?: string }} [options] */
  function openRestoreWindow(boardId, userId, { roomAccess, baseUrl = 'http://localhost' } = {}) {
    if (typeof boardId !== 'string' || !boardId || typeof userId !== 'string' || !userId) throw new TypeError('restore windows require a board and user id');
    const previous = restoreWindows.get(boardId);
    if (previous && previous.expiresAt <= now()) finishRestoreWindow(boardId, previous);
    const current = restoreWindows.get(boardId);
    if (current && current.userId !== userId) throw conflict('A restore window is already open for another user.');
    if (current?.timer) clearTimeoutFn(current.timer);
    const entry = { userId, expiresAt: now() + RESTORE_WINDOW_MS, roomAccess, baseUrl, timer: null };
    entry.timer = setTimeoutFn(() => finishRestoreWindow(boardId, entry), RESTORE_WINDOW_MS);
    entry.timer?.unref?.();
    restoreWindows.set(boardId, entry);
    return { expiresAt: entry.expiresAt };
  }

  /** @param {string} boardId @param {string} userId */
  function closeRestoreWindow(boardId, userId) {
    const entry = restoreWindows.get(boardId);
    if (!entry) return { closed: false, projectionPending: false };
    if (entry.userId !== userId) throw conflict('The restore window belongs to another user.');
    return finishRestoreWindow(boardId, entry);
  }

  function restoreModeFor(boardId, actor) {
    const entry = restoreWindows.get(boardId);
    if (!entry) return false;
    if (entry.expiresAt <= now()) {
      finishRestoreWindow(boardId, entry);
      return false;
    }
    try { return actorInfo(actor).userId === entry.userId; } catch { return false; }
  }

  /** @param {string | null} [boardId] */
  function clearRestoreWindows(boardId = null) {
    const entries = boardId ? [[boardId, restoreWindows.get(boardId)]] : [...restoreWindows.entries()];
    for (const [id, entry] of entries) {
      if (!entry) continue;
      if (entry.timer) clearTimeoutFn(entry.timer);
      restoreWindows.delete(id);
    }
  }

  function restoreTrackedChanges(doc, cache, before, ids, notices, reason, { full = false, canonical = new Map() } = {}) {
    const corrections = [];
    for (const cardId of ids) {
      const prior = before.snapshots.get(cardId);
      if (!prior) {
        corrections.push(() => restoredMap(doc, cardId, null));
        setNotice(notices, cardId, reason);
        continue;
      }
      if (full) {
        corrections.push(() => restoredMap(doc, cardId, prior));
      } else {
        const current = plainObject(doc.getMap('objects').get(cardId), cardId);
        if (!current) corrections.push(() => restoredMap(doc, cardId, prior));
        else {
          const laneId = canonical.get(cardId) ?? prior.parent;
          corrections.push(() => {
            const card = doc.getMap('objects').get(cardId);
            if (!(card instanceof Y.Map)) return restoredMap(doc, cardId, prior);
            card.set('parent', laneId);
            if (Object.hasOwn(prior, 'rank')) card.set('rank', prior.rank); else card.delete('rank');
            card.delete('moveBase');
          });
          if (current.text !== prior.text) corrections.push(() => restoreField(doc, cardId, prior, 'text'));
        }
      }
      setNotice(notices, cardId, reason);
    }
    return corrections;
  }

  function linkedContainerCards(doc, before, containerId) {
    const laneIds = before.laneIdsByKanban.get(containerId) ?? new Set();
    return [...before.snapshots.entries()]
      .filter(([, value]) => value?.type === 'card' && laneIds.has(value.parent))
      .map(([id]) => id);
  }

  function createTicketLink(db, { actor, source, boardId, kanbanId, card, stateKey, now: instant }) {
    const title = cleanTicketTitle(firstLine(card.text));
    const ticket = createTicket({ directory, actor, title, state: stateKey, source, now: instant });
    const info = actorInfo(actor);
    const old = db.prepare(
      `SELECT id FROM ticket_links WHERE board_id = ? AND kanban_id = ? AND card_id = ? AND removed_at IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(boardId, kanbanId, card.id);
    if (old) {
      db.prepare(
        `UPDATE ticket_links SET ticket_id = ?, created_at = ?, created_by_type = ?, created_by_id = ?, removed_at = NULL,
             last_projection_seq = 0 WHERE id = ?`,
      ).run(ticket.id, instant, info.type, info.id, old.id);
    } else {
      db.prepare(
        `INSERT INTO ticket_links
          (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), ticket.id, boardId, kanbanId, card.id, instant, info.type, info.id);
    }
    enqueueTicketProjection({ db, ticketId: ticket.id, eventSeq: ticket.updatedSeq, now: instant });
    return ticket;
  }

  function attemptReactivation(db, { boardId, kanbanId, card, instant }) {
    if (card.extProvider !== 'tabula' || typeof card.trackerId !== 'string' || typeof card.extKey !== 'string') return null;
    const rows = pendingRowsForCard(db, boardId, kanbanId, card.id);
    for (const row of rows) {
      if (row.removed_at == null || row.tracker_id !== card.trackerId || row.ticket_key !== card.extKey || row.archived_at != null) continue;
      const activeKanban = db.prepare(
        'SELECT id FROM kanban_tracker_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL',
      ).get(boardId, kanbanId);
      if (!activeKanban) return null;
      db.prepare('UPDATE ticket_links SET removed_at = NULL WHERE id = ? AND removed_at IS NOT NULL').run(row.link_id);
      enqueueTicketProjection({ db, ticketId: row.ticket_id, eventSeq: row.updated_seq, now: instant });
      return row;
    }
    return null;
  }

  function pendingRowsForCard(db, boardId, kanbanId, cardId) {
    return db.prepare(
      `SELECT l.id AS link_id, l.ticket_id, l.removed_at, t.tracker_id, t.key AS ticket_key,
              t.updated_seq, t.archived_at
         FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id
        WHERE l.board_id = ? AND l.kanban_id = ? AND l.card_id = ? ORDER BY l.created_at DESC, l.id DESC`,
    ).all(boardId, kanbanId, cardId);
  }

  function guardRun(room, actor, apply, { source = 'board' } = {}) {
    const boardId = room?.name;
    const doc = room?.doc;
    if (!directory || !doc || typeof boardId !== 'string' || config.tracker === false) {
      apply();
      return { undone: [] };
    }
    const cache = cacheFor(boardId);
    // This is the common path for unlinked boards: one cached SQL existence check and no board scan.
    if (!cache.hasLinks) {
      apply();
      return { undone: [] };
    }
    const restoreMode = restoreModeFor(boardId, actor);

    const before = roomSnapshot(doc, cache);
    const changed = new Set();
    const capture = (_update, _origin, _document, transaction) => {
      for (const id of changedObjectIds(transaction, doc)) changed.add(id);
    };
    doc.on('update', capture);
    const previousHeld = room.held;
    const held = [];
    room.held = held;
    let applyError = null;
    try {
      const result = apply();
      if (result && typeof result.then === 'function') throw new TypeError('tracker guard apply must be synchronous');
    } catch (error) {
      applyError = error;
    } finally {
      doc.off('update', capture);
    }

    if (applyError && !changed.size) {
      room.held = previousHeld;
      if (previousHeld) previousHeld.push(...held);
      else if (held.length && typeof room.broadcastUpdate === 'function') room.broadcastUpdate(held.length === 1 ? held[0] : Y.mergeUpdates(held));
      throw applyError;
    }

    const notices = [];
    const corrections = [];
    const actions = [];
    const titleCommits = [];
    const titleCancellations = new Set();
    const affected = new Set();
    const linkedAffected = new Set();
    const activeCardIds = new Set();
    const currentObjects = doc.getMap('objects');
    const currentById = new Map([...changed].map((id) => [id, plainObject(currentObjects.get(id), id)]));
    for (const id of changed) {
      const prior = before.snapshots.get(id);
      const current = currentById.get(id);
      if (cache.activeByCard.has(id)) {
        activeCardIds.add(id);
        if (!prior || !current) {
          affected.add(id);
          linkedAffected.add(id);
        } else if (prior.parent !== current.parent || prior.rank !== current.rank || prior.text !== current.text
          || current.moveBase !== undefined || SERVER_CARD_FIELDS.some((field) => JSON.stringify(prior[field]) !== JSON.stringify(current[field]))) {
          affected.add(id);
          linkedAffected.add(id);
        }
      }
    }

    const deletedContainers = cache.kanbans.filter(({ kanban_id: id }) => changed.has(id) && before.snapshots.has(id)
      && (!currentById.get(id) || currentById.get(id)?.type !== 'container'));
    const deletedLanes = cache.maps.filter((mapping) => {
      if (deletedContainers.some((row) => row.kanban_id === mapping.kanban_id)) return false;
      if (!changed.has(mapping.lane_id)) return false;
      const prior = before.snapshots.get(mapping.lane_id);
      const current = currentById.get(mapping.lane_id);
      return prior?.type === 'lane' && (!current || current.type !== 'lane' || current.parent !== mapping.kanban_id);
    });
    const candidateCards = new Map();
    for (const id of changed) {
      const current = currentById.get(id);
      const prior = before.snapshots.get(id);
      if (current?.type !== 'card') continue;
      const context = cardContext(doc, current);
      if (!context || !cache.kanbanById.has(context.kanbanId)) continue;
      const mapping = cache.mappingsByLane.get(`${context.kanbanId}\u0000${context.lane.id}`);
      const hasCopiedFields = SERVER_CARD_FIELDS.some((field) => Object.hasOwn(current, field));
      if (!cache.activeByCard.has(id) && hasCopiedFields) {
        const foreign = typeof current.extProvider === 'string' && current.extProvider !== 'tabula';
        for (const field of SERVER_CARD_FIELDS) {
          if (foreign && ['extProvider', 'extKey', 'extUrl', 'ext'].includes(field)) continue;
          corrections.push(() => doc.getMap('objects').get(id)?.delete?.(field));
        }
      }
      if (!mapping) {
        continue;
      }
      if (cache.activeByCard.has(id)) continue;
      if (!prior || prior.parent !== current.parent || prior.text !== current.text) candidateCards.set(id, { card: current, prior, context, mapping });
    }
    for (const { card } of candidateCards.values()) {
      if (!firstLine(card.text).trim()) continue;
      try {
        if (cleanTicketTitle(firstLine(card.text))) affected.add(card.id);
      } catch { affected.add(card.id); }
    }
    for (const deleted of deletedContainers) {
      for (const [cardId, row] of cache.activeByCard) {
        if (row.kanban_id === deleted.kanban_id) {
          affected.add(cardId);
          linkedAffected.add(cardId);
        }
      }
    }
    for (const mapping of deletedLanes) {
      for (const cardId of cache.activeByCard.keys()) {
        const prior = before.snapshots.get(cardId);
        if (prior?.parent === mapping.lane_id) {
          affected.add(cardId);
          linkedAffected.add(cardId);
        }
      }
    }

    const trackedLinked = [...activeCardIds];
    const relevant = affected.size > 0 || trackedLinked.length > MAX_LINKED_CARDS_PER_UPDATE
      || deletedContainers.length > 0 || deletedLanes.length > 0 || Boolean(applyError);
    if (!relevant && !applyError) {
      if (corrections.length) {
        try {
          doc.transact(() => corrections.forEach((correct) => correct()), 'tracker-guard');
        } catch (error) {
          try { log('tracker guard correction failed', boardId, safeReason(error)); } catch { /* do not log board text */ }
        }
      }
      thisRelease(room, previousHeld, held);
      return { undone: [] };
    }

    const rejection = (reason, cardIds, options = {}) => {
      corrections.push(...restoreTrackedChanges(doc, cache, before, cardIds, notices, reason, options));
    };
    const allTrackedIds = [...new Set(affected)];
    const specialObjectIds = new Set();
    for (const container of deletedContainers) {
      specialObjectIds.add(container.kanban_id);
      for (const laneId of before.laneIdsByKanban.get(container.kanban_id) ?? []) {
        specialObjectIds.add(laneId);
        for (const [objectId, object] of before.snapshots) {
          if (object.type === 'card' && object.parent === laneId) specialObjectIds.add(objectId);
        }
      }
    }
    for (const mapping of deletedLanes) {
      specialObjectIds.add(mapping.lane_id);
      for (const [objectId, object] of before.snapshots) {
        if (object.type === 'card' && object.parent === mapping.lane_id) specialObjectIds.add(objectId);
      }
    }
    let wholeReason = null;
    let rejectionAudited = false;
    if (applyError) {
      wholeReason = 'conflict';
      rejection('conflict', [...new Set([...trackedLinked, ...allTrackedIds])], { full: true });
    } else if (Math.max(trackedLinked.length, linkedAffected.size) > MAX_LINKED_CARDS_PER_UPDATE) {
      wholeReason = 'bulk_change';
      rejection('bulk_change', [...new Set([...trackedLinked, ...linkedAffected])], { full: true });
      for (const cardId of candidateCards.keys()) {
        if (!linkedAffected.has(cardId)) {
          corrections.push(() => restoredMap(doc, cardId, before.snapshots.get(cardId) ?? null));
          setNotice(notices, cardId, 'bulk_change');
        }
      }
    } else if (readOnly()) {
      wholeReason = 'read_only';
      rejection('read_only', allTrackedIds, { full: true });
    } else if (rateLimited(actor, boardId)) {
      wholeReason = 'rate_limited';
      rejection('rate_limited', allTrackedIds, { full: true });
    } else if (!ticketWrite(actor)) {
      wholeReason = 'forbidden';
      rejection('forbidden', allTrackedIds, { full: true });
    } else {
      const instant = now();
      const laneDenied = new Set();
      for (const mapping of deletedLanes) {
        const cardIds = [];
        for (const [cardId, row] of cache.activeByCard) {
          const prior = before.snapshots.get(cardId);
          if (row.kanban_id === mapping.kanban_id && prior?.parent === mapping.lane_id) cardIds.push(cardId);
        }
        laneDenied.add(mapping.lane_id);
        for (const id of [mapping.lane_id, ...linkedContainerCards(doc, before, mapping.kanban_id).filter((cardId) => before.snapshots.get(cardId)?.parent === mapping.lane_id)]) {
          const prior = before.snapshots.get(id);
          if (prior) corrections.push(() => restoredMap(doc, id, prior));
        }
        for (const cardId of cardIds) setNotice(notices, cardId, 'lane_mapped');
      }

      try {
        directory.transaction(() => {
          const db = getDb({ directory });
          for (const container of deletedContainers) {
            const fresh = db.prepare('SELECT id FROM kanban_tracker_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL')
              .get(boardId, container.kanban_id);
            if (!fresh) continue;
            const rows = db.prepare(
              `SELECT l.id, l.ticket_id, l.board_id, l.kanban_id, l.card_id, l.last_projection_seq
                 FROM ticket_links l WHERE l.board_id = ? AND l.kanban_id = ? AND l.removed_at IS NULL ORDER BY l.card_id`,
            ).all(boardId, container.kanban_id);
            db.prepare('UPDATE ticket_links SET removed_at = ? WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL')
              .run(instant, boardId, container.kanban_id);
            db.prepare('UPDATE kanban_tracker_links SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(instant, fresh.id);
            db.prepare('DELETE FROM kanban_state_mappings WHERE kanban_link_id = ?').run(fresh.id);
            for (const cardId of linkedContainerCards(doc, before, container.kanban_id)) titleCancellations.add(cardId);
            for (const row of rows) enqueueTicketProjectionRemoval({ db, ticketLink: row, now: instant });
            actions.push({ action: 'tracker.card.unlink', cardIds: rows.map((row) => row.card_id) });
            for (const cardId of linkedContainerCards(doc, before, container.kanban_id)) {
              const card = doc.getMap('objects').get(cardId);
              if (!(card instanceof Y.Map)) continue;
              const value = plainObject(card, cardId);
              const foreign = typeof value.extProvider === 'string' && value.extProvider !== 'tabula';
              for (const field of SERVER_CARD_FIELDS) {
                if (foreign && ['extProvider', 'extKey', 'extUrl', 'ext'].includes(field)) continue;
                corrections.push(() => doc.getMap('objects').get(cardId)?.delete?.(field));
              }
            }
          }

          for (const cardId of trackedLinked) {
            const prior = before.snapshots.get(cardId);
            const current = currentById.get(cardId);
            if (!prior || deletedContainers.some((row) => row.kanban_id === cache.activeByCard.get(cardId)?.kanban_id)) continue;
            if (laneDenied.has(prior.parent) || deletedLanes.some((mapping) => mapping.lane_id === prior.parent)) continue;
            if (!current) {
              const row = activeLinkRow(db, boardId, cardId);
              if (!row) continue;
              db.prepare('UPDATE ticket_links SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(instant, row.id);
              titleCancellations.add(cardId);
              if (restoreMode) {
                const eventSeq = appendTicketEvent({
                  db, ticketId: row.ticket_id, eventType: 'unlinked', actor, source: 'restore',
                  createdAt: instant, details: { reason: 'restore' },
                });
                db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(instant, eventSeq, row.ticket_id);
              }
              actions.push({ action: 'tracker.card.unlink', cardIds: [cardId] });
              continue;
            }
            const moved = current.parent !== prior.parent;
            const textChanged = current.text !== prior.text;
            if (restoreMode) {
              const oldTitle = firstLine(prior.text);
              const restoredText = withFirstLine(current.text, oldTitle);
              if (moved || current.rank !== prior.rank || restoredText !== current.text || current.moveBase !== undefined) {
                corrections.push(() => {
                  const card = doc.getMap('objects').get(cardId);
                  if (!(card instanceof Y.Map)) return;
                  if (moved) card.set('parent', prior.parent);
                  if (current.rank !== prior.rank) {
                    if (Object.hasOwn(prior, 'rank')) card.set('rank', prior.rank);
                    else card.delete('rank');
                  }
                  if (restoredText !== current.text) card.set('text', restoredText);
                  card.delete('moveBase');
                });
              }
              continue;
            }
            if (moved) {
              const row = activeLinkRow(db, boardId, cardId);
              if (!row) {
                setNotice(notices, cardId, 'conflict');
                const laneId = prior.parent;
                corrections.push(...restoreTrackedChanges(doc, cache, before, [cardId], notices, 'conflict', { canonical: new Map([[cardId, laneId]]) }));
                continue;
              }
              const target = cardContext(doc, current);
              const sameKanban = target?.kanbanId === row.kanban_id;
              const mapping = sameKanban ? mappedState(db, row.kanban_link_id, target.lane.id) : null;
              if (!sameKanban) {
                setNotice(notices, cardId, 'card_stays_linked');
                const laneId = laneForState(db, row) ?? prior.parent;
                corrections.push(...restoreTrackedChanges(doc, cache, before, [cardId], notices, 'card_stays_linked', { canonical: new Map([[cardId, laneId]]) }));
              } else if (!mapping) {
                setNotice(notices, cardId, 'lane_unmapped');
                const laneId = laneForState(db, row) ?? prior.parent;
                corrections.push(...restoreTrackedChanges(doc, cache, before, [cardId], notices, 'lane_unmapped', { canonical: new Map([[cardId, laneId]]) }));
              } else if (current.moveBase !== undefined && current.moveBase !== null
                && (!Number.isFinite(Number(current.moveBase)) || Number(row.state_event_seq ?? 0) > Number(current.moveBase))) {
                const laneId = laneForState(db, row) ?? prior.parent;
                corrections.push(...restoreTrackedChanges(doc, cache, before, [cardId], notices, 'conflict', { canonical: new Map([[cardId, laneId]]) }));
              } else {
                try {
                  transitionTicket({ directory, actor, key: row.ticket_id, state: mapping.state_key, source: 'board', now: instant });
                  actions.push({ action: 'tracker.card.move', cardIds: [cardId] });
                  corrections.push(() => doc.getMap('objects').get(cardId)?.delete?.('moveBase'));
                } catch (error) {
                  if (!['conflict', 'invalid_input', 'forbidden', 'not_found'].includes(error?.code)) throw error;
                  const laneId = laneForState(db, row);
                  corrections.push(...restoreTrackedChanges(doc, cache, before, [cardId], notices, 'conflict', { canonical: new Map([[cardId, laneId]]) }));
                }
              }
            } else if (current.moveBase !== undefined) {
              corrections.push(() => doc.getMap('objects').get(cardId)?.delete?.('moveBase'));
            }
            if (textChanged) {
              let title;
              try { title = cleanTicketTitle(firstLine(current.text)); }
              catch {
                corrections.push(() => restoreField(doc, cardId, prior, 'text'));
                setNotice(notices, cardId, 'title_invalid');
                continue;
              }
              const fresh = activeLinkRow(db, boardId, cardId);
              if (!fresh) {
                corrections.push(() => restoreField(doc, cardId, prior, 'text'));
                setNotice(notices, cardId, 'conflict');
                continue;
              }
              requireTicketWrite(actor, { id: fresh.ticket_id });
              if (title === fresh.ticket_title) {
                titleCancellations.add(cardId);
                continue;
              }
            titleCommits.push({ cardId, title, ticketId: fresh.ticket_id, previousTitle: fresh.ticket_title, actor, source, room });
            }
          }

          let created = 0;
          for (const [cardId, candidate] of candidateCards) {
            const { card, prior, context, mapping } = candidate;
            const hasCopiedFields = SERVER_CARD_FIELDS.some((field) => Object.hasOwn(card, field));
            if (hasCopiedFields) {
              const foreign = typeof card.extProvider === 'string' && card.extProvider !== 'tabula';
              for (const field of SERVER_CARD_FIELDS) {
                if (foreign && ['extProvider', 'extKey', 'extUrl', 'ext'].includes(field)) continue;
                corrections.push(() => doc.getMap('objects').get(cardId)?.delete?.(field));
              }
            }
            if (restoreMode) continue;
            let title;
            try { title = cleanTicketTitle(firstLine(card.text)); }
            catch {
              if (firstLine(card.text).trim()) {
                corrections.push(() => {
                  if (prior) restoreField(doc, cardId, prior, 'text');
                  else restoredMap(doc, cardId, null);
                });
                setNotice(notices, cardId, 'title_invalid');
              }
              continue;
            }
            if (!title) continue;
            const reactivated = attemptReactivation(db, { boardId, kanbanId: context.kanbanId, card, instant });
            if (reactivated) {
              actions.push({ action: 'tracker.card.create', cardIds: [cardId], reactivated: true });
              continue;
            }
            if (created >= MAX_TICKETS_PER_UPDATE) {
              if (!notices.some((entry) => entry.reason === 'limit_exceeded')) setNotice(notices, cardId, 'limit_exceeded');
              continue;
            }
            const active = activeLinkRow(db, boardId, cardId);
            if (active) continue;
            const state = mappedState(db, cache.kanbanById.get(context.kanbanId).id, context.lane.id) ?? mapping;
            if (!state) continue;
            createTicketLink(db, { actor, source, boardId, kanbanId: context.kanbanId, card, stateKey: state.state_key, now: instant });
            created++;
            actions.push({ action: 'tracker.card.create', cardIds: [cardId] });
          }
          auditActions(actor, boardId, actions);
          rejectAudit(actor, boardId, notices);
          rejectionAudited = true;
        });
      } catch (error) {
        try { log('tracker guard transaction failed', boardId, safeReason(error)); } catch { /* do not log board text */ }
        wholeReason = 'conflict';
        const affectedIds = [...new Set([...trackedLinked, ...allTrackedIds, ...candidateCards.keys()])];
        corrections.push(...restoreTrackedChanges(doc, cache, before, affectedIds, notices, 'conflict', { full: true }));
        for (const id of affectedIds) setNotice(notices, id, 'conflict');
        actions.length = 0;
        titleCommits.length = 0;
      }

      if (actions.length) invalidate(boardId);
      if (!wholeReason) for (const cardId of titleCancellations) cancelTitle(boardId, cardId);
    }

    if (notices.length && !rejectionAudited) {
      try { directory.transaction(() => rejectAudit(actor, boardId, notices)); }
      catch (error) {
        try { log('tracker guard reject audit failed', boardId, safeReason(error)); } catch { /* do not log card text */ }
      }
    }

    if (wholeReason) {
      for (const id of specialObjectIds) {
        if (affected.has(id)) continue;
        const prior = before.snapshots.get(id);
        corrections.push(() => restoredMap(doc, id, prior ?? null));
      }
    }

    if (corrections.length) {
      try {
        doc.transact(() => corrections.forEach((correct) => correct()), 'tracker-guard');
      } catch (error) {
        try { log('tracker guard correction failed', boardId, safeReason(error)); } catch { /* do not log board text */ }
      }
    }
    for (const entry of titleCommits) scheduleTitle(boardId, entry.cardId, { ...entry, title: entry.title });
    thisRelease(room, previousHeld, held);
    if (applyError && notices.length === 0) throw applyError;
    return { undone: notices };
  }

  function thisRelease(room, previousHeld, held) {
    room.held = previousHeld ?? null;
    if (previousHeld) previousHeld.push(...held);
    else if (held.length && typeof room.broadcastUpdate === 'function') {
      room.broadcastUpdate(held.length === 1 ? held[0] : Y.mergeUpdates(held));
    }
  }

  return {
    run: guardRun,
    invalidate,
    openRestoreWindow,
    closeRestoreWindow,
    clearRestoreWindows,
    flushTitles(boardId) {
      if (typeof boardId === 'string') return flushTitles(boardId);
      let committed = 0;
      for (const id of pendingTitles.keys()) committed += flushTitles(id).committed;
      return { committed };
    },
    clearTitles,
    hasPendingTitle(boardId, cardId) {
      return pendingTitles.get(boardId)?.has(cardId) ?? false;
    },
  };
}
