import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { PRODUCT_ANALYTICS_METRICS } from '../server/telemetry/collector.mjs';

// A server you run has no control plane, so nothing leaves it. When its owner turns telemetry on, the Privacy preview carries operating
// data only: no feature-use series, and no category list (docs/telemetry.md). Hosted workspaces keep their behaviour (telemetry-api.test.ts).

const PRODUCT = [...PRODUCT_ANALYTICS_METRICS] as string[];
const worlds: { close: () => Promise<void> }[] = [];

async function setupSelfRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-telemetry-self-'));
  const config = loadConfig({
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.test',
    DATA_DIR: dir,
    TABULA_MAIL: 'file',
  }, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  // an injected clock: the hour that the preview reports does not change while the test runs
  const at = Date.now();
  const api = createApi({
    directory, auth, config, roomExists: () => false, events: new EventEmitter(), dataDir: dir,
    mailer: { send: async () => {} }, now: () => at,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = directory.createUser({ email: 'owner-1@example.test', role: 'owner' })!;
  const cookie = `${config.cookieName}=${directory.createSession(owner.id, { ttlMs: 60 * 60_000 }).token}`;
  const call = async (method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(base + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    directory.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { call, close };
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

describe('telemetry on a server you run', () => {
  it('is off by default, and with the switch on its preview holds operating data only', async () => {
    const world = await setupSelfRun();
    worlds.push(world);

    const before = await world.call('GET', '/api/admin/privacy');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: false, mode: 'self', categories: [] });

    expect((await world.call('PUT', '/api/admin/privacy', { enabled: true })).status).toBe(200);
    const status = await world.call('GET', '/api/admin/privacy');
    expect(status.body).toMatchObject({ enabled: true, mode: 'self', categories: [] });
    expect(status.body.operational).toContain('performance');

    const preview = await world.call('GET', '/api/admin/privacy/preview');
    expect(preview.status).toBe(200);
    expect(preview.body.note).toBe('Nothing has been sent');
    const metrics = preview.body.preview.metrics as { name: string }[];
    const names = metrics.map((metric) => metric.name);
    expect(names).toEqual(expect.arrayContaining(['http_requests_total', 'ws_connections_peak']));
    for (const name of PRODUCT) expect(names).not.toContain(name);
    const serialized = JSON.stringify(preview.body);
    for (const name of PRODUCT) expect(serialized).not.toContain(name);
    expect(serialized).not.toContain('feature_used');
  });
});
