// Card reminders (docs/notifications.md, TAB-164 slice 2). The card_due table holds one row per card that has a person owner and
// a due date outside done lanes: ids and the due date, never card text. The board room's update hook keeps it current, a
// 15-minute sweep turns due-soon and overdue cards into ledger rows, and a one-time boot backfill fills it for existing boards.

export const CARD_DUE_SETTING = 'card_due.indexed';
export const CARD_DUE_KEEP_DAYS = 30;
export const ASSIGN_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** A field of a board object: a Y.Map entry or a plain object's property. */
const field = (value, key) => (value && typeof value.get === 'function' ? value.get(key) : value?.[key]);

/** A calendar date as YYYY-MM-DD in UTC. */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const isDueDate = (value) => typeof value === 'string' && DUE_RE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && utcDay(Date.parse(`${value}T00:00:00.000Z`)) === value;

function cardOf(doc, cardId) {
  const card = doc.getMap('objects').get(cardId);
  return field(card, 'type') === 'card' ? card : null;
}

/** The person owner of a card, or null for none, an agent, or a card that is not there. */
function personOwnerOf(card) {
  if (field(card, 'type') !== 'card' || field(card, 'ownerKind') === 'agent') return null;
  const id = field(card, 'ownerId');
  return typeof id === 'string' && id ? id : null;
}

/** The card_due row a card should have, or null when it should have none: no card, no person owner, no due date, or a done lane. */
export function cardDueRow(doc, cardId) {
  const card = cardOf(doc, cardId);
  if (!card) return null;
  const userId = personOwnerOf(card);
  if (!userId) return null;
  const due = field(card, 'due');
  if (!isDueDate(due)) return null;
  const laneId = field(card, 'parent');
  const lane = typeof laneId === 'string' ? doc.getMap('objects').get(laneId) : undefined;
  if (field(lane, 'stage') === 'done') return null;
  return { cardId, userId, due };
}

/** The first line of a card's text, or null when the card is not in the board. Read at list time only, never stored. */
export function cardFirstLine(doc, cardId) {
  const card = cardOf(doc, cardId);
  if (!card) return null;
  const text = field(card, 'text');
  return typeof text === 'string' ? text.split(/\r\n|\n|\r/u, 1)[0] : '';
}

/** The owner of every card in a board, as last seen by the relay. */
function ownerSnapshot(doc) {
  const map = new Map();
  for (const [id, object] of doc.getMap('objects').entries()) {
    if (field(object, 'type') === 'card') map.set(String(id), personOwnerOf(object));
  }
  return map;
}

/** Whether a card's id list or a lane change needs its cards looked at again. */
function cardIdsFor(doc, ids) {
  const objects = doc.getMap('objects');
  const out = new Set();
  for (const id of ids) {
    if (field(objects.get(id), 'type') === 'lane') {
      for (const [cardId, card] of objects.entries()) {
        if (field(card, 'type') === 'card' && field(card, 'parent') === id) out.add(String(cardId));
      }
    } else out.add(id);
  }
  return out;
}

/**
 * @param {object} options
 * @param {any} options.directory
 * @param {{ record: Function, ping: Function }} options.notifications
 * @param {Function|number} [options.now]
 * @param {(userId: string, kind: string) => boolean} [options.shouldNotify] The per-person quiet hours and toggles hook (slice 3).
 */
