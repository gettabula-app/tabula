import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { CONFIRM } from '../restore-harness';
import { main as pullerMain, pullToken } from '../../deploy/backup-puller/pull.mjs';
import { main as restoreCheckMain } from '../../deploy/backup-puller/restore-check.mjs';
import { createRelayKit, until, type Relay } from './drill-kit';

// TAB-94: rehearse the off-site copy path over the real relay HTTP routes. The puller's configured HTTPS host is
// rewritten by its injected fetch to the local relay, so auth, listing, streaming and incremental decisions all run.

const CLOUD_TOKEN = 'o'.repeat(48);
const WORKSPACE_ID = 'ws_offsite_drill';
const WORKSPACE_SLUG = 'offsite-drill';
const PULL_MASTER = 'literal offsite drill pull master 2026';
const PULL_TOKEN = pullToken(PULL_MASTER, WORKSPACE_ID);
const PULL_TOKEN_SHA256 = crypto.createHash('sha256').update(PULL_TOKEN).digest('hex');
const BACKUP_KEY = crypto.createHash('sha256').update('offsite drill backup key').digest();
const WRONG_KEY = crypto.createHash('sha256').update('offsite drill wrong key').digest();
const OWNER = 'owner@example.com';
const BOARD = 'offsiteRestoreBoard';
const NOTE_ID = 'offsite-note';
const EDIT_ONE = 'first off-site board edit';
const EDIT_TWO = 'second off-site board edit';
const DAY_MS = 24 * 60 * 60 * 1000;

const workspace = { id: WORKSPACE_ID, slug: WORKSPACE_SLUG, state: 'running' as const };
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tabula-offsite-drill-'));
const relayDataDir = path.join(scratch, 'relay-data');
fs.mkdirSync(relayDataDir, { recursive: true });

const pullerRoot = path.join(scratch, 'puller');
const storeDir = path.join(pullerRoot, 'store');
const stateDir = path.join(pullerRoot, 'state');
const pullMasterFile = path.join(pullerRoot, 'pull-master');
const workspacesFile = path.join(stateDir, 'workspaces.json');
const metricsFile = path.join(stateDir, 'tabula_backup.prom');
const pullerConfigFile = path.join(pullerRoot, 'puller.json');
const pullerConfig = {
  storeDir,
  stateDir,
  pullMasterFile,
  workspacesFile,
  prefix: 'tabula',
  // The production contract requires HTTPS. `fetchFromRelay` below rewrites this host to the local HTTP relay.
  baseUrlTemplate: 'https://{slug}.offsite.invalid',
  concurrency: 1,
  keepDaily: 7,
  keepWeekly: 4,
  objectGraceDays: 35,
  deletedGraceDays: 1,
  workspacesMaxAgeHours: 48,
  metricsFile,
  requestTimeoutSeconds: 120,
};

const kit = createRelayKit(CLOUD_TOKEN);
type Client = ReturnType<typeof kit.client>;
const s: {
  relay?: Relay;
  client?: Client;
  owner?: string;
  editor?: ReturnType<Client['connect']>;
  firstManifest?: string;
  latestManifest?: string;
  pullNow: number;
  pullerLogs: string[];
  restoreRelay?: Relay;
} = { pullNow: Date.now(), pullerLogs: [] };

let controlPlane: http.Server | undefined;
let controlUrl = '';

beforeAll(async () => {
  controlPlane = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => controlPlane!.listen(0, '127.0.0.1', resolve));
  controlUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
});

