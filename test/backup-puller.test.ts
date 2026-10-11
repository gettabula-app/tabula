import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  main,
  pullToken,
  pullWorkspace,
  retention,
  validateConfig,
  writeMetrics,
} from '../deploy/backup-puller/pull.mjs';

const runMain: (options: any) => Promise<number> = main;
const runPullWorkspace: (options: any) => Promise<any> = pullWorkspace;
const runRetention: (options: any) => Promise<any> = retention;
const runWriteMetrics: (options: any) => Promise<string> = writeMetrics;

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const now = () => NOW;
const master = 'vector pull master 2026';
const workspace = { id: 'workspace-1', slug: 'studio', state: 'running' };
let tempRoot: string;

function fixtureDirs() {
  return {
    storeDir: path.join(tempRoot, 'store'),
    stateDir: path.join(tempRoot, 'state'),
  };
}

function objectKey(index: number) {
  return `tabula/objects/${index.toString(16).padStart(64, '0')}`;
}

function response(status: number, value: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => value,
  };
}

function bytesResponse(bytes: Buffer, midwayError = false) {
  return {
    status: 200,
    ok: true,
    body: {
      async *[Symbol.asyncIterator]() {
        if (bytes.length) yield bytes.subarray(0, Math.max(1, Math.ceil(bytes.length / 2)));
        if (midwayError) throw new Error('sensitive fetch exception');
        if (bytes.length > 1) yield bytes.subarray(Math.max(1, Math.ceil(bytes.length / 2)));
      },
    },
  };
}

