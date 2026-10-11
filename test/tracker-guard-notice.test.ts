import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { MSG_TRACKER_NOTICE, MSG_COMMENT_NOTICE, MSG_AI_RUNS, MSG_WORKSPACE, onTrackerNotice, type TrackerNoticeMessage } from '../src/sync';
import { noticeText } from '../src/tracker/ui/guard-notice';

type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;
const fakeProvider = () => ({ messageHandlers: [] as Handler[] });
type FakeProvider = ReturnType<typeof fakeProvider>;

function receive(provider: FakeProvider, payload: string) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_TRACKER_NOTICE);
  encoding.writeVarString(enc, payload);
  const decoder = decoding.createDecoder(encoding.toUint8Array(enc));
  const type = decoding.readVarUint(decoder);
  const reply = encoding.createEncoder();
  provider.messageHandlers[type](reply, decoder, provider, true, type);
  return encoding.length(reply);
}

describe('tracker guard notices', () => {
  it('uses the next free relay message type', () => {
    expect(MSG_TRACKER_NOTICE).toBe(7);
    expect(new Set([MSG_WORKSPACE, MSG_COMMENT_NOTICE, MSG_AI_RUNS, MSG_TRACKER_NOTICE]).size).toBe(4);
  });

  it('keeps string card ids, maps unknown string reasons to conflict and writes nothing back', () => {
    const provider = fakeProvider();
    const seen: TrackerNoticeMessage[] = [];
    onTrackerNotice(provider, (message) => seen.push(message));
    expect(receive(provider, JSON.stringify({ undone: [
      { cardId: 'c1', reason: 'lane_unmapped' },
      { cardId: 'c2', reason: 'future_reason' },
      { cardId: 4, reason: 'forbidden' },
      { cardId: 'c3', reason: null },
      null,
    ] }))).toBe(0);
    expect(seen).toEqual([{ undone: [
      { cardId: 'c1', reason: 'lane_unmapped' },
      { cardId: 'c2', reason: 'conflict' },
    ] }]);
  });

  it('ignores malformed payloads and notices without valid entries', () => {
    const provider = fakeProvider();
    let calls = 0;
    onTrackerNotice(provider, () => calls++);
    for (const payload of ['not json', 'null', '{}', JSON.stringify({ undone: 'x' }), JSON.stringify({ undone: [{ reason: 'forbidden' }] })]) {
      expect(() => receive(provider, payload)).not.toThrow();
    }
    expect(calls).toBe(0);
  });

  it('does not let a throwing listener break the socket', () => {
    const provider = fakeProvider();
    onTrackerNotice(provider, () => { throw new Error('listener failed'); });
    expect(() => receive(provider, JSON.stringify({ undone: [{ cardId: 'c1', reason: 'forbidden' }] }))).not.toThrow();
  });

  it('shows one reason in contract priority order and never includes card details', () => {
    expect(noticeText(['conflict', 'forbidden', 'lane_unmapped', 'lane_unmapped']))
      .toBe("That lane isn't linked to a tracker state. The card went back.");
    expect(noticeText(['unknown'])).toBe('The ticket changed first. The card went back.');
    expect(noticeText([])).toBe('');
  });
});