afterAll(async () => {
  kit.closeClients();
  await kit.killAll();
  if (controlPlane) await new Promise<void>((resolve) => controlPlane!.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const relayEnv = (extra: Record<string, string> = {}) => ({
  TABULA_CLOUD_TOKEN: CLOUD_TOKEN,
  TABULA_CLOUD_URL: controlUrl,
  TABULA_CLOUD_WORKSPACE_ID: WORKSPACE_ID,
  TABULA_BACKUP_TARGET: 'dir',
  TABULA_BACKUP_KEY: BACKUP_KEY.toString('base64'),
  TABULA_BACKUP_PULL_TOKEN_SHA256: PULL_TOKEN_SHA256,
  TABULA_BACKUP_SETTLE_SECONDS: '3',
  TABULA_BACKUP_VERIFY_HOURS: '0',
  TABULA_BACKUP_KEEP_HOURLY_HOURS: '0',
  TABULA_BACKUP_KEEP_DAILY_DAYS: '0',
  TABULA_TEST_RESTORE_EXIT_DELAY_MS: '2500',
  TABULA_TEST_RESTORE_DISK_USED: '0.2',
  ...extra,
});

const startRelay = (dir: string, extra: Record<string, string> = {}) => kit.launch(dir, relayEnv(extra), { clean: true });

function boardText(file: string) {
  if (!fs.existsSync(file)) return undefined;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, fs.readFileSync(file));
    return (doc.getMap('objects').get(NOTE_ID) as Y.Map<unknown> | undefined)?.get('text');
  } catch {
    return undefined;
  } finally {
    doc.destroy();
  }
}

async function backedUpSince(since: number, timeoutMs = 30_000) {
  let status: any;
  await until(async () => {
    status = (await s.client!.internal('/api/internal/backup-status')).body;
    return typeof status.lastSuccessAt === 'number' && status.lastSuccessAt >= since && !status.running && !status.dirty;
  }, timeoutMs);
  return status;
}

function writeWorkspaces(workspaces: { id: string; slug: string; state: string }[], at: number) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(workspacesFile, `${JSON.stringify(workspaces, null, 2)}\n`);
  fs.utimesSync(workspacesFile, new Date(at), new Date(at));
}

function initializePuller() {
  fs.mkdirSync(pullerRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pullMasterFile, `${PULL_MASTER}\n`, { mode: 0o600 });
  fs.chmodSync(pullMasterFile, 0o600);
  fs.writeFileSync(pullerConfigFile, `${JSON.stringify(pullerConfig, null, 2)}\n`);
  s.pullNow = Date.now();
  writeWorkspaces([workspace], s.pullNow);
}

function fetchFromRelay(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const requested = new URL(String(input));
  const local = new URL(`${requested.pathname}${requested.search}`, s.relay!.base);
  return fetch(local, init);
}

async function runPuller(argv = ['--config', pullerConfigFile]) {
  s.pullNow = Date.now();
  writeWorkspaces([workspace], s.pullNow);
  const lines: string[] = [];
  const code = await (pullerMain as (options: any) => Promise<number>)({
    argv,
    now: () => s.pullNow,
    fetch: fetchFromRelay,
    log: (line: string) => {
      lines.push(line);
      s.pullerLogs.push(line);
    },
  });
  return { code, lines };
}

function listFiles(root: string) {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const visit = (dir: string, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, next);
      else out.push(next);
    }
  };
  visit(root);
  return out.sort();
}