function makeFetch(files: Map<string, Buffer>, options: {
  pageSize?: number;
  onRequest?: (url: URL, call: number) => unknown | Promise<unknown>;
  dataResponse?: (key: string, bytes: Buffer) => unknown;
} = {}) {
  const calls: { url: URL; authorization: string | null }[] = [];
  const orderedGets: string[] = [];
  const fetch = async (input: string | URL, init: { headers?: Record<string, string> } = {}) => {
    const url = new URL(String(input));
    const index = calls.length;
    calls.push({ url, authorization: init.headers?.authorization ?? null });
    const override = await options.onRequest?.(url, index);
    if (override) return override;
    if (url.pathname.endsWith('/list')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('after');
      const pageSize = options.pageSize ?? 1000;
      const all = [...files.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort();
      const keys = all.slice(0, pageSize).map((key) => ({ key, size: files.get(key)!.length, lastModified: '2026-10-11T11:00:00Z' }));
      const next = all.length > pageSize ? keys.at(-1)?.key ?? null : null;
      return response(200, { keys, next });
    }
    if (url.pathname.endsWith('/object')) {
      const key = url.searchParams.get('key') ?? '';
      orderedGets.push(key);
      const bytes = files.get(key);
      if (!bytes) return response(404, {});
      return options.dataResponse?.(key, bytes) ?? bytesResponse(bytes);
    }
    return response(404, {});
  };
  return { fetch, calls, orderedGets };
}

function baseConfig() {
  const dirs = fixtureDirs();
  return {
    ...dirs,
    pullMasterFile: path.join(tempRoot, 'pull-master'),
    workspacesFile: path.join(dirs.stateDir, 'workspaces.json'),
    prefix: 'tabula',
    baseUrlTemplate: 'https://{slug}.thetabula.cloud',
    concurrency: 2,
    keepDaily: 7,
    keepWeekly: 4,
    objectGraceDays: 35,
    deletedGraceDays: 30,
    workspacesMaxAgeHours: 48,
    metricsFile: path.join(dirs.stateDir, 'tabula_backup.prom'),
    requestTimeoutSeconds: 120,
  };
}

async function writeMainInputs(workspaces: unknown[] = [workspace], mode = 0o600) {
  const config = baseConfig();
  await fs.promises.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(config.pullMasterFile, `${master}\n`, { mode: 0o600 });
  await fs.promises.chmod(config.pullMasterFile, mode);
  await fs.promises.writeFile(config.workspacesFile, JSON.stringify(workspaces));
  await fs.promises.utimes(config.workspacesFile, new Date(NOW), new Date(NOW));
  const configFile = path.join(tempRoot, 'puller.json');
  await fs.promises.writeFile(configFile, JSON.stringify(config));
  return { config, configFile };
}

async function snapshotDirectory(directory: string) {
  const snapshot: Record<string, { type: string; bytes?: string; target?: string; mtimeMs: number }> = {};
  async function visit(current: string, relative = ''): Promise<void> {
    for (const name of await fs.promises.readdir(current)) {
      const file = path.join(current, name);
      const key = relative ? path.join(relative, name) : name;
      const stat = await fs.promises.lstat(file);
      if (stat.isDirectory()) {
        snapshot[key] = { type: 'directory', mtimeMs: stat.mtimeMs };
        await visit(file, key);
      } else if (stat.isSymbolicLink()) {
        snapshot[key] = { type: 'symlink', target: await fs.promises.readlink(file), mtimeMs: stat.mtimeMs };
      } else {
        snapshot[key] = { type: 'file', bytes: (await fs.promises.readFile(file)).toString('base64'), mtimeMs: stat.mtimeMs };
      }
    }
  }
  await visit(directory);
  return snapshot;
}

function manifestName(day: string, time = '120000') {
  return `${day.replaceAll('-', '')}T${time}Z.json.enc`;
}

async function makeManifestFile(root: string, name: string, content = Buffer.from(name)) {
  const file = path.join(root, 'tabula', 'manifests', name);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
  return file;
}

async function makeObjectFile(root: string, id: string, content = Buffer.from('sealed')) {
  const file = path.join(root, 'tabula', 'objects', id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
  return file;
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tabula-backup-puller-'));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

describe('backup puller token and config', () => {
  it('matches a hard-coded HMAC vector computed independently with node:crypto', () => {
    const independent = crypto.createHmac('sha256', Buffer.from('vector pull master 2026', 'utf8'))
      .update('tabula-backup-pull/workspace-42', 'utf8')
      .digest('base64url');
    expect(independent).toBe('9CThM9q7L6px-MfOouc13K4r-3PDGP3NV-PFF3CuJzw');
    expect(pullToken('vector pull master 2026', 'workspace-42')).toBe('9CThM9q7L6px-MfOouc13K4r-3PDGP3NV-PFF3CuJzw');
  });

  it.each([
    ['relative store directory', (value: any) => ({ ...value, storeDir: 'store' })],
    ['unknown field', (value: any) => ({ ...value, ignored: true })],
    ['invalid prefix', (value: any) => ({ ...value, prefix: '../tabula' })],
    ['missing slug placeholder', (value: any) => ({ ...value, baseUrlTemplate: 'https://backup.invalid' })],
    ['non-HTTPS origin', (value: any) => ({ ...value, baseUrlTemplate: 'http://{slug}.backup.invalid' })],
    ['invalid concurrency', (value: any) => ({ ...value, concurrency: 0 })],
    ['invalid retention type', (value: any) => ({ ...value, keepDaily: '7' })],
    ['invalid deleted grace period', (value: any) => ({ ...value, deletedGraceDays: -1 })],
    ['zero deleted grace period', (value: any) => ({ ...value, deletedGraceDays: 0 })],
    ['deleted grace period above maximum', (value: any) => ({ ...value, deletedGraceDays: 3651 })],
    ['fractional deleted grace period', (value: any) => ({ ...value, deletedGraceDays: 1.5 })],
    ['invalid workspace list age', (value: any) => ({ ...value, workspacesMaxAgeHours: 0 })],
    ['workspace list age above maximum', (value: any) => ({ ...value, workspacesMaxAgeHours: 8761 })],
    ['missing config field', (value: any) => { const { metricsFile: _drop, ...rest } = value; return rest; }],
  ])('rejects %s', (_name, mutate) => {
    expect(() => validateConfig(mutate(baseConfig()))).toThrow('invalid_');
  });

  it('defaults the deleted grace period to 30 days and workspace list age to 48 hours', () => {
    const config = baseConfig();
    delete (config as any).deletedGraceDays;
    delete (config as any).workspacesMaxAgeHours;
    expect(validateConfig(config).deletedGraceDays).toBe(30);
    expect(validateConfig(config).workspacesMaxAgeHours).toBe(48);
    expect(validateConfig({ ...baseConfig(), deletedGraceDays: 1 }).deletedGraceDays).toBe(1);
    expect(validateConfig({ ...baseConfig(), deletedGraceDays: 3650 }).deletedGraceDays).toBe(3650);
    expect(validateConfig({ ...baseConfig(), workspacesMaxAgeHours: 8760 }).workspacesMaxAgeHours).toBe(8760);
  });

  it('refuses a zero-day deleted grace period with configuration exit code 2', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    config.deletedGraceDays = 0;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const logs: string[] = [];

    expect(await runMain({ argv: ['--config', configFile], now, log: (line: string) => logs.push(line) })).toBe(2);
    expect(logs).toContain('configuration error invalid_deleted_grace_days');
  });
});

describe('workspace pulling', () => {
  it.each(['suspended', 'deleted', 'provisioning'])('skips %s workspaces without a request', async (state) => {
    const { config, configFile } = await writeMainInputs([{ ...workspace, state }]);
    let calls = 0;
    const code = await runMain({
      argv: ['--config', configFile],
      now,
      fetch: async () => { calls++; return response(500, {}); },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toBe(0);
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.json'))).resolves.toBeDefined();
    await expect(fs.promises.stat(config.metricsFile)).resolves.toBeDefined();
  });

  it('paginates 1,200 keys and skips files already stored at the listed sizes', async () => {
    const files = new Map<string, Buffer>();
    for (let index = 0; index < 1200; index++) files.set(objectKey(index), Buffer.from([index % 256]));
    const manifest = `tabula/manifests/${manifestName('2026-10-11')}`;
    files.set(manifest, Buffer.from('manifest bytes'));
    const dirs = fixtureDirs();
    const objectDir = path.join(dirs.storeDir, 'studio', 'tabula', 'objects');
    await fs.promises.mkdir(objectDir, { recursive: true, mode: 0o700 });
    for (const [key, bytes] of files) {
      const local = path.join(dirs.storeDir, 'studio', ...key.split('/'));
      await fs.promises.mkdir(path.dirname(local), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(local, bytes, { mode: 0o600 });
    }
    const fake = makeFetch(files, { pageSize: 1000 });
    const result = await runPullWorkspace({
      workspace,
      baseUrl: 'https://studio.thetabula.cloud',
      token: pullToken(master, workspace.id),
      ...dirs,
      fetch: fake.fetch,
      now,
      log: () => {},
      limits: { prefix: 'tabula', sleep: async () => {} },
    });
    expect(result.ok).toBe(true);
    expect(fake.calls.filter((call) => call.url.pathname.endsWith('/list') && call.url.searchParams.get('prefix') === 'tabula/objects/')).toHaveLength(2);
    expect(fake.orderedGets).toEqual([]);
    const storedMode = (await fs.promises.stat(path.join(dirs.storeDir, 'studio', ...objectKey(1199).split('/')))).mode & 0o777;
    expect(process.platform === 'win32' || storedMode === 0o600).toBe(true);
  });

  it('downloads objects before manifests', async () => {
    const object = objectKey(77);
    const manifest = `tabula/manifests/${manifestName('2026-10-11')}`;
    const fake = makeFetch(new Map([[object, Buffer.from('sealed object')], [manifest, Buffer.from('sealed manifest')]]));
    const dirs = fixtureDirs();
    const result = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: fake.fetch, now, log: () => {}, limits: { sleep: async () => {} } });
    expect(result.ok).toBe(true);
    expect(fake.orderedGets).toEqual([object, manifest]);
  });

  it('re-fetches a local file with the wrong size and records success only after all files finish', async () => {
    const dirs = fixtureDirs();
    const key = objectKey(1);
    const local = path.join(dirs.storeDir, 'studio', ...key.split('/'));
    await fs.promises.mkdir(path.dirname(local), { recursive: true });
    await fs.promises.writeFile(local, 'old');
    await fs.promises.mkdir(dirs.stateDir, { recursive: true });
    await fs.promises.writeFile(path.join(dirs.stateDir, 'studio.json'), JSON.stringify({ lastSuccessAt: '2026-10-01T00:00:00.000Z' }));
    const files = new Map([[key, Buffer.from('right-size')]]);
    const fake = makeFetch(files);
    const result = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: fake.fetch, now, log: () => {}, limits: { sleep: async () => {} } });
    expect(result.ok).toBe(true);
    expect(fake.orderedGets).toEqual([key]);
    expect(await fs.promises.readFile(local, 'utf8')).toBe('right-size');
    expect(result.state.lastSuccessAt).toBe('2026-10-11T12:00:00.000Z');
    expect(result.state.lastManifest).toBe(null);
  });

  it('leaves no final or temporary file when a streamed download fails midway', async () => {
    const dirs = fixtureDirs();
    const key = objectKey(2);
    const fake = makeFetch(new Map([[key, Buffer.from('complete')]]), { dataResponse: (_key, bytes) => bytesResponse(bytes, true) });
    const result = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: fake.fetch, now, log: () => {}, limits: { sleep: async () => {} } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('download_failed');
    const parent = path.join(dirs.storeDir, 'studio', 'tabula', 'objects');
    await expect(fs.promises.stat(path.join(parent, key.split('/').at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.promises.readdir(parent)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('refuses symlink paths and keys outside the object prefix', async () => {
    const dirs = fixtureDirs();
    const outside = path.join(tempRoot, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.mkdir(dirs.storeDir, { recursive: true });
    await fs.promises.symlink(outside, path.join(dirs.storeDir, 'studio'));
    const valid = makeFetch(new Map([[objectKey(1), Buffer.from('x')]]));
    const symlinked = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: valid.fetch, now, log: () => {}, limits: { sleep: async () => {} } });
    expect(symlinked.ok).toBe(false);
    expect(symlinked.error).toBe('unsafe_path');
    await fs.promises.rm(path.join(dirs.storeDir, 'studio'));
    const badKey = 'tabula/objects/../outside';
    const badFetch = async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/list')) return response(200, { keys: [{ key: badKey, size: 1 }], next: null });
      return response(404, {});
    };
    const refused = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: badFetch, now, log: () => {}, limits: { sleep: async () => {} } });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('invalid_key');
  });

  it.each([[401, 'http_401'], [404, 'route_disabled']] as const)('handles HTTP %s without logging credentials', async (status, expected) => {
    const dirs = fixtureDirs();
    const token = pullToken(master, workspace.id);
    const logLines: string[] = [];
    const result = await runPullWorkspace({
      workspace,
      baseUrl: 'https://studio.thetabula.cloud',
      token,
      ...dirs,
      fetch: async () => response(status, { message: token }),
      now,
      log: (line: string) => logLines.push(line),
      limits: { sleep: async () => {} },
    });
    expect(result.error).toBe(expected);
    expect(logLines.join('\n')).not.toContain(token);
    expect(logLines.join('\n')).not.toContain(master);
  });

  it('honors a capped Retry-After and retries stopped-machine 502 and 503 responses', async () => {
    const dirs = fixtureDirs();
    const sleeps: number[] = [];
    let calls = 0;
    const retry429 = await runPullWorkspace({
      workspace,
      baseUrl: 'https://studio.thetabula.cloud',
      token: 'private-token',
      ...dirs,
      fetch: async () => ++calls === 1 ? response(429, {}, { 'retry-after': '2.5' }) : response(200, { keys: [], next: null }),
      now,
      log: () => {},
      limits: { retries: 3, sleep: async (ms: number) => { sleeps.push(ms); } },
    });
    expect(retry429.ok).toBe(true);
    expect(sleeps[0]).toBe(2500);

    let transientCalls = 0;
    const stopped = { ...workspace, state: 'stopped' };
    const timeoutCalls: number[] = [];
    const stoppedResult = await runPullWorkspace({
      workspace: stopped,
      baseUrl: 'https://studio.thetabula.cloud',
      token: 'private-token',
      ...dirs,
      fetch: async () => {
        transientCalls++;
        if (transientCalls === 1) return response(502, {});
        if (transientCalls === 2) return response(503, {});
        return response(200, { keys: [], next: null });
      },
      now,
      log: () => {},
      limits: {
        retries: 3,
        baseBackoffMs: 0,
        sleep: async () => {},
        timeoutSignal: (ms: number) => { timeoutCalls.push(ms); return undefined; },
      },
    });
    expect(stoppedResult.ok).toBe(true);
    expect(transientCalls).toBe(4);
    expect(timeoutCalls.slice(0, 3)).toEqual([60_000, 60_000, 60_000]);
    expect(timeoutCalls.at(-1)).toBe(120_000);
  });

  it('keeps lastSuccessAt unchanged when a later object fetch fails', async () => {
    const dirs = fixtureDirs();
    await fs.promises.mkdir(dirs.stateDir, { recursive: true });
    const oldSuccess = '2026-10-01T00:00:00.000Z';
    await fs.promises.writeFile(path.join(dirs.stateDir, 'studio.json'), JSON.stringify({ lastSuccessAt: oldSuccess, files: 3, bytes: 50 }));
    const key = objectKey(4);
    const fake = makeFetch(new Map([[key, Buffer.from('bytes')]]), { dataResponse: () => { throw new Error('network with private data'); } });
    const result = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: fake.fetch, now, log: () => {}, limits: { retries: 0, sleep: async () => {} } });
    expect(result.ok).toBe(false);
    expect(result.state.lastSuccessAt).toBe(oldSuccess);
    const written = JSON.parse(await fs.promises.readFile(path.join(dirs.stateDir, 'studio.json'), 'utf8'));
    expect(written.lastSuccessAt).toBe(oldSuccess);
  });

  it('lets other workspaces finish after one fails and emits no master or token in logs', async () => {
    const workspaces = [workspace, { id: 'workspace-2', slug: 'other', state: 'running' }];
    const { config, configFile } = await writeMainInputs(workspaces);
    const logs: string[] = [];
    const fake = makeFetch(new Map(), {
      onRequest: (url) => url.hostname.startsWith('studio.') ? response(401, {}) : undefined,
    });
    const code = await runMain({ argv: ['--config', configFile], fetch: fake.fetch, now, log: (line: string) => logs.push(line) });
    expect(code).toBe(1);
    expect(fake.calls.some((call) => call.url.hostname.startsWith('other.'))).toBe(true);
    expect(logs.join('\n')).not.toContain(master);
    expect(logs.join('\n')).not.toContain(pullToken(master, workspace.id));
    expect(JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'other.json'), 'utf8')).lastSuccessAt).toBe('2026-10-11T12:00:00.000Z');
  });
});

