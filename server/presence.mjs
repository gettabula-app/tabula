const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_ROOM_LIMIT = 200;
const PEOPLE_LIMIT = 8;

const rowsOf = (connections) => connections instanceof Map ? [...connections.values()] : Array.from(connections ?? []);
const validTime = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
const validColour = (value) => typeof value === 'string' && COLOUR_RE.test(value) ? value : null;

/**
 * Builds the names-only view of one live board room. Connection records are relay-owned; awareness is never read here.
 * `now` makes missing timestamps deterministic for callers that build a record at the edge of a connection.
 */
export function presenceFor(connections, viewerId, now = Date.now()) {
  const grouped = new Map();
  let me = false;

  for (const connection of rowsOf(connections)) {
    if (!connection || typeof connection.userId !== 'string' || typeof connection.name !== 'string') continue;
    const guest = connection.guest === true;
    if (!guest && viewerId != null && connection.userId === viewerId) me = true;
    const joinedAt = validTime(connection.joinedAt, now);
    const key = `${guest ? 'guest' : 'user'}\u0000${connection.userId}`;
    const current = grouped.get(key);
    const colour = validColour(connection.colour);
    if (!current) {
      grouped.set(key, { userId: connection.userId, name: connection.name, guest, joinedAt, colour, colourJoinedAt: colour ? joinedAt : Infinity });
      continue;
    }
    if (joinedAt < current.joinedAt) {
      current.name = connection.name;
      current.joinedAt = joinedAt;
    }
    // A valid colour from the earliest tab wins; if that tab has none, use the earliest later tab that has one.
    if (colour && joinedAt < current.colourJoinedAt) {
      current.colour = colour;
      current.colourJoinedAt = joinedAt;
    }
  }

  const others = [...grouped.values()]
    .filter((person) => person.guest || person.userId !== viewerId)
    .sort((a, b) => a.joinedAt - b.joinedAt || Number(a.guest) - Number(b.guest) || a.userId.localeCompare(b.userId));
  const result = {
    count: others.length,
    people: others.slice(0, PEOPLE_LIMIT).map(({ userId, name, colour, joinedAt, guest }) => ({
      userId,
      name,
      colour,
      joinedAt,
      ...(guest ? { guest: true } : {}),
    })),
  };
  if (me) result.me = true;
  return result;
}

function projectionOf(connections) {
  return rowsOf(connections)
    .filter((connection) => connection && typeof connection.userId === 'string')
    .map((connection) => ({
      userId: connection.userId,
      name: typeof connection.name === 'string' ? connection.name : '',
      guest: connection.guest === true,
      colour: validColour(connection.colour),
      joinedAt: validTime(connection.joinedAt, 0),
    }))
    .sort((a, b) => a.joinedAt - b.joinedAt || Number(a.guest) - Number(b.guest) || a.userId.localeCompare(b.userId));
}

/** In-memory index of live board rooms, ordered by the last identity change (joins, leaves or a valid colour change). */
export function createPresenceRegistry({ maxRooms = DEFAULT_ROOM_LIMIT } = {}) {
  const limit = Number.isSafeInteger(maxRooms) && maxRooms > 0 ? maxRooms : DEFAULT_ROOM_LIMIT;
  const rooms = new Map();

  function update(boardId, connections, changedAt = Date.now()) {
    if (typeof boardId !== 'string' || boardId.length === 0) return false;
    const copied = rowsOf(connections).map((connection) => ({ ...connection, colour: validColour(connection?.colour) }));
    if (copied.length === 0) return rooms.delete(boardId);
    const projection = JSON.stringify(projectionOf(copied));
    const previous = rooms.get(boardId);
    if (previous?.projection === projection) {
      rooms.set(boardId, { ...previous, connections: copied });
      return false;
    }
    rooms.set(boardId, {
      connections: copied,
      projection,
      activeAt: validTime(changedAt, Date.now()),
    });
    return true;
  }

  function clear(boardId) {
    return rooms.delete(boardId);
  }

  function forBoard(boardId, viewerId, now = Date.now()) {
    const room = rooms.get(boardId);
    if (!room || room.connections.length === 0) return null;
    return { boardId, ...presenceFor(room.connections, viewerId, now) };
  }

  function activity(boardId) {
    return rooms.get(boardId)?.activeAt ?? null;
  }

  /**
   * @param {Iterable<string>} boardIds
   * @param {string} viewerId
   * @param {(boardId: string) => boolean} [canRead]
   * @param {number} [now]
   */
  function snapshot(boardIds, viewerId, canRead = (_boardId) => true, now = Date.now()) {
    const allowed = new Set(boardIds ?? []);
    return [...rooms.entries()]
      .filter(([boardId, room]) => allowed.has(boardId) && room.connections.length > 0 && canRead(boardId))
      .sort(([idA, roomA], [idB, roomB]) => roomB.activeAt - roomA.activeAt || idA.localeCompare(idB))
      .slice(0, limit)
      .map(([boardId, room]) => ({ boardId, ...presenceFor(room.connections, viewerId, now) }));
  }

  return { update, clear, forBoard, activity, snapshot, has: (boardId) => rooms.has(boardId), size: () => rooms.size };
}
