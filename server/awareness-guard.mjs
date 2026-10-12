// Gate for client awareness updates (the MSG_AWARENESS branch of Room.onMessage).
// y-protocols applies any clientID it is handed, so without this a socket could overwrite or remove another
// person's presence. An update is a varUint count followed by (clientID, clock, JSON state) entries; the filter
// re-encodes only the entries the sending socket may write.
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const MAX_AWARENESS_UPDATE_BYTES = 64 * 1024;
export const MAX_AWARENESS_ENTRIES = 16;
export const MAX_AWARENESS_IDS_PER_SOCKET = 8;

/**
 * @param {Uint8Array} update raw awareness update from one socket
 * @param {object} opts
 * @param {Set<number>} opts.own clientIDs this socket already controls (Room.conns.get(ws))
 * @param {{ userId?: string, guest?: boolean }} [opts.self] identity of the sending socket
 * @param {Iterable<{ ids: Set<number>, userId?: string, guest?: boolean }>} opts.others every other socket in the room;
 *   ids they hold are foreign unless that socket is the same account or guest session (a reconnect keeps its clientID)
 * @param {(state: unknown) => unknown} [opts.clean] applied to each accepted non-null state
 * @returns {{ update: Uint8Array | null, ids: number[], dropped: number, oversized: boolean }} ids: accepted ids with a live state; update is null when nothing is left
 */
export function filterAwarenessUpdate(update, { own, others, self = {}, clean }) {
  if (update.length > MAX_AWARENESS_UPDATE_BYTES) return { update: null, dropped: 0, oversized: true, ids: [] };
  const foreign = new Set();
  // Same account, or the same guest session (a guest id is per session): never across guests or guest-vs-member.
  const sameAccount = (o) => typeof self.userId === 'string' && self.userId !== '' && o.userId === self.userId
    && (self.guest === true) === (o.guest === true);
  for (const o of others) if (!sameAccount(o)) for (const id of o.ids) foreign.add(id);
  const dec = decoding.createDecoder(update);
  const len = decoding.readVarUint(dec);
  if (len > MAX_AWARENESS_ENTRIES) return { update: null, ids: [], dropped: len, oversized: true };
  const kept = [];
  let dropped = 0;
  let claimed = own.size;
  const claimedNow = new Set();
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const raw = decoding.readVarString(dec);
    const mine = own.has(clientID) || claimedNow.has(clientID);
    if (!mine) {
      // A new id is accepted only while no other socket controls it and this socket is under its id budget.
      if (foreign.has(clientID) || claimed >= MAX_AWARENESS_IDS_PER_SOCKET) { dropped++; continue; }
      claimed++;
      claimedNow.add(clientID);
    }
    let state = JSON.parse(raw);
    if (state !== null && clean) state = clean(state);
    kept.push({ clientID, clock, state });
  }
  if (!kept.length) return { update: null, ids: [], dropped, oversized: false };
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, kept.length);
  for (const { clientID, clock, state } of kept) {
    encoding.writeVarUint(enc, clientID);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
  }
  return { update: encoding.toUint8Array(enc), ids: kept.filter((k) => k.state !== null).map((k) => k.clientID), dropped, oversized: false };
}

/**
 * Token bucket for the awareness frames of one socket. take() is true when the frame may be processed.
 * @param {{ burst?: number, perSecond?: number, now?: () => number }} [opts]
 */
export function createAwarenessBucket({ burst = 40, perSecond = 30, now = Date.now } = {}) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + Math.max(0, t - last) * perSecond / 1000);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * After an accepted update is applied: every id it carried with a live state (added or updated, a takeover is an
 * update) now belongs to the sending socket and no longer to any other, so the old socket closing cannot remove it.
 * @param {Map<unknown, Set<number>>} conns
 */
export function transferAwarenessOwnership(conns, ws, ids) {
  const mine = conns.get(ws);
  if (!mine) return;
  for (const id of ids) {
    mine.add(id);
    for (const [other, set] of conns) if (other !== ws) set.delete(id);
  }
}

const COLOUR_RE = /^#[0-9a-f]{6}$/i;

/**
 * State of an account socket: cursor and the like come from the client, but who they are comes from the
 * authenticated socket (userId, userName), and only a #RRGGBB colour is kept from the client.
 */
export function accountAwarenessState(state, ws, { cleanValue, cleanName, fallbackColor }) {
  if (state === null) return null;
  const cleaned = cleanValue(state);
  const safe = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : Object.create(null);
  const sent = safe.user && typeof safe.user === 'object' ? safe.user.color : null;
  const color = typeof sent === 'string' && COLOUR_RE.test(sent) ? sent : fallbackColor(String(ws.userId));
  safe.user = { id: ws.userId, name: cleanName(typeof ws.userName === 'string' ? ws.userName : ''), color };
  return safe;
}