export function createCardDue({ directory, notifications, now = Date.now, shouldNotify = () => true }) {
  const db = directory?.db;
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Card reminders need a directory database');
  /** boardId -> Map(cardId -> person owner id or null). Lets an owner change be told apart from any other edit. */
  const owners = new Map();

  const nowValue = () => {
    const value = typeof now === 'function' ? now() : now;
    return Number.isSafeInteger(value) ? value : Date.now();
  };
  const activeUser = (id) => {
    const user = directory.getUser(id);
    return Boolean(user && !user.disabled);
  };

  const upsertRow = db.prepare(
    `INSERT INTO card_due (board_id, card_id, user_id, due, soon_for, overdue_for, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT (board_id, card_id) DO UPDATE SET
       soon_for = CASE WHEN card_due.user_id = excluded.user_id AND card_due.due = excluded.due THEN card_due.soon_for ELSE NULL END,
       overdue_for = CASE WHEN card_due.user_id = excluded.user_id AND card_due.due = excluded.due THEN card_due.overdue_for ELSE NULL END,
       user_id = excluded.user_id,
       due = excluded.due,
       updated_at = excluded.updated_at`,
  );
  const deleteRow = db.prepare('DELETE FROM card_due WHERE board_id = ? AND card_id = ?');
  const recentAssignment = db.prepare(
    `SELECT 1 FROM user_notifications
      WHERE user_id = ? AND kind = 'card_assigned' AND board_id = ? AND ref = ? AND created_at >= ? LIMIT 1`,
  );

  function assign(boardId, cardId, userId, actorId) {
    if (!activeUser(userId) || directory.boardRole(boardId, userId) === null) return;
    const at = nowValue();
    if (recentAssignment.get(userId, boardId, cardId, at - ASSIGN_WINDOW_MS)) return;
    notifications.record({ userId, kind: 'card_assigned', actorId, boardId, ref: cardId, createdAt: at });
  }

  /** Recompute the given card ids. `announce` is false while a snapshot is being taken, so nothing old is announced. */
  function apply(boardId, doc, cardIds, { actorId = null, announce = true } = {}) {
    const objects = doc.getMap('objects');
    let snapshot = owners.get(boardId);
    if (!snapshot) {
      snapshot = ownerSnapshot(doc);
      owners.set(boardId, snapshot);
      announce = false;
    }
    for (const cardId of cardIds) {
      const card = objects.get(cardId);
      if (field(card, 'type') !== 'card') {
        snapshot.delete(cardId);
        deleteRow.run(boardId, cardId);
        continue;
      }
      const next = personOwnerOf(card);
      const previous = snapshot.get(cardId) ?? null;
      snapshot.set(cardId, next);
      const row = cardDueRow(doc, cardId);
      if (row && activeUser(row.userId)) upsertRow.run(boardId, cardId, row.userId, row.due, nowValue());
      else deleteRow.run(boardId, cardId);
      if (announce && actorId && next && next !== previous && next !== actorId) assign(boardId, cardId, next, actorId);
    }
  }

  /** Take the owners of a board as they are now, without announcing anything (a room opened for the first time). */
  function seed(boardId, doc) {
    owners.set(boardId, ownerSnapshot(doc));
  }

  /**
   * Called from the board room's update hook after a change. `ids` are the changed object ids; a changed lane brings its cards.
   * `actorId` is the account behind the connection that made the change, or null for a write that did not come from one.
   */
  function upsertFor(boardId, doc, ids, { actorId = null } = {}) {
    apply(boardId, doc, cardIdsFor(doc, ids), { actorId });
  }

  /**
   * Index every card of a board (boot backfill). Nothing is announced: a card that is already overdue is marked as told, so an
   * upgrade does not send a burst of old news. Rows already there keep their told-marks (a backfill that runs twice, after a
   * restart before it finished, must not tell anyone twice); rows for cards that are gone are removed.
   */
  function backfill(boardId, doc) {
    const cardIds = [];
    for (const [id, object] of doc.getMap('objects').entries()) if (field(object, 'type') === 'card') cardIds.push(String(id));
    seed(boardId, doc);
    apply(boardId, doc, cardIds, { announce: false });
    const present = new Set(cardIds);
    for (const row of db.prepare('SELECT card_id FROM card_due WHERE board_id = ?').all(boardId)) {
      if (!present.has(row.card_id)) deleteRow.run(boardId, row.card_id);
    }
    db.prepare('UPDATE card_due SET overdue_for = due WHERE board_id = ? AND due < ? AND overdue_for IS NULL').run(boardId, utcDay(nowValue()));
    owners.delete(boardId); // the room seeds itself again when it is next opened
  }

  /** Forget a board's owners when its room unloads. Writes only happen in a loaded room, which seeds itself again on open. */
  function forget(boardId) {
    owners.delete(boardId);
  }

  function removeBoard(boardId) {
    db.prepare('DELETE FROM card_due WHERE board_id = ?').run(boardId);
    owners.delete(boardId);
  }

  /**
   * The 15-minute sweep, in SQL. Due today or tomorrow (UTC) is "soon" once per due date; due before today is "overdue" once per
   * due date. A row is only recorded for a person who still has a board role. Rows whose due date is older than 30 days go.
   */
  function sweep(at = nowValue()) {
    const today = utcDay(at);
    const tomorrow = utcDay(at + DAY_MS);
    const cutoff = utcDay(at - CARD_DUE_KEEP_DAYS * DAY_MS);
    const touched = new Set();
    const counts = { card_due_soon: 0, card_overdue: 0, pruned: 0 };
    directory.transaction(() => {
      counts.pruned = Number(db.prepare('DELETE FROM card_due WHERE due < ?').run(cutoff).changes);
      const candidates = [
        ['card_due_soon', 'soon_for', db.prepare(
          `SELECT board_id, card_id, user_id, due FROM card_due
            WHERE due IN (?, ?) AND (soon_for IS NULL OR soon_for <> due)`,
        ).all(today, tomorrow)],
        ['card_overdue', 'overdue_for', db.prepare(
          `SELECT board_id, card_id, user_id, due FROM card_due
            WHERE due < ? AND (overdue_for IS NULL OR overdue_for <> due)`,
        ).all(today)],
      ];
      for (const [kind, column, rows] of candidates) {
        const mark = db.prepare(`UPDATE card_due SET ${column} = due WHERE board_id = ? AND card_id = ?`);
        for (const row of rows) {
          if (!activeUser(row.user_id) || directory.boardRole(row.board_id, row.user_id) === null) continue;
          if (!shouldNotify(row.user_id, kind)) continue;
          notifications.record({ userId: row.user_id, kind, boardId: row.board_id, ref: row.card_id, createdAt: at }, { notify: false });
          mark.run(row.board_id, row.card_id);
          counts[kind]++;
          touched.add(row.user_id);
        }
      }
    });
    for (const userId of touched) notifications.ping(userId);
    return counts;
  }

  /**
   * Boot backfill: index every non-deleted board once, `batch` boards per scheduled tick, then set the settings key. A restart
   * before the key is set runs it again, which is harmless. `roomAccess.read` gives each board's document.
   */
  async function backfillAll({
    roomAccess,
    batch = 20,
    schedule = (fn) => { const timer = setTimeout(fn, 0); timer.unref?.(); },
    run = (fn) => fn(),
    log = () => {},
  }) {
    if (directory.getSetting(CARD_DUE_SETTING) === '1') return { boards: 0, skipped: true };
    const boards = db.prepare('SELECT id FROM boards WHERE deleted_at IS NULL ORDER BY id').all().map((row) => row.id);
    for (let start = 0; start < boards.length; start += batch) {
      await new Promise((resolve) => schedule(resolve));
      const slice = boards.slice(start, start + batch);
      await run(() => directory.transaction(() => {
        for (const boardId of slice) {
          try {
            roomAccess.read(boardId, (doc) => backfill(boardId, doc));
          } catch (err) {
            log(`card reminders: could not index board ${boardId}`, err?.message);
          }
        }
      }));
    }
    directory.setSetting(CARD_DUE_SETTING, '1');
    return { boards: boards.length, skipped: false };
  }

  return { seed, upsertFor, backfill, forget, removeBoard, sweep, backfillAll };
}
