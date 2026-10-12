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

type Role = 'owner' | 'admin' | 'member';
type World = Awaited<ReturnType<typeof setup>>;
const worlds: World[] = [];

async function setup(extraEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-telemetry-api-'));
  const env = {
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.test',
    DATA_DIR: dir,
    TABULA_MAIL: 'file',
    TABULA_CLOUD_TOKEN: 'k'.repeat(40),
    TABULA_CLOUD_URL: 'https://cloud.example.test',
    TABULA_CLOUD_WORKSPACE_ID: 'ws_telemetry',
    ...extraEnv,
  };
  const config = loadConfig(env, () => {});
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  const auth = createAuth({ directory, config, mailer: { send: async () => {} } });
  const cloud = {
    limits: () => ({ readOnly: true }),
    workspaceView: () => ({ readOnly: true, banner: null, seatLimit: null, seatsUsed: 0 }),
    tokenOk: () => false,
    workspaceId: config.cloud?.workspaceId,
  };
  const api = createApi({
    directory, auth, config, cloud: cloud as never,
    roomExists: () => false,
    events: new EventEmitter(),
    dataDir: dir,
    mailer: { send: async () => {} },
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let serial = 0;
  const signIn = (role: Role) => {
    const user = directory.createUser({ email: `${role}-${++serial}@example.test`, role })!;
    const session = directory.createSession(user.id, { ttlMs: 60 * 60_000 });
    return { cookie: `${config.cookieName}=${session.token}`, user };
  };
  const call = async (who: { cookie: string } | null, method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(base + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        ...(who ? { cookie: who.cookie } : {}),
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
  return { config, directory, signIn, call, close };
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

describe('telemetry privacy API', () => {
  it('lets an admin read status and preview while only the owner changes product analytics', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner');
    const admin = world.signIn('admin');

    const status = await world.call(admin, 'GET', '/api/admin/privacy');
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.locked).toBeNull();
    expect(status.body.mode).toBe('hosted');
    expect(status.body.categories).toEqual(['feature_counts']);
    expect(status.body.operational).toContain('performance');
    expect(status.body.operational).toContain('error_codes');
    expect(status.body.operational).toContain('workspace_scale');
    expect(status.body.operational).not.toContain('connections now');

    expect((await world.call(admin, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(403);
    const changed = await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: false });
    expect(changed.status).toBe(200);
    expect(changed.body.enabled).toBe(false);
    expect(changed.body.lastChangedBy.name).toBe(owner.user.name);
    expect(Number.isSafeInteger(changed.body.lastChangedBy.at)).toBe(true);

    const preview = await world.call(owner, 'GET', '/api/admin/privacy/preview');
    expect(preview.status).toBe(200);
    expect(preview.body.note).toBe('Collected by Tabula once an hour, as shown');
    expect(preview.body.preview).toMatchObject({
      schema: 1,
      mode: 'hosted',
      workspace: 'ws_telemetry',
    });
    expect(Array.isArray(preview.body.preview.metrics)).toBe(true);
    expect(preview.body.preview.events).toEqual([]);
    expect(preview.body.preview.errors).toEqual([]);

    const rows = world.directory.listAudit(20);
    expect(rows.map((row) => row.action)).toContain('telemetry.disabled');
    expect(rows.find((row) => row.action === 'telemetry.disabled')?.detail).toEqual({});
  });

  it('allows the owner setting in a read-only hosted workspace and rejects unexpected fields', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner');
    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: false, userId: 'secret' })).status).toBe(400);
    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: true })).status).toBe(200);
  });

  it('locks the API and panel state when TABULA_TELEMETRY is explicit', async () => {
    const world = await setup({ TABULA_TELEMETRY: 'off' });
    worlds.push(world);
    const owner = world.signIn('owner');
    const status = await world.call(owner, 'GET', '/api/admin/privacy');
    expect(status.body).toMatchObject({ enabled: false, locked: 'env' });
    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: true })).status).toBe(409);
  });


  it('keeps the preview GET read-only and creates a stable self-hosted id only on opt-in', async () => {
    const world = await setup({
      TABULA_CLOUD_TOKEN: '',
      TABULA_CLOUD_URL: '',
      TABULA_CLOUD_WORKSPACE_ID: '',
    });
    worlds.push(world);
    const owner = world.signIn('owner');

    const before = world.directory.getSetting('telemetry.install_id');
    expect(before).toBeNull();
    const preview = await world.call(owner, 'GET', '/api/admin/privacy/preview');
    expect(preview.status).toBe(200);
    expect(preview.body.preview.workspace).toMatch(/^ins_[a-f0-9]{32}$/);
    expect(world.directory.getSetting('telemetry.install_id')).toBeNull();

    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: true })).status).toBe(200);
    expect(world.directory.getSetting('telemetry.install_id')).toBe(preview.body.preview.workspace);
  });

  it('uses only route templates and clears product metrics as soon as the owner opts out', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner');

    expect((await world.call(owner, 'GET', '/api/admin/privacy?private_query=secret-query')).status).toBe(200);
    const enabledPreview = await world.call(owner, 'GET', '/api/admin/privacy/preview');
    expect(enabledPreview.status).toBe(200);
    const enabledReport = JSON.stringify(enabledPreview.body.preview);
    expect(enabledReport).not.toContain('secret-query');
    expect(enabledPreview.body.preview.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'http_requests_total', labels: expect.objectContaining({ route: 'admin/privacy' }) }),
      expect.objectContaining({ name: 'data_bytes', value: expect.any(Number) }),
    ]));

    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(200);
    const disabledPreview = await world.call(owner, 'GET', '/api/admin/privacy/preview');
    const disabledMetrics = disabledPreview.body.preview.metrics as { name: string }[];
    expect(disabledMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'http_requests_total' }),
      expect.objectContaining({ name: 'data_bytes' }),
      expect.objectContaining({ name: 'ws_connections_peak' }),
      expect.objectContaining({ name: 'entities_total', labels: { kind: 'boards' }, value: expect.any(Number) }),
    ]));
    expect(disabledMetrics.map((metric) => metric.name)).not.toEqual(expect.arrayContaining([
      'chat_messages_total', 'ai_calls_total', 'client_sessions_total', 'ui_events_total',
    ]));
    expect(JSON.stringify(disabledPreview.body.preview)).not.toMatch(/feature_used|chat_messages_total|ai_calls_total|client_sessions_total|ui_events_total/u);
  });

  it('persists an owner choice across API instances', async () => {
    const world = await setup();
    worlds.push(world);
    const owner = world.signIn('owner');
    expect((await world.call(owner, 'PUT', '/api/admin/privacy', { enabled: false })).status).toBe(200);
    expect(world.directory.getSetting('telemetry.enabled')).toBe('0');
  });
});
