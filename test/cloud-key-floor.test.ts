import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createCloud } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';

const opened: Array<ReturnType<typeof openDirectory>> = [];
const clouds: Array<NonNullable<ReturnType<typeof createCloud>>> = [];
afterEach(() => {
  for (const cloud of clouds.splice(0)) cloud.close();
  for (const directory of opened.splice(0)) directory.close();
});

function setup(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const config = loadConfig({
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.com',
    TABULA_CLOUD_TOKEN: 'k'.repeat(40),
    TABULA_CLOUD_URL: 'https://cloud.example.com/',
    TABULA_CLOUD_WORKSPACE_ID: 'ws_123',
  });
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const cloud = createCloud({ config: config.cloud, directory, events: new EventEmitter(), fetch });
  clouds.push(cloud!);
  return cloud!;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('control-plane tracker key floors', () => {
  it('reports validated floors to the workspace route with the existing bearer POST client', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const cloud = setup(async (url, init) => { calls.push({ url, init }); return json({ ok: true }); });
    await expect(cloud.reportKeyFloor([{ scope: 'trk_default', prefix: 'TAB', floor: 25 }])).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://cloud.example.com/v1/workspaces/ws_123/key-floor');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${'k'.repeat(40)}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 25 }] });
    await expect(cloud.reportKeyFloor(Array.from({ length: 101 }, (_, index) => ({ scope: `trk_${index}`, prefix: 'TAB', floor: 1 }))))
      .rejects.toThrow('Invalid key floor counters');
    expect(calls).toHaveLength(1);
  });

  it('reads only bounded positive safe-integer floors and returns null for invalid answers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const replies = [
      json({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 25 }] }),
      json({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 0 }] }),
      json({ counters: Array.from({ length: 101 }, () => ({ scope: 'trk_default', prefix: 'TAB', floor: 1 })) }),
      json({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: Number.MAX_SAFE_INTEGER + 1 }] }),
    ];
    const cloud = setup(async (url, init) => { calls.push({ url, init }); return replies.shift()!; });
    await expect(cloud.readKeyFloor()).resolves.toEqual({ counters: [{ scope: 'trk_default', prefix: 'TAB', floor: 25 }] });
    expect(calls[0].url).toBe('https://cloud.example.com/v1/workspaces/ws_123/key-floor/read');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
    await expect(cloud.readKeyFloor()).resolves.toBeNull();
    await expect(cloud.readKeyFloor()).resolves.toBeNull();
    await expect(cloud.readKeyFloor()).resolves.toBeNull();
  });
});
