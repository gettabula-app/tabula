import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';

const DAY = 24 * 60 * 60 * 1000;
const directories: ReturnType<typeof openDirectory>[] = [];
const directory = () => {
  const store = openDirectory(':memory:');
  directories.push(store);
  return store;
};

afterEach(() => {
  for (const store of directories.splice(0)) store.close();
});

describe('persistent MCP usage store', () => {
  it('counts writes independently by actor kind, actor id and UTC day', () => {
    const store = directory();
    const tokenA = { kind: 'token', id: 'same-id' };
    const tokenB = { kind: 'token', id: 'other-token' };
    const grant = { kind: 'grant', id: 'same-id' };

    expect(store.addMcpWrites(tokenA, '2026-10-12', 3)).toBe(3);
    expect(store.addMcpWrites(tokenA, '2026-10-12', 2)).toBe(5);
    expect(store.mcpWritesToday(tokenA, '2026-10-12')).toBe(5);
    expect(store.mcpWritesToday(tokenA, '2026-10-13')).toBe(0);
    expect(store.mcpWritesToday(tokenB, '2026-10-12')).toBe(0);
    expect(store.addMcpWrites(grant, '2026-10-12', 4)).toBe(4);
    expect(store.mcpWritesToday(grant, '2026-10-12')).toBe(4);
  });

  it('stores request results per actor and removes expired records at most hourly', () => {
    const store = directory();
    const token = { kind: 'token', id: 'token-a' };
    const sameIdGrant = { kind: 'grant', id: 'token-a' };
    const now = Date.UTC(2026, 9, 12, 12);

    store.putMcpRequest(token, 'create_objects', 'request-123', 'hash-a', '{"created":1}', now - DAY - 1);
    store.putMcpRequest(sameIdGrant, 'create_objects', 'request-123', 'hash-b', '{"created":2}', now);
    expect(store.getMcpRequest(token, 'create_objects', 'request-123')).toEqual({
      argsHash: 'hash-a', resultJson: '{"created":1}', createdAt: now - DAY - 1,
    });
    expect(store.getMcpRequest(sameIdGrant, 'create_objects', 'request-123')).toEqual({
      argsHash: 'hash-b', resultJson: '{"created":2}', createdAt: now,
    });

    store.addMcpWrites(token, '2026-10-03', 1);
    store.addMcpWrites(token, '2026-10-04', 2);
    store.putMcpRequest(token, 'add_comment', 'expired-123', 'hash-c', '{"threadId":"old"}', now - DAY - 1);
    store.putMcpRequest(token, 'reply_to_comment', 'recent-123', 'hash-d', '{"replyId":"new"}', now - DAY + 1);
    expect(store.sweepMcp(now)).toEqual({ dailyUsage: 1, requests: 2 });
    expect(store.mcpWritesToday(token, '2026-10-03')).toBe(0);
    expect(store.mcpWritesToday(token, '2026-10-04')).toBe(2);
    expect(store.getMcpRequest(token, 'add_comment', 'expired-123')).toBeNull();
    expect(store.getMcpRequest(token, 'reply_to_comment', 'recent-123')).not.toBeNull();

    store.addMcpWrites(token, '2026-10-02', 1);
    expect(store.sweepMcp(now + 30 * 60 * 1000)).toEqual({ dailyUsage: 0, requests: 0 });
    expect(store.mcpWritesToday(token, '2026-10-02')).toBe(1);
    expect(store.sweepMcp(now + 60 * 60 * 1000)).toEqual({ dailyUsage: 1, requests: 1 });
    expect(store.mcpWritesToday(token, '2026-10-02')).toBe(0);
  });
});
