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
 * @param {Iterable<Set<number>>} opts.others the id sets of every other socket in the room
 * @param {(state: unknown) => unknown} [opts.clean] applied to each accepted non-null state
 * @returns {{ update: Uint8Array | null, dropped: number, oversized: boolean }} update is null when nothing is left
 */
export function filterAwarenessUpdate(update, { own, others, clean }) {
  if (update.length > MAX_AWARENESS_UPDATE_BYTES) return { update: null, dropped: 0, oversized: true };
  const foreign = new Set();
  for (const ids of others) for (const id of ids) foreign.add(id);
  const dec = decoding.createDecoder(update);
  const len = decoding.readVarUint(dec);
  if (len > MAX_AWARENESS_ENTRIES) return { update: null, dropped: len, oversized: true };
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
  if (!kept.length) return { update: null, dropped, oversized: false };
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, kept.length);
  for (const { clientID, clock, state } of kept) {
    encoding.writeVarUint(enc, clientID);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
  }
  return { update: encoding.toUint8Array(enc), dropped, oversized: false };
}
