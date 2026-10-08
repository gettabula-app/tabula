import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { MSG_COMMENT_NOTICE, MSG_WORKSPACE, onCommentNotice } from '../src/sync';

// docs/comment-authz.md, "Telling the user": the relay sends a notice (message type 5) only to the socket whose change it
// undid. Like the workspace hint, the handler writes nothing back and a bad notice never breaks the socket.

type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;

function fakeProvider() {
  return { messageHandlers: [] as Handler[] };
}
type FakeProvider = ReturnType<typeof fakeProvider>;

/** Delivers a message to the provider the way y-websocket does: by its first varUint. Returns how much the handler wrote back. */
function receive(provider: FakeProvider, payload: string, type = MSG_COMMENT_NOTICE) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  encoding.writeVarString(enc, payload);
  const decoder = decoding.createDecoder(encoding.toUint8Array(enc));
  const messageType = decoding.readVarUint(decoder);
  const reply = encoding.createEncoder();
  provider.messageHandlers[messageType](reply, decoder, provider, true, messageType);
  return encoding.length(reply);
}

describe('onCommentNotice', () => {
  it('uses a message type that is neither a y-websocket type nor the workspace hint', () => {
    // 0 sync, 1 awareness, 2 auth, 3 query awareness, 4 the workspace hint
    expect(MSG_COMMENT_NOTICE).toBe(5);
    expect(MSG_COMMENT_NOTICE).not.toBe(MSG_WORKSPACE);
  });

  it('calls back with the kinds the relay undid, and writes nothing back to the relay', () => {
    const provider = fakeProvider();
    const seen: string[][] = [];
    onCommentNotice(provider, (undone) => seen.push(undone));
    expect(receive(provider, JSON.stringify({ undone: ['edit', 'author'] }))).toBe(0);
    expect(receive(provider, JSON.stringify({ undone: ['delete'] }))).toBe(0);
    expect(seen).toEqual([['edit', 'author'], ['delete']]);
  });

  it('keeps only the kinds that are strings', () => {
    const provider = fakeProvider();
    const seen: string[][] = [];
    onCommentNotice(provider, (undone) => seen.push(undone));
    receive(provider, JSON.stringify({ undone: ['resolve', 3, null, { kind: 'edit' }] }));
    expect(seen).toEqual([['resolve']]);
  });

  it('ignores a notice it cannot read, without calling back or throwing', () => {
    const provider = fakeProvider();
    let calls = 0;
    onCommentNotice(provider, () => calls++);
    expect(() => receive(provider, 'not json')).not.toThrow();
    expect(() => receive(provider, 'null')).not.toThrow();
    expect(() => receive(provider, JSON.stringify({ undone: 'edit' }))).not.toThrow();
    expect(() => receive(provider, JSON.stringify({}))).not.toThrow();
    expect(calls).toBe(0);
  });

  it('keeps the socket working when the listener throws', () => {
    const provider = fakeProvider();
    onCommentNotice(provider, () => {
      throw new Error('listener failed');
    });
    expect(() => receive(provider, JSON.stringify({ undone: ['edit'] }))).not.toThrow();
  });
});
