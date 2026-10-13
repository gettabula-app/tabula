// A look at a Yjs update (the V1 format Y.encodeStateAsUpdate writes) before it is applied. Y.applyUpdate allocates from the
// numbers in the update: for each client it makes an array as long as the client's declared struct count, before it has read
// those structs. An update built to declare a billion structs therefore costs gigabytes before anything is rejected. This walks
// the update the cheap way (it reads every struct but builds nothing: no items, no types, no content kept), checks every
// client's declared count against the bytes that are left, and refuses an update with too many clients or too many structs in
// all. Nothing is applied here.

import * as decoding from 'lib0/decoding';

/** A file or an update the import refuses; the message is shown to the person as it is. */
export class ImportError extends Error {}

export interface UpdateLimits {
  /** Most clients (separate writers, one per browser session) an update may carry. */
  clients: number;
  /** Most structs (the units Yjs stores) in all. */
  structs: number;
}

export interface UpdateShape { clients: number; structs: number }

/**
 * Reads the update from start to end without building anything and returns how many clients and structs it holds. Throws an
 * ImportError with `message` when it is too big or cannot be read. Cost is linear in the update's bytes, with no allocation
 * beyond the strings and values the decoder itself reads one at a time.
 */
export function checkYUpdate(update: Uint8Array, limits: UpdateLimits, message: string): UpdateShape {
  const unreadable = 'The board data in this file cannot be read.';
  const d = decoding.createDecoder(update);
  let structs = 0;
  let clients: number;
  try {
    clients = decoding.readVarUint(d);
    if (clients > limits.clients) throw new ImportError(message);
    for (let c = 0; c < clients; c++) {
      const count = decoding.readVarUint(d);
      // every struct takes at least one byte: a count past what is left is a lie, and is refused before anything is allocated from it
      if (count > update.length - d.pos) throw new ImportError(message);
      structs += count;
      if (structs > limits.structs) throw new ImportError(message);
      decoding.readVarUint(d); // client id
      decoding.readVarUint(d); // first clock
      for (let i = 0; i < count; i++) skipStruct(d);
    }
    // the delete set follows: Yjs builds a range for each entry, so it is counted and capped like the structs
    const deleteClients = decoding.readVarUint(d);
    if (deleteClients > limits.clients) throw new ImportError(message);
    let ranges = 0;
    for (let c = 0; c < deleteClients; c++) {
      decoding.readVarUint(d); // client id
      const n = decoding.readVarUint(d);
      // a range takes at least two bytes
      if (n * 2 > update.length - d.pos) throw new ImportError(message);
      ranges += n;
      if (ranges > limits.structs) throw new ImportError(message);
      for (let i = 0; i < n; i++) { decoding.readVarUint(d); decoding.readVarUint(d); }
    }
    // the update ends here: anything after it is not part of the format this reads
    if (decoding.hasContent(d)) throw new Error('trailing bytes');
  } catch (e) {
    if (e instanceof ImportError) throw e;
    // a V2 update (Y.encodeStateAsUpdateV2) starts with a zero byte and cannot be read as V1: say so instead of importing it as empty
    throw new ImportError(update.length > 2 && update[0] === 0 ? UNSUPPORTED_FORMAT : unreadable);
  }
  return { clients, structs };
}

export const UNSUPPORTED_FORMAT = 'This board file uses a format Tabula cannot open.';

function skipStruct(d: decoding.Decoder): void {
  const info = decoding.readUint8(d);
  const ref = info & 0b11111;
  if (ref === 0 || ref === 10) { // GC and Skip: a length
    decoding.readVarUint(d);
    return;
  }
  if (info & 0b10000000) { decoding.readVarUint(d); decoding.readVarUint(d); } // origin
  if (info & 0b01000000) { decoding.readVarUint(d); decoding.readVarUint(d); } // right origin
  if ((info & 0b11000000) === 0) {
    // neither origin: the parent is a root name or an id
    if (decoding.readVarUint(d) === 1) decoding.readVarString(d);
    else { decoding.readVarUint(d); decoding.readVarUint(d); }
    if (info & 0b00100000) decoding.readVarString(d); // parent sub
  }
  switch (ref) {
    case 1: decoding.readVarUint(d); break; // deleted
    case 2: { const n = decoding.readVarUint(d); for (let i = 0; i < n; i++) decoding.readVarString(d); break; } // json
    case 3: decoding.readVarUint8Array(d); break; // binary
    case 4: decoding.readVarString(d); break; // string
    case 5: decoding.readVarString(d); break; // embed
    case 6: decoding.readVarString(d); decoding.readVarString(d); break; // format
    case 7: { const type = decoding.readVarUint(d); if (type === 3 || type === 5) decoding.readVarString(d); break; } // type
    case 8: { const n = decoding.readVarUint(d); for (let i = 0; i < n; i++) decoding.readAny(d); break; } // any
    case 9: decoding.readVarString(d); decoding.readAny(d); break; // doc
    default: throw new Error('unknown content');
  }
}