describe('retention and metrics', () => {
  it('keeps seven daily points and four older weekly points by name, always keeping the newest', async () => {
    const dirs = fixtureDirs();
    const root = path.join(dirs.storeDir, 'studio');
    const table = [
      ['2026-10-11', true], ['2026-10-10', true], ['2026-10-09', true], ['2026-10-08', true],
      ['2026-10-07', true], ['2026-10-06', true], ['2026-10-05', true], ['2026-10-04', true],
      ['2026-09-27', true], ['2026-09-20', true], ['2026-09-13', true], ['2026-09-06', false], ['2026-08-30', false],
    ] as const;
    for (const [day] of table) await makeManifestFile(root, manifestName(day));
    const result = await runRetention({ workspaceDir: root, stateDir: dirs.stateDir, slug: 'studio', now, keepDaily: 7, keepWeekly: 4, objectGraceDays: 35 });
    expect(result.deleted.map((key: string) => key.split('/').at(-1)).sort()).toEqual(table.filter(([, keep]) => !keep).map(([day]) => manifestName(day)).sort());
    const remains = await fs.promises.readdir(path.join(root, 'tabula', 'manifests'));
    expect(remains).toHaveLength(11);
    expect(remains).toContain(manifestName('2026-10-11'));
  });

  it('never prunes manifests after a failed pull', async () => {
    const root = path.join(fixtureDirs().storeDir, 'studio');
    await makeManifestFile(root, manifestName('2026-10-11'));
    await makeManifestFile(root, manifestName('2026-08-30'));
    const result = await runRetention({ workspaceDir: root, now, failed: true });
    expect(result.deleted).toEqual([]);
    expect(await fs.promises.readdir(path.join(root, 'tabula', 'manifests'))).toHaveLength(2);
  });

  it('uses complete listings and the 35 day grace before deleting unseen objects', async () => {
    const dirs = fixtureDirs();
    const root = path.join(dirs.storeDir, 'studio');
    const key = objectKey(9);
    await makeObjectFile(root, key.split('/').at(-1)!);
    await fs.promises.mkdir(dirs.stateDir, { recursive: true });
    const seenFile = path.join(dirs.stateDir, 'studio.seen.json');
    const lastSeen = new Date(NOW - 34 * 24 * 60 * 60 * 1000).toISOString();
    await fs.promises.writeFile(seenFile, JSON.stringify({ lastSeen: { [key]: lastSeen } }));
    const early = await runRetention({ workspaceDir: root, stateDir: dirs.stateDir, slug: 'studio', now, listedObjects: [], objectGraceDays: 35 });
    expect(early.deleted).not.toContain(key);
    const partial = await runRetention({ workspaceDir: root, stateDir: dirs.stateDir, slug: 'studio', now: () => NOW + 2 * 24 * 60 * 60 * 1000, listedObjects: [], completeListing: false, objectGraceDays: 35 });
    expect(partial.deleted).toEqual([]);
    const late = await runRetention({ workspaceDir: root, stateDir: dirs.stateDir, slug: 'studio', now: () => NOW + 2 * 24 * 60 * 60 * 1000, listedObjects: [], objectGraceDays: 35 });
    expect(late.deleted).toContain(key);
    await expect(fs.promises.stat(path.join(root, ...key.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes exact Prometheus text with escaped labels and absent-success age', async () => {
    const file = path.join(tempRoot, 'metrics.prom');
    const workspaces = [{ id: 'one', slug: 'studio' }, { id: 'two', slug: 'odd"\\\nslug' }];
    const states = {
      studio: { lastAttemptAt: '2026-10-11T11:00:00.000Z', lastSuccessAt: '2026-10-11T10:00:00.000Z', files: 2, bytes: 123, lastManifest: '20261011T100000Z.json.enc' },
      'odd"\\\nslug': { lastAttemptAt: null, lastSuccessAt: null, files: 0, bytes: 0, lastManifest: null },
    };
    const text = await runWriteMetrics({ metricsFile: file, workspaces, states, results: { studio: { ok: true }, 'odd"\\\nslug': { ok: false } }, now, lastRunAt: new Date(NOW) });
    const escapedLabel = `workspace="${['odd', '\\' + '"', '\\\\', '\\n', 'slug'].join('')}"`;
    expect(text).toBe([
      '# HELP tabula_backup_age_seconds Seconds since the last successful backup pull.',
      '# TYPE tabula_backup_age_seconds gauge',
      '# HELP tabula_backup_last_attempt_timestamp_seconds Unix timestamp of the last backup pull attempt.',
      '# TYPE tabula_backup_last_attempt_timestamp_seconds gauge',
      '# HELP tabula_backup_last_success_timestamp_seconds Unix timestamp of the last successful backup pull.',
      '# TYPE tabula_backup_last_success_timestamp_seconds gauge',
      '# HELP tabula_backup_stored_bytes Bytes stored locally for the workspace.',
      '# TYPE tabula_backup_stored_bytes gauge',
      '# HELP tabula_backup_files Files stored locally for the workspace.',
      '# TYPE tabula_backup_files gauge',
      '# HELP tabula_backup_has_manifest Whether a manifest has been pulled for the workspace.',
      '# TYPE tabula_backup_has_manifest gauge',
      '# HELP tabula_backup_last_run_ok Whether the last backup pull run succeeded or was intentionally skipped.',
      '# TYPE tabula_backup_last_run_ok gauge',
      '# HELP tabula_backup_pending_purge Whether a deleted workspace is still inside its purge grace period.',
      '# TYPE tabula_backup_pending_purge gauge',
      'tabula_backup_age_seconds{workspace="studio"} 7200',
      'tabula_backup_last_attempt_timestamp_seconds{workspace="studio"} 1791716400',
      'tabula_backup_last_success_timestamp_seconds{workspace="studio"} 1791712800',
      'tabula_backup_stored_bytes{workspace="studio"} 123',
      'tabula_backup_files{workspace="studio"} 2',
      'tabula_backup_has_manifest{workspace="studio"} 1',
      'tabula_backup_last_run_ok{workspace="studio"} 1',
      `tabula_backup_age_seconds{${escapedLabel}} 1000000000000`,
      `tabula_backup_last_attempt_timestamp_seconds{${escapedLabel}} 0`,
      `tabula_backup_last_success_timestamp_seconds{${escapedLabel}} 0`,
      `tabula_backup_stored_bytes{${escapedLabel}} 0`,
      `tabula_backup_files{${escapedLabel}} 0`,
      `tabula_backup_has_manifest{${escapedLabel}} 0`,
      `tabula_backup_last_run_ok{${escapedLabel}} 0`,
      '# HELP tabula_backup_purged_total Number of workspace copies purged by this pull host.',
      '# TYPE tabula_backup_purged_total counter',
      'tabula_backup_purged_total 0',
      '# HELP tabula_backup_workspace_list_age_seconds Age of the workspace list file in seconds.',
      '# TYPE tabula_backup_workspace_list_age_seconds gauge',
      'tabula_backup_workspace_list_age_seconds 1000000000000',
      '# HELP tabula_backup_purge_leftovers Number of interrupted purge tombstones found at run start.',
      '# TYPE tabula_backup_purge_leftovers gauge',
      'tabula_backup_purge_leftovers 0',
      '# HELP tabula_backup_orphan_workspaces Number of store directories missing from workspaces.json.',
      '# TYPE tabula_backup_orphan_workspaces gauge',
      'tabula_backup_orphan_workspaces 0',
      '# HELP tabula_backup_puller_last_run_timestamp_seconds Unix timestamp of the last puller run.',
      '# TYPE tabula_backup_puller_last_run_timestamp_seconds gauge',
      'tabula_backup_puller_last_run_timestamp_seconds 1791720000',
      '# HELP tabula_backup_workspaces_total Number of configured workspaces.',
      '# TYPE tabula_backup_workspaces_total gauge',
      'tabula_backup_workspaces_total 2',
      '',
    ].join('\n'));
    expect(await fs.promises.readFile(file, 'utf8')).toBe(text);
  });

  it('dry run prints planned fetches without creating or changing local files', async () => {
    const dirs = fixtureDirs();
    const key = objectKey(14);
    const logs: string[] = [];
    const fake = makeFetch(new Map([[key, Buffer.from('ciphertext')]]));
    const result = await runPullWorkspace({ workspace, baseUrl: 'https://studio.thetabula.cloud', token: 'private-token', ...dirs, fetch: fake.fetch, now, log: (line: string) => logs.push(line), limits: { dryRun: true, sleep: async () => {} } });
    expect(result.ok).toBe(true);
    expect(logs).toContain(`would fetch studio ${key}`);
    await expect(fs.promises.stat(dirs.storeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(dirs.stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.orderedGets).toEqual([]);
  });

  // The puller runs on the Linux host only: Windows reports every file as mode 0666, so there the mode check is skipped by design.
  it.skipIf(process.platform === 'win32')('refuses a group-writable pull master and does not reveal its value', async () => {
    const { configFile } = await writeMainInputs([workspace], 0o660);
    const lines: string[] = [];
    const code = await runMain({ argv: ['--config', configFile], fetch: async () => response(200, {}), now, log: (line: string) => lines.push(line) });
    expect(code).toBe(2);
    expect(lines.join('\n')).not.toContain(master);
    expect(lines.join('\n')).not.toContain(pullToken(master, workspace.id));
  });
});

describe('deleted workspace purge', () => {
  const deletedWorkspace = { ...workspace, state: 'deleted' };
  const twoDays = 2 * 24 * 60 * 60 * 1000;

  it('starts the grace timer once, waits until the boundary, then removes all three paths', async () => {
    const other = { id: 'workspace-2', slug: 'other', state: 'suspended' };
    const { config, configFile } = await writeMainInputs([deletedWorkspace, other]);
    config.deletedGraceDays = 2;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'sealed-copy'), 'ciphertext');
    await fs.promises.mkdir(path.join(config.storeDir, 'other'), { recursive: true });
    await fs.promises.writeFile(path.join(config.storeDir, 'other', 'keep'), 'other workspace');
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: null, lastSuccessAt: '2026-10-01T00:00:00.000Z' }));
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.seen.json'), JSON.stringify({ lastSeen: {} }));
    await fs.promises.writeFile(path.join(config.stateDir, 'other.json'), JSON.stringify({ lastSuccessAt: '2026-10-01T00:00:00.000Z' }));
    await fs.promises.writeFile(path.join(config.stateDir, 'other.seen.json'), JSON.stringify({ lastSeen: {} }));
    const noFetch = async () => { throw new Error('deleted workspace contacted'); };

    expect(await runMain({ argv: ['--config', configFile], now, fetch: noFetch, log: () => {} })).toBe(0);
    const started = JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'studio.json'), 'utf8'));
    expect(started.deletedSince).toBe('2026-10-11T12:00:00.000Z');
    expect(await fs.promises.readFile(path.join(config.metricsFile), 'utf8')).toContain('tabula_backup_pending_purge{workspace="studio"} 1');
    expect(await fs.promises.stat(path.join(store, 'sealed-copy'))).toBeDefined();

    expect(await runMain({ argv: ['--config', configFile], now: () => NOW + 1 * 24 * 60 * 60 * 1000, fetch: noFetch, log: () => {} })).toBe(0);
    const stillStarted = JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'studio.json'), 'utf8'));
    expect(stillStarted.deletedSince).toBe(started.deletedSince);
    expect(await fs.promises.stat(path.join(store, 'sealed-copy'))).toBeDefined();

    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile], now: () => NOW + twoDays, fetch: noFetch, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('purged studio (deleted 2 days ago)');
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.seen.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.promises.readFile(path.join(config.storeDir, 'other', 'keep'), 'utf8')).toBe('other workspace');
    expect(await fs.promises.stat(path.join(config.stateDir, 'other.json'))).toBeDefined();
    const metrics = await fs.promises.readFile(config.metricsFile, 'utf8');
    expect(metrics).not.toContain('workspace="studio"');
    expect(metrics).toContain('tabula_backup_purged_total 1');
    expect(metrics).toContain('tabula_backup_workspaces_total 2');
    expect(metrics).not.toContain('tabula_backup_pending_purge{workspace="studio"}');

    await fs.promises.utimes(config.workspacesFile, new Date(NOW + 3 * 24 * 60 * 60 * 1000), new Date(NOW + 3 * 24 * 60 * 60 * 1000));
    expect(await runMain({ argv: ['--config', configFile], now: () => NOW + 3 * 24 * 60 * 60 * 1000, fetch: noFetch, log: () => {} })).toBe(0);
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const nextMetrics = await fs.promises.readFile(config.metricsFile, 'utf8');
    expect(nextMetrics).not.toContain('workspace="studio"');
    expect(nextMetrics).not.toContain('tabula_backup_pending_purge{workspace="studio"}');
    expect(JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'purged.json'), 'utf8')).slugs).toContain('studio');
  });

  it('skips expired purges for a stale workspace list, still pulls live workspaces, and exits 1', async () => {
    const oldDeleted = { id: 'workspace-2', slug: 'old', state: 'deleted' };
    const { config, configFile } = await writeMainInputs([workspace, oldDeleted]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const oldStore = path.join(config.storeDir, 'old');
    await fs.promises.mkdir(oldStore, { recursive: true });
    await fs.promises.writeFile(path.join(oldStore, 'keep'), 'ciphertext');
    await fs.promises.writeFile(path.join(config.stateDir, 'old.json'), JSON.stringify({ deletedSince: '2026-10-01T00:00:00.000Z' }));
    await fs.promises.utimes(config.workspacesFile, new Date(NOW - 49 * 60 * 60 * 1000), new Date(NOW - 49 * 60 * 60 * 1000));
    const fake = makeFetch(new Map());
    const logs: string[] = [];

    expect(await runMain({ argv: ['--config', configFile], now, fetch: fake.fetch, log: (line: string) => logs.push(line) })).toBe(1);
    expect(logs).toContain('purge skipped stale list');
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(await fs.promises.readFile(path.join(oldStore, 'keep'), 'utf8')).toBe('ciphertext');
    expect(await fs.promises.readFile(config.metricsFile, 'utf8')).toContain('tabula_backup_workspace_list_age_seconds 176400');
  });

  it('treats the configured workspace list age boundary as fresh for purge', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'keep'), 'ciphertext');
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: '2026-10-01T00:00:00.000Z' }));
    const boundary = NOW - config.workspacesMaxAgeHours * 60 * 60 * 1000;
    await fs.promises.utimes(config.workspacesFile, new Date(boundary), new Date(boundary));
    const logs: string[] = [];

    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('deleted workspace contacted'); }, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('purged studio (deleted 10 days ago)');
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resets deletedSince when a listed workspace returns to another state', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('deleted workspace contacted'); }, log: () => {} });
    await fs.promises.writeFile(config.workspacesFile, JSON.stringify([workspace]));
    await fs.promises.utimes(config.workspacesFile, new Date(NOW), new Date(NOW));
    const fake = makeFetch(new Map());
    expect(await runMain({ argv: ['--config', configFile], now: () => NOW + twoDays, fetch: fake.fetch, log: () => {} })).toBe(0);
    const state = JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'studio.json'), 'utf8'));
    expect(state.deletedSince).toBe(null);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it('reports an unlisted store directory as an orphan without starting or advancing its timer', async () => {
    const { config, configFile } = await writeMainInputs([{ id: 'workspace-2', slug: 'other', state: 'suspended' }]);
    const orphanDir = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(orphanDir, { recursive: true });
    await fs.promises.writeFile(path.join(orphanDir, 'sealed-copy'), 'ciphertext');
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('unexpected network'); }, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('orphan studio');
    expect(await fs.promises.stat(path.join(orphanDir, 'sealed-copy'))).toBeDefined();
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.promises.readFile(config.metricsFile, 'utf8')).toContain('tabula_backup_orphan_workspaces 1');
  });

  it('reports and removes a leftover purge tombstone at the start of the next run', async () => {
    const { config, configFile } = await writeMainInputs([{ ...workspace, state: 'suspended' }]);
    const leftover = path.join(config.storeDir, '.purging-studio-crashed');
    await fs.promises.mkdir(leftover, { recursive: true });
    await fs.promises.writeFile(path.join(leftover, 'sealed'), 'ciphertext');
    const logs: string[] = [];

    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('suspended workspace contacted'); }, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('purge leftover .purging-studio-crashed');
    await expect(fs.promises.stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logs).not.toContain('orphan .purging-studio-crashed');
    expect(await fs.promises.readFile(config.metricsFile, 'utf8')).toContain('tabula_backup_purge_leftovers 1');
  });

  it.each([
    ['empty file', ''],
    ['empty array', '[]'],
    ['half-written list', '[{"id":"workspace-2"'],
  ])('treats an %s workspace list as a config error before erasing anything', async (_name, contents) => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'keep'), 'ciphertext');
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: '2026-01-01T00:00:00.000Z' }));
    await fs.promises.writeFile(config.workspacesFile, contents);
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('unexpected network'); }, log: (line: string) => logs.push(line) })).toBe(2);
    expect(await fs.promises.readFile(path.join(store, 'keep'), 'utf8')).toBe('ciphertext');
    expect(await fs.promises.stat(path.join(config.stateDir, 'studio.json'))).toBeDefined();
    await expect(fs.promises.readFile(config.metricsFile, 'utf8')).resolves.toContain('tabula_backup_workspace_list_age_seconds');
  });

  it.each(['suspended', 'provisioning'])('does not start a timer for %s and clears a prior timer', async (stateName) => {
    const item = { ...workspace, state: stateName };
    const { config, configFile } = await writeMainInputs([item]);
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: '2026-10-01T00:00:00.000Z' }));
    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('skipped workspace contacted'); }, log: () => {} })).toBe(0);
    expect(JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'studio.json'), 'utf8')).deletedSince).toBe(null);
  });

  it('unlinks a nested symlink without following it when purging', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const outside = path.join(tempRoot, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'keep'), 'outside data');
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.symlink(outside, path.join(store, 'linked'));
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: '2026-10-10T12:00:00.000Z' }));
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.seen.json'), JSON.stringify({ lastSeen: {} }));
    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('deleted workspace contacted'); }, log: () => {} })).toBe(0);
    expect(await fs.promises.readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside data');
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked workspace root without deleting its target or state', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const outside = path.join(tempRoot, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'keep'), 'outside data');
    await fs.promises.mkdir(config.storeDir, { recursive: true });
    await fs.promises.symlink(outside, path.join(config.storeDir, 'studio'));
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ deletedSince: '2026-10-10T12:00:00.000Z' }));
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.seen.json'), JSON.stringify({ lastSeen: {} }));
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile], now, fetch: async () => { throw new Error('deleted workspace contacted'); }, log: (line: string) => logs.push(line) })).toBe(1);
    expect(logs).toContain('failed studio unsafe_path');
    expect(await fs.promises.readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside data');
    expect((await fs.promises.lstat(path.join(config.storeDir, 'studio'))).isSymbolicLink()).toBe(true);
    expect(await fs.promises.stat(path.join(config.stateDir, 'studio.json'))).toBeDefined();
  });

  it('unlinks a tombstone swapped to a symlink without touching the external target', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    const outside = path.join(tempRoot, 'outside');
    const held = path.join(tempRoot, 'held-store');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'keep'), 'outside data');
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'sealed'), 'ciphertext');
    const logs: string[] = [];
    const purgeHooks = {
      afterTombstoneRename: async ({ tombstone }: { tombstone: string }) => {
        await fs.promises.rename(tombstone, held);
        await fs.promises.symlink(outside, tombstone);
      },
    };

    expect(await runMain({ argv: ['--config', configFile, '--purge', 'studio', '--yes'], now, log: (line: string) => logs.push(line), purgeHooks })).toBe(0);
    expect(logs).toContain('purge symlink removed for studio; target untouched');
    expect(await fs.promises.readFile(path.join(outside, 'keep'), 'utf8')).toBe('outside data');
    expect(await fs.promises.readFile(path.join(held, 'sealed'), 'utf8')).toBe('ciphertext');
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.promises.readdir(config.storeDir)).some((name) => name.startsWith('.purging-'))).toBe(false);
  });

  it('requires --yes for operator purge and only prints the removal paths', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    const target = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(target, 'keep'), 'ciphertext');
    await fs.promises.rm(config.pullMasterFile);
    await fs.promises.writeFile(config.workspacesFile, 'not json');
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile, '--purge', 'studio'], now, fetch: async () => { throw new Error('network'); }, log: (line: string) => logs.push(line) })).toBe(2);
    expect(logs).toContain(`would remove ${target}`);
    expect(logs).toContain(`would remove ${path.join(config.stateDir, 'studio.json')}`);
    expect(logs).toContain(`would remove ${path.join(config.stateDir, 'studio.seen.json')}`);
    expect(await fs.promises.readFile(path.join(target, 'keep'), 'utf8')).toBe('ciphertext');
    expect(logs.join('\n')).not.toContain(master);
  });

  it('purges an unlisted slug immediately without reading the master or contacting the network', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    const slug = 'retired';
    const store = path.join(config.storeDir, slug);
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'sealed'), 'ciphertext');
    await fs.promises.writeFile(path.join(config.stateDir, `${slug}.json`), JSON.stringify({ deletedSince: null }));
    await fs.promises.writeFile(path.join(config.stateDir, `${slug}.seen.json`), JSON.stringify({ lastSeen: {} }));
    await fs.promises.rm(config.pullMasterFile);
    await fs.promises.writeFile(config.workspacesFile, 'not json');
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile, '--purge', slug, '--yes'], now, fetch: async () => { throw new Error('network'); }, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('purged retired (operator request)');
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(path.join(config.stateDir, `${slug}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.stat(path.join(config.stateDir, `${slug}.seen.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'purged.json'), 'utf8')).count).toBe(1);
    expect(await fs.promises.readFile(config.metricsFile, 'utf8')).toContain('tabula_backup_purged_total 1');
    expect(logs.join('\n')).not.toContain(master);
    expect(logs.join('\n')).not.toContain(pullToken(master, workspace.id));
  });

  it('refuses a listed live workspace unless --force is supplied', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'keep'), 'ciphertext');
    const logs: string[] = [];

    expect(await runMain({ argv: ['--config', configFile, '--purge', 'studio', '--yes'], now, log: (line: string) => logs.push(line) })).toBe(2);
    expect(logs).toContain('purge refused studio: listed workspace state is running; pass --force to purge');
    expect(await fs.promises.readFile(path.join(store, 'keep'), 'utf8')).toBe('ciphertext');

    expect(await runMain({ argv: ['--config', configFile, '--purge', 'studio', '--yes', '--force'], now, log: () => {} })).toBe(0);
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows immediate operator purge of a workspace listed as deleted', async () => {
    const { config, configFile } = await writeMainInputs([deletedWorkspace]);
    const store = path.join(config.storeDir, 'studio');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'keep'), 'ciphertext');

    expect(await runMain({ argv: ['--config', configFile, '--purge', 'studio', '--yes'], now, log: () => {} })).toBe(0);
    await expect(fs.promises.stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects operator purge slugs outside the workspace slug charset', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile, '--purge', '../studio', '--yes'], now, log: (line: string) => logs.push(line) })).toBe(2);
    expect(logs).toContain('configuration error invalid_arguments');
    await expect(fs.promises.stat(path.join(config.storeDir, 'studio'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('says nothing to remove and succeeds for an already absent operator purge target', async () => {
    const { configFile } = await writeMainInputs([workspace]);
    const logs: string[] = [];
    expect(await runMain({ argv: ['--config', configFile, '--purge', 'missing', '--yes'], now, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('nothing to remove for missing');
  });

  it('dry-run reports purge decisions without changing any state bytes, mtimes, or paths', async () => {
    const oldDeleted = { id: 'workspace-2', slug: 'old', state: 'deleted' };
    const restoredWorkspace = { id: 'workspace-3', slug: 'restored', state: 'running' };
    const { config, configFile } = await writeMainInputs([deletedWorkspace, oldDeleted, restoredWorkspace]);
    config.deletedGraceDays = 1;
    await fs.promises.writeFile(configFile, JSON.stringify(config));
    const store = path.join(config.storeDir, 'studio');
    const oldStore = path.join(config.storeDir, 'old');
    await fs.promises.mkdir(store, { recursive: true });
    await fs.promises.mkdir(oldStore, { recursive: true });
    await fs.promises.writeFile(path.join(store, 'keep'), 'ciphertext');
    await fs.promises.writeFile(path.join(oldStore, 'keep'), 'ciphertext');
    const oldStateFile = path.join(config.stateDir, 'old.json');
    const oldState = { deletedSince: '2026-10-01T00:00:00.000Z' };
    await fs.promises.writeFile(oldStateFile, JSON.stringify(oldState));
    const leftover = path.join(config.storeDir, '.purging-dry-run');
    await fs.promises.mkdir(leftover, { recursive: true });
    await fs.promises.writeFile(path.join(leftover, 'keep'), 'ciphertext');
    await fs.promises.writeFile(path.join(config.stateDir, 'restored.json'), JSON.stringify({ deletedSince: '2026-10-01T00:00:00.000Z' }));
    await fs.promises.writeFile(path.join(config.stateDir, 'purged.json'), JSON.stringify({ count: 4, slugs: ['restored'] }));
    await fs.promises.writeFile(config.metricsFile, 'existing metrics\n');
    const before = await snapshotDirectory(config.stateDir);
    const logs: string[] = [];
    const fake = makeFetch(new Map());
    expect(await runMain({ argv: ['--config', configFile, '--dry-run'], now, fetch: fake.fetch, log: (line: string) => logs.push(line) })).toBe(0);
    expect(logs).toContain('would start deleted grace for studio');
    expect(logs).toContain('would purge old (deleted 10 days ago)');
    expect(await snapshotDirectory(config.stateDir)).toEqual(before);
    expect(await fs.promises.readFile(path.join(store, 'keep'), 'utf8')).toBe('ciphertext');
    expect(await fs.promises.readFile(path.join(oldStore, 'keep'), 'utf8')).toBe('ciphertext');
    expect(await fs.promises.readFile(path.join(leftover, 'keep'), 'utf8')).toBe('ciphertext');
    expect(await fs.promises.readFile(oldStateFile, 'utf8')).toBe(JSON.stringify(oldState));
    await expect(fs.promises.stat(path.join(config.stateDir, 'studio.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads old state files that do not have deletedSince', async () => {
    const { config, configFile } = await writeMainInputs([workspace]);
    await fs.promises.writeFile(path.join(config.stateDir, 'studio.json'), JSON.stringify({ lastSuccessAt: '2026-10-01T00:00:00.000Z' }));
    const fake = makeFetch(new Map());
    expect(await runMain({ argv: ['--config', configFile], now, fetch: fake.fetch, log: () => {} })).toBe(0);
    const saved = JSON.parse(await fs.promises.readFile(path.join(config.stateDir, 'studio.json'), 'utf8'));
    expect(saved.deletedSince).toBe(null);
    expect(saved.lastSuccessAt).toBe('2026-10-11T12:00:00.000Z');
  });
});