describe('off-site backup drill (runbook section 8.3)', () => {
  it('[8.3.dir-backup] a dir-target relay seals a board edit and writes its first manifest', async () => {
    s.relay = await startRelay(relayDataDir);
    s.client = kit.client(s.relay, relayDataDir);
    s.owner = await s.client.signIn(OWNER);
    expect((await s.client.api(s.owner, 'POST', '/api/boards', { id: BOARD, title: 'Off-site Restore Board' })).status).toBe(201);

    s.editor = s.client.connect(BOARD, s.owner);
    await until(() => s.editor!.provider.wsconnected && s.editor!.provider.synced);
    const since = Date.now();
    s.editor.doc.getMap('objects').set(NOTE_ID, new Y.Map<unknown>([
      ['id', NOTE_ID], ['type', 'note'], ['text', EDIT_ONE], ['x', 0], ['y', 0], ['w', 220], ['h', 100],
    ]));
    await until(() => boardText(path.join(relayDataDir, `${BOARD}.yjs`)) === EDIT_ONE, 10_000);
    const status = await backedUpSince(since);
    s.firstManifest = status.lastManifest;
    s.latestManifest = status.lastManifest;
    expect(status).toMatchObject({ enabled: true, target: 'dir', lastError: null });
    expect(status.lastManifest).toMatch(/^\d{8}T\d{6}Z\.json\.enc$/);
    expect(fs.existsSync(path.join(relayDataDir, 'backup-export', 'tabula', 'manifests', s.firstManifest!))).toBe(true);
  });

  it('[8.3.export-auth] export requires the pull token and hides keys outside objects and manifests', async () => {
    const base = s.relay!.base;
    const list = `${base}/api/backup-export/list?prefix=tabula%2Fobjects%2F`;
    const absent = await fetch(list);
    const wrong = await fetch(list, { headers: { authorization: 'Bearer wrong-offsite-token' } });
    const outside = await fetch(`${base}/api/backup-export/object?key=${encodeURIComponent('tabula/private/outside')}`, {
      headers: { authorization: `Bearer ${PULL_TOKEN}` },
    });
    const allowed = await fetch(list, { headers: { authorization: `Bearer ${PULL_TOKEN}` } });
    expect([absent.status, wrong.status, outside.status, allowed.status]).toEqual([401, 401, 404, 200]);
    expect(await allowed.json()).toMatchObject({ keys: expect.any(Array) });
  });

  it('[8.3.pull] the puller downloads the sealed files and writes state and Prometheus metrics', async () => {
    initializePuller();
    const mode = fs.statSync(pullMasterFile).mode & 0o777;
    expect(process.platform === 'win32' || mode === 0o600).toBe(true);
    const firstPull = await (pullerMain as (options: any) => Promise<number>)({
      argv: ['--config', pullerConfigFile],
      now: () => s.pullNow,
      fetch: fetchFromRelay,
      log: (line: string) => s.pullerLogs.push(line),
    });
    expect(firstPull, `puller log: ${s.pullerLogs.join(' | ')}`).toBe(0);

    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`), 'utf8'));
    expect(saved).toMatchObject({ lastError: null, newFiles: expect.any(Number), lastManifest: s.firstManifest });
    expect(saved.newFiles).toBeGreaterThan(0);
    expect(saved.lastSuccessAt).toBe(new Date(s.pullNow).toISOString());
    expect(listFiles(path.join(storeDir, WORKSPACE_SLUG))).toContain(`tabula/manifests/${s.firstManifest}`);
    expect(fs.readFileSync(metricsFile, 'utf8')).toContain(`tabula_backup_last_run_ok{workspace="${WORKSPACE_SLUG}"} 1`);
  });

  it('[8.3.pull-incremental] unchanged pulls fetch nothing and a later edit fetches only new files', async () => {
    const priorFiles = listFiles(path.join(storeDir, WORKSPACE_SLUG));
    const unchanged = await runPuller();
    expect(unchanged.code).toBe(0);
    expect(unchanged.lines.filter((line) => line.startsWith(`fetch ${WORKSPACE_SLUG} `))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`), 'utf8')).newFiles).toBe(0);

    const since = Date.now();
    (s.editor!.doc.getMap('objects').get(NOTE_ID) as Y.Map<unknown>).set('text', EDIT_TWO);
    await until(() => boardText(path.join(relayDataDir, `${BOARD}.yjs`)) === EDIT_TWO, 10_000);
    const status = await backedUpSince(since);
    s.latestManifest = status.lastManifest;
    expect(s.latestManifest).not.toBe(s.firstManifest);

    const changed = await runPuller();
    expect(changed.code).toBe(0);
    const afterFiles = listFiles(path.join(storeDir, WORKSPACE_SLUG));
    const old = new Set(priorFiles);
    const newlyStored = afterFiles.filter((file) => !old.has(file)).sort();
    const downloaded = changed.lines
      .filter((line) => line.startsWith(`fetch ${WORKSPACE_SLUG} `))
      .map((line) => line.slice(`fetch ${WORKSPACE_SLUG} `.length))
      .sort();
    expect(newlyStored).toContain(`tabula/manifests/${s.latestManifest}`);
    expect(downloaded).toEqual(newlyStored);
    expect(downloaded.length).toBeGreaterThan(0);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`), 'utf8'));
    expect(saved).toMatchObject({ newFiles: downloaded.length, lastManifest: s.latestManifest, lastError: null });
  });

  it('[8.3.restore-check] the pulled store passes keyed verification and structure-only verification', async () => {
    const store = path.join(storeDir, WORKSPACE_SLUG);
    const rightOutput: string[] = [];
    const right = await (restoreCheckMain as (options: any) => Promise<number>)({
      argv: ['--store', store],
      env: { TABULA_RESTORE_KEY: BACKUP_KEY.toString('hex') },
      write: (line: string) => rightOutput.push(line),
    });
    expect(right).toBe(0);
    expect(JSON.parse(rightOutput[0])).toMatchObject({ ok: true, manifest: s.latestManifest });
    expect(JSON.parse(rightOutput[0]).files).toBeGreaterThan(0);
    expect(JSON.parse(rightOutput[0]).bytes).toBeGreaterThan(0);

    const wrongOutput: string[] = [];
    const wrong = await (restoreCheckMain as (options: any) => Promise<number>)({
      argv: ['--store', store],
      env: { TABULA_RESTORE_KEY: WRONG_KEY.toString('hex') },
      write: (line: string) => wrongOutput.push(line),
    });
    expect(wrong).toBe(1);
    expect(JSON.parse(wrongOutput[0])).toMatchObject({ ok: false, manifest: s.latestManifest });

    const structureOutput: string[] = [];
    const structure = await (restoreCheckMain as (options: any) => Promise<number>)({
      argv: ['--store', store, '--structure-only'],
      env: {},
      write: (line: string) => structureOutput.push(line),
    });
    expect(structure).toBe(0);
    expect(JSON.parse(structureOutput[0])).toMatchObject({ ok: true, manifest: s.latestManifest });
  });

  it('[8.3.decrypt-restore] an empty dir-target relay restores the newest pulled manifest and board edit', async () => {
    kit.closeClients();
    expect(await kit.stop(s.relay!)).toBe(0);

    const disasterDataDir = path.join(scratch, 'disaster-data');
    const disasterExportDir = path.join(scratch, 'disaster-export');
    fs.mkdirSync(disasterDataDir, { recursive: true });
    fs.cpSync(path.join(storeDir, WORKSPACE_SLUG), disasterExportDir, { recursive: true });

    s.restoreRelay = await startRelay(disasterDataDir, {
      TABULA_BACKUP_DIR: disasterExportDir,
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    let client = kit.client(s.restoreRelay, disasterDataDir);
    let owner = await client.signIn(OWNER);
    const backups = (await client.api(owner, 'GET', '/api/admin/backups')).body.backups as { name: string; readable: boolean }[];
    expect(backups[0]).toMatchObject({ name: s.latestManifest, readable: true });
    const restored = await client.api(owner, 'POST', '/api/admin/backups/restore', { manifest: s.latestManifest, confirm: CONFIRM });
    expect(restored.status).toBe(202);
    expect(await s.restoreRelay.exited).toBe(75);
    kit.closeClients();

    s.relay = await startRelay(disasterDataDir, {
      TABULA_BACKUP_DIR: disasterExportDir,
      TABULA_BACKUP_SETTLE_SECONDS: '3600',
      TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    });
    client = kit.client(s.relay, disasterDataDir);
    owner = await client.signIn(OWNER);
    await until(() => boardText(path.join(disasterDataDir, `${BOARD}.yjs`)) === EDIT_TWO, 10_000);
    expect(boardText(path.join(disasterDataDir, `${BOARD}.yjs`))).toBe(EDIT_TWO);
    expect((await client.api(owner, 'GET', '/api/boards')).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: BOARD })]));
  });

  it('[8.3.no-secret] relay logs, puller logs, metrics and state contain no backup or pull credentials', async () => {
    const relayLogs = kit.outputs.map((output) => output.out() + output.err()).join('\n');
    const pullerLogs = s.pullerLogs.join('\n');
    const metrics = fs.readFileSync(metricsFile, 'utf8');
    const state = listFiles(stateDir).map((file) => fs.readFileSync(path.join(stateDir, file), 'utf8')).join('\n');
    const secrets = [
      PULL_MASTER,
      PULL_TOKEN,
      PULL_TOKEN_SHA256,
      ...[BACKUP_KEY].flatMap((key) => [key.toString('hex'), key.toString('base64'), key.toString('base64url')]),
    ];
    for (const [where, value] of Object.entries({ relayLogs, pullerLogs, metrics, state })) {
      for (const secret of secrets) expect(value, `${where} contains a credential`).not.toContain(secret);
    }
  });

  it('[8.3.purge] a deleted workspace expires after grace and an operator purge erases another copy at once', async () => {
    const sourceStore = path.join(storeDir, WORKSPACE_SLUG);
    const operatorSlug = 'manual-copy';
    const operatorStore = path.join(storeDir, operatorSlug);
    fs.cpSync(sourceStore, operatorStore, { recursive: true });
    fs.copyFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`), path.join(stateDir, `${operatorSlug}.json`));
    fs.copyFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.seen.json`), path.join(stateDir, `${operatorSlug}.seen.json`));

    const deletedAt = Date.now();
    const deletedWorkspace = { ...workspace, state: 'deleted' };
    writeWorkspaces([deletedWorkspace], deletedAt);
    s.pullNow = deletedAt;
    const grace = await (pullerMain as (options: any) => Promise<number>)({
      argv: ['--config', pullerConfigFile],
      now: () => s.pullNow,
      fetch: fetchFromRelay,
      log: (line: string) => s.pullerLogs.push(line),
    });
    expect(grace).toBe(0);
    const graceState = JSON.parse(fs.readFileSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`), 'utf8'));
    expect(graceState.deletedSince).toBe(new Date(deletedAt).toISOString());
    expect(fs.readFileSync(metricsFile, 'utf8')).toContain(`tabula_backup_pending_purge{workspace="${WORKSPACE_SLUG}"} 1`);

    const afterGrace = deletedAt + 2 * DAY_MS;
    writeWorkspaces([deletedWorkspace], afterGrace);
    s.pullNow = afterGrace;
    const automatic = await (pullerMain as (options: any) => Promise<number>)({
      argv: ['--config', pullerConfigFile],
      now: () => s.pullNow,
      fetch: fetchFromRelay,
      log: (line: string) => s.pullerLogs.push(line),
    });
    expect(automatic).toBe(0);
    expect(fs.existsSync(sourceStore)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, `${WORKSPACE_SLUG}.json`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, `${WORKSPACE_SLUG}.seen.json`))).toBe(false);

    const operatorLogs: string[] = [];
    const operator = await (pullerMain as (options: any) => Promise<number>)({
      argv: ['--config', pullerConfigFile, '--purge', operatorSlug, '--yes'],
      now: () => s.pullNow,
      log: (line: string) => {
        operatorLogs.push(line);
        s.pullerLogs.push(line);
      },
    });
    expect(operator).toBe(0);
    expect(operatorLogs).toContain(`purged ${operatorSlug} (operator request)`);
    expect(fs.existsSync(operatorStore)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, `${operatorSlug}.json`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, `${operatorSlug}.seen.json`))).toBe(false);
  });
});
