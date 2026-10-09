import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api';
import {
  CLIENT_ID_RE, backoffMs, classifyFailure, delivered, enqueue, isClientId, newClientId, nextToSend, outboxItem, removeItem, revive,
  updateItem, type OutboxItem,
} from '../src/ui/chat-logic';

// docs/chat.md, Offline: sending always goes through the outbox, oldest first, one at a time; a retry is harmless
// because of the clientId; a refusal for good stays visible with its text until the person discards it.

const item = (clientId: string, createdLocal: number, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  ...outboxItem({ clientId, kind: 'board', ref: 'b1', text: `text ${clientId}`, createdLocal }),
  ...extra,
});

const message = (id: number, clientId: string, authorId = 'me', ref = 'b1'): ChatMessage => ({
  id, kind: 'board', ref, authorId, authorName: 'Me', clientId, text: 'x', replyTo: null, objectId: null, mentions: [],
  createdAt: 1, editedAt: null, deleted: false, deletedBy: null,
});

describe('client ids', () => {
  it('makes ids the server accepts, different every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClientId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(CLIENT_ID_RE);
      expect(isClientId(id)).toBe(true);
    }
  });

  it('uses only the random bytes it is given', () => {
    expect(newClientId((n) => new Uint8Array(n))).toBe('A'.repeat(22));
    expect(newClientId((n) => new Uint8Array(n).fill(63))).toBe('_'.repeat(22));
  });

  it('checks the shape', () => {
    expect(isClientId('short')).toBe(false);
    expect(isClientId('x'.repeat(65))).toBe(false);
    expect(isClientId('has space in it')).toBe(false);
    expect(isClientId(12345678)).toBe(false);
  });
});

describe('outbox order', () => {
  it('keeps items oldest first, whatever order they were added in', () => {
    let box: OutboxItem[] = [];
    box = enqueue(box, item('cccccccc', 3));
    box = enqueue(box, item('aaaaaaaa', 1));
    box = enqueue(box, item('bbbbbbbb', 2));
    expect(box.map((o) => o.clientId)).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  });

  it('adds a clientId once', () => {
    const box = enqueue(enqueue([], item('aaaaaaaa', 1)), item('aaaaaaaa', 5));
    expect(box).toHaveLength(1);
    expect(box[0].createdLocal).toBe(1);
  });

  it('sends the oldest first and one at a time', () => {
    const box = [item('aaaaaaaa', 1), item('bbbbbbbb', 2)];
    expect(nextToSend(box, 10)?.clientId).toBe('aaaaaaaa');
    const sending = updateItem(box, 'aaaaaaaa', { state: 'sending' });
    expect(nextToSend(sending, 10)).toBeNull();
    const sent = removeItem(sending, 'aaaaaaaa');
    expect(nextToSend(sent, 10)?.clientId).toBe('bbbbbbbb');
  });

  it('never lets a later message overtake one that must wait', () => {
    const box = [item('aaaaaaaa', 1, { waitUntil: 100 }), item('bbbbbbbb', 2)];
    expect(nextToSend(box, 50)).toBeNull();
    expect(nextToSend(box, 100)?.clientId).toBe('aaaaaaaa');
  });

  it('retries a message that failed for now before the ones after it', () => {
    const box = [item('aaaaaaaa', 1, { state: 'failed' }), item('bbbbbbbb', 2)];
    expect(nextToSend(box, 10)?.clientId).toBe('aaaaaaaa');
  });

  it('skips a message refused for good, so it does not hold up the rest', () => {
    const box = [item('aaaaaaaa', 1, { state: 'blocked', reason: 'the workspace is read-only' }), item('bbbbbbbb', 2)];
    expect(nextToSend(box, 10)?.clientId).toBe('bbbbbbbb');
    expect(nextToSend([box[0]], 10)).toBeNull();
  });

  it('puts a message that was on its way when the page closed back in the queue', () => {
    const box = revive([item('bbbbbbbb', 2), item('aaaaaaaa', 1, { state: 'sending' }), item('cccccccc', 3, { state: 'blocked' })]);
    expect(box.map((o) => [o.clientId, o.state])).toEqual([['aaaaaaaa', 'queued'], ['bbbbbbbb', 'queued'], ['cccccccc', 'blocked']]);
  });
});

describe('idempotent retry by clientId', () => {
  it('finds outbox items the server already has, by this person in the same channel', () => {
    const box = [item('aaaaaaaa', 1), item('bbbbbbbb', 2), item('cccccccc', 3)];
    const seen = delivered(box, [message(7, 'aaaaaaaa'), message(8, 'bbbbbbbb', 'someone-else'), message(9, 'cccccccc', 'me', 'other-board')], 'me');
    expect(seen.map((o) => o.clientId)).toEqual(['aaaaaaaa']);
  });

  it('keeps the same clientId through every retry', () => {
    let box = [item('aaaaaaaa', 1)];
    box = updateItem(box, 'aaaaaaaa', { state: 'failed' });
    box = updateItem(box, 'aaaaaaaa', { state: 'sending' });
    expect(box[0].clientId).toBe('aaaaaaaa');
    expect(box[0].text).toBe('text aaaaaaaa');
  });
});

describe('failures', () => {
  it('retries when there was no answer or the server failed', () => {
    expect(classifyFailure(0, 'network')).toEqual({ kind: 'retry' });
    expect(classifyFailure(500, 'internal')).toEqual({ kind: 'retry' });
    expect(classifyFailure(503, 'restoring')).toEqual({ kind: 'retry' });
  });

  it('waits as long as a 429 says', () => {
    expect(classifyFailure(429, 'rate_limited', 7)).toEqual({ kind: 'wait', ms: 7000 });
    expect(classifyFailure(429, 'rate_limited')).toEqual({ kind: 'wait', ms: 5000 });
  });

  it('stops on 401 until the person signs in again', () => {
    expect(classifyFailure(401, 'unauthenticated')).toEqual({ kind: 'signed-out' });
  });

  it.each<[number, string, string]>([
    [400, 'too_long', 'a message can be at most 2000 characters'],
    [400, 'empty', 'the message is empty'],
    [400, 'too_many_mentions', 'a message can mention at most 10 people'],
    [400, 'bad_request', 'the server could not read it'],
    [402, 'read_only', 'the workspace is read-only'],
    [403, 'read_only_viewer', 'viewers cannot post in this chat'],
    [403, 'forbidden', 'you cannot post in this chat'],
    [404, 'not_found', 'you no longer have access to this chat'],
  ])('keeps the text with a reason on %i %s', (status, code, reason) => {
    expect(classifyFailure(status, code)).toEqual({ kind: 'permanent', reason });
  });

  it('keeps a refused message visible until it is discarded', () => {
    let box = [item('aaaaaaaa', 1), item('bbbbbbbb', 2)];
    const failure = classifyFailure(402, 'read_only');
    if (failure.kind !== 'permanent') throw new Error('expected a permanent failure');
    box = updateItem(box, 'aaaaaaaa', { state: 'blocked', reason: failure.reason });
    box = removeItem(box, 'bbbbbbbb');
    expect(box).toEqual([{ ...item('aaaaaaaa', 1), state: 'blocked', reason: 'the workspace is read-only' }]);
    expect(removeItem(box, 'aaaaaaaa')).toEqual([]);
  });
});

describe('backoff', () => {
  it('doubles from one second up to thirty, with jitter between half and all of it', () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(30_000);
    expect(backoffMs(100, () => 1)).toBe(30_000);
    expect(backoffMs(2, () => 0)).toBe(2000);
  });
});
