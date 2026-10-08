import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { MSG_AI_RUNS, MSG_COMMENT_NOTICE, MSG_WORKSPACE, onAiRuns, type AiRunsMessage } from '../src/sync';

// docs/ai.md, "Live runs": the relay sends a board room's AI runs as message type 6. Like the other relay notices, the
// handler writes nothing back and a message it cannot read never breaks the socket.

type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;

const fakeProvider = () => ({ messageHandlers: [] as Handler[] });

function receive(provider: ReturnType<typeof fakeProvider>, payload: string) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AI_RUNS);
  encoding.writeVarString(enc, payload);
  const decoder = decoding.createDecoder(encoding.toUint8Array(enc));
  const type = decoding.readVarUint(decoder);
  const reply = encoding.createEncoder();
  provider.messageHandlers[type](reply, decoder, provider, true, type);
  return encoding.length(reply);
}

describe('onAiRuns', () => {
  it('uses the relay type 6, apart from the other notices', () => {
    expect(MSG_AI_RUNS).toBe(6);
    expect(new Set([MSG_WORKSPACE, MSG_COMMENT_NOTICE, MSG_AI_RUNS]).size).toBe(3);
  });

  it('passes on snapshots and patches, and writes nothing back', () => {
    const provider = fakeProvider();
    const seen: AiRunsMessage[] = [];
    onAiRuns(provider, (m) => seen.push(m));
    expect(receive(provider, JSON.stringify({ kind: 'snapshot', runs: [{ id: 'r1' }] }))).toBe(0);
    expect(receive(provider, JSON.stringify({ kind: 'patch', run: { id: 'r1', status: 'ready' } }))).toBe(0);
    expect(seen).toEqual([
      { kind: 'snapshot', runs: [{ id: 'r1' }] },
      { kind: 'patch', run: { id: 'r1', status: 'ready' } },
    ]);
  });

  it('ignores what it cannot read, without calling back or throwing', () => {
    const provider = fakeProvider();
    let calls = 0;
    onAiRuns(provider, () => calls++);
    for (const payload of ['not json', 'null', '{}', JSON.stringify({ kind: 'snapshot', runs: 'x' }), JSON.stringify({ kind: 'patch', run: null }), JSON.stringify({ kind: 'other' })]) {
      expect(() => receive(provider, payload)).not.toThrow();
    }
    expect(calls).toBe(0);
  });

  it('keeps the socket working when the listener throws', () => {
    const provider = fakeProvider();
    onAiRuns(provider, () => {
      throw new Error('listener failed');
    });
    expect(() => receive(provider, JSON.stringify({ kind: 'snapshot', runs: [] }))).not.toThrow();
  });
});
