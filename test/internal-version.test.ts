import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { CHAT_MIGRATIONS, openChat } from '../server/chat.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { maxReaderOf } from '../server/schema.mjs';

const TOKEN = 'schema-report-test-token-123456789';
const STARTED_AT = 1_799_999_000_123;
const CLOUD_ENV = {
  TABULA_CLOUD_TOKEN: TOKEN,
  TABULA_CLOUD_URL: 'https://cloud.example.test',
  TABULA_CLOUD_WORKSPACE_ID: 'schema-tests',
};

const tempDirs: string[] = [];
const directories: ReturnType<typeof openDirectory>[] = [];
const chats: ReturnType<typeof openChat>[] = [];

afterEach(async () => {
  for (const chat of chats.splice(0)) chat.close();
  for (const directory of directories.splice(0)) directory.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function apiFor({ cloud = true, chatOn = true, version, startedAt = STARTED_AT }: { cloud?: boolean; chatOn?: boolean; version?: string; startedAt?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-internal-version-'));
  tempDirs.push(dir);
  const env = {
    PORT: '8787',
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.test',
    TABULA_CHAT: chatOn ? 'on' : 'off',
    ...(cloud ? CLOUD_ENV : {}),
    ...(version === undefined ? {} : { TABULA_VERSION: version }),
  };
  const config = loadConfig(env);
  const directory = openDirectory(path.join(dir, 'directory.sqlite'));
  directories.push(directory);
  const chatStore = chatOn ? openChat(path.join(dir, 'chat.sqlite')) : null;
  if (chatStore) chats.push(chatStore);
  const mailer = { send: async () => {} };
  const auth = createAuth({ directory, config, mailer });
  const cloudService = cloud
    ? {
        tokenOk: (authorization: string | undefined) => authorization === `Bearer ${TOKEN}`,
        limits: () => ({ readOnly: false }),
        seatsAvailable: () => true,
        seatUsage: () => ({ seats: 0, guests: 0, members: 0 }),
      }
    : null;
  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    cloud: cloudService as never,
    chat: (chatStore ? { store: () => chatStore, schemaReport: chatStore.schemaReport, access: () => null, hub: null } : null) as never,
    startedAt,
    mailer,
  });
  return api;
}

async function call(api: ReturnType<typeof apiFor>, authorization?: string) {
  const response = {
    headersSent: false,
    status: 0,
    body: '',
    headerValues: new Map<string, string>(),
    setHeader(name: string, value: string) {
      this.headerValues.set(name.toLowerCase(), value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers ?? {})) this.headerValues.set(name.toLowerCase(), value);
    },
    end(body?: string) {
      this.body = body ?? '';
    },
  };
  const headers = authorization ? { authorization } : {};
  await api.handle({ url: '/api/internal/version', method: 'GET', headers } as never, response as never);
  return {
    status: response.status,
    body: response.body ? JSON.parse(response.body) : undefined,
    header: (name: string) => response.headerValues.get(name.toLowerCase()) ?? null,
  };
}

describe('GET /api/internal/version', () => {
  it('requires the bearer token and is absent when cloud mode is off', async () => {
    const hosted = apiFor();
    const unauthenticated = await call(hosted);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.header('www-authenticate')).toBe('Bearer');

    const local = apiFor({ cloud: false, chatOn: false });
    const absent = await call(local, `Bearer ${TOKEN}`);
    expect(absent.status).toBe(404);
  });

  it('reports the real build and recorded disk generations without secrets', async () => {
    const api = apiFor({ version: 'release.2026-10-09' });
    const response = await call(api, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body).toEqual({
      version: 'release.2026-10-09',
      startedAt: STARTED_AT,
      build: {
        schema: { directory: MIGRATIONS.length, chat: CHAT_MIGRATIONS.length },
        maxReader: { directory: maxReaderOf(MIGRATIONS), chat: maxReaderOf(CHAT_MIGRATIONS) },
      },
      disk: {
        schema: { directory: MIGRATIONS.length, chat: CHAT_MIGRATIONS.length },
        minReader: { directory: maxReaderOf(MIGRATIONS), chat: maxReaderOf(CHAT_MIGRATIONS) },
        legacy: { directory: false, chat: false },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toMatch(/secret|password|credential/i);
  });

  it('reports a null version and null chat schema fields when chat is off', async () => {
    const api = apiFor({ cloud: true, chatOn: false });
    const response = await call(api, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.version).toBeNull();
    expect(body.startedAt).toBe(STARTED_AT);
    expect(body.build.schema).toEqual({ directory: MIGRATIONS.length, chat: null });
    expect(body.disk.minReader).toEqual({ directory: maxReaderOf(MIGRATIONS), chat: null });
    expect(body.disk.legacy).toEqual({ directory: false, chat: null });
  });
});

describe('release-info command', () => {
  it('prints schema compatibility numbers and rejects an invalid version label', () => {
    const result = spawnSync(process.execPath, ['scripts/release-info.mjs', '--version', 'v1'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 'v1',
      schema: { directory: MIGRATIONS.length, chat: CHAT_MIGRATIONS.length },
      maxReader: { directory: maxReaderOf(MIGRATIONS), chat: maxReaderOf(CHAT_MIGRATIONS) },
    });

    const bad = spawnSync(process.execPath, ['scripts/release-info.mjs', '--version', 'bad version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/--version must be/);
  });
});
