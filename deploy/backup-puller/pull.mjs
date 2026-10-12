import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;
const OBJECT_ID_RE = /^[a-f0-9]{64}$/;
const SLUG_RE = /^[a-z0-9-]{1,63}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;
const SKIP_STATES = new Set(['suspended', 'deleted', 'provisioning']);
const VALID_STATES = new Set(['running', 'stopped', ...SKIP_STATES]);

export class PullerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PullerError';
    this.code = code;
  }
}

function fail(code) {
  throw new PullerError(code);
}

function asMs(now) {
  const value = typeof now === 'function' ? now() : now ?? Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

function asIso(now) {
  const ms = asMs(now);
  if (!Number.isFinite(ms)) fail('invalid_clock');
  return new Date(ms).toISOString();
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) fail('invalid_workspace');
  if (Object.keys(workspace).some((key) => !['id', 'slug', 'state'].includes(key))) fail('invalid_workspace');
  if (typeof workspace.id !== 'string' || !WORKSPACE_ID_RE.test(workspace.id)) fail('invalid_workspace_id');
  if (typeof workspace.slug !== 'string' || !SLUG_RE.test(workspace.slug)) fail('invalid_workspace_slug');
  if (typeof workspace.state !== 'string' || !VALID_STATES.has(workspace.state)) fail('invalid_workspace_state');
  return workspace;
}

export function pullToken(pullMaster, workspaceId) {
  if (typeof pullMaster !== 'string' || pullMaster.length === 0) fail('invalid_pull_master');
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) fail('invalid_workspace_id');
  return crypto.createHmac('sha256', Buffer.from(pullMaster, 'utf8'))
    .update(`tabula-backup-pull/${workspaceId}`, 'utf8')
    .digest('base64url');
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid_config');
  const required = [
    'storeDir', 'stateDir', 'pullMasterFile', 'workspacesFile', 'prefix', 'baseUrlTemplate',
    'concurrency', 'keepDaily', 'keepWeekly', 'objectGraceDays', 'metricsFile', 'requestTimeoutSeconds',
  ];
  const keys = Object.keys(config);
  const optional = ['deletedGraceDays', 'workspacesMaxAgeHours'];
  if (keys.some((key) => ![...required, ...optional].includes(key)) || required.some((key) => !Object.hasOwn(config, key))) fail('invalid_config_fields');
  for (const key of ['storeDir', 'stateDir', 'pullMasterFile', 'workspacesFile', 'metricsFile']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || path.resolve(config[key]) === path.parse(config[key]).root) fail(`invalid_${key}`);
  }
  if (typeof config.prefix !== 'string' || !PREFIX_RE.test(config.prefix)) fail('invalid_prefix');
  if (typeof config.baseUrlTemplate !== 'string' || (config.baseUrlTemplate.match(/\{slug\}/g) ?? []).length !== 1) fail('invalid_base_url_template');
  try {
    const url = new URL(config.baseUrlTemplate.replace('{slug}', 'workspace-placeholder'));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_base_url_template');
  } catch {
    fail('invalid_base_url_template');
  }
  const integer = (key, min, max) => {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) fail(`invalid_${key}`);
  };
  integer('concurrency', 1, 32);
  integer('keepDaily', 0, 3650);
  integer('keepWeekly', 0, 520);
  integer('objectGraceDays', 1, 36500);
  const deletedGraceDays = Object.hasOwn(config, 'deletedGraceDays') ? config.deletedGraceDays : 30;
  if (!Number.isSafeInteger(deletedGraceDays) || deletedGraceDays < 1 || deletedGraceDays > 3650) fail('invalid_deleted_grace_days');
  const workspacesMaxAgeHours = Object.hasOwn(config, 'workspacesMaxAgeHours') ? config.workspacesMaxAgeHours : 48;
  if (!Number.isSafeInteger(workspacesMaxAgeHours) || workspacesMaxAgeHours < 1 || workspacesMaxAgeHours > 8760) fail('invalid_workspaces_max_age_hours');
  integer('requestTimeoutSeconds', 1, 3600);
  return { ...config, deletedGraceDays, workspacesMaxAgeHours };
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) fail('invalid_prefix');
  return prefix;
}

function validateKey(key, expectedPrefix, type) {
  if (typeof key !== 'string' || key.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(key) || key.startsWith('/')) fail('invalid_key');
  const parts = key.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('invalid_key');
  const expected = `${expectedPrefix}/${type}/`;
  if (!key.startsWith(expected)) fail('invalid_key');
  const name = key.slice(expected.length);
  if (!name || name.includes('/')) fail('invalid_key');
  if (type === 'objects' && !OBJECT_ID_RE.test(name)) fail('invalid_key');
  if (type === 'manifests' && parseManifestName(name) === null) fail('invalid_key');
  return key;
}

export function parseManifestName(name) {
  const match = typeof name === 'string' ? MANIFEST_RE.exec(name) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  const formatted = `${date.toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
  return formatted === name ? ms : null;
}

async function ensureDirectoryTree(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const pieces = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const piece of pieces) {
    current = path.join(current, piece);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw new PullerError('filesystem_error');
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw new PullerError('filesystem_error');
      }
      try {
        stat = await fs.promises.lstat(current);
      } catch {
        throw new PullerError('filesystem_error');
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  }
  if (absolute !== root) {
    try {
      await fs.promises.chmod(absolute, 0o700);
    } catch {
      throw new PullerError('filesystem_error');
    }
  }
  return absolute;
}

async function inspectDirectoryTree(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('unsafe_path');
  } catch {
    fail('unsafe_path');
  }
  for (const piece of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (isMissing(error)) return false;
      throw new PullerError('filesystem_error');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  }
  return true;
}

async function safeLstat(file) {
  try {
    return await fs.promises.lstat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new PullerError('filesystem_error');
  }
}

async function safeExistingFile(file) {
  const stat = await safeLstat(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_path');
  return stat;
}

async function atomicWriteFile(file, data, mode = 0o600) {
  const parent = await ensureDirectoryTree(path.dirname(file));
  const target = path.join(parent, path.basename(file));
  await safeExistingFile(target);
  const temp = path.join(parent, `.${path.basename(file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = null;
    await ensureDirectoryTree(parent);
    await safeExistingFile(target);
    await fs.promises.rename(temp, target);
    try {
      const dir = await fs.promises.open(parent, fs.constants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch (error) {
      // Windows cannot open or sync a directory (test runs only; Linux is the host): elsewhere a failed sync is a failure
      if (process.platform !== 'win32') throw error;
    }
  } catch {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw new PullerError('filesystem_error');
  }
}

async function readJsonSafe(file, fallback) {
  if (!(await inspectDirectoryTree(path.dirname(file)))) return fallback;
  const stat = await safeExistingFile(file);
  if (!stat) return fallback;
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    throw new PullerError('invalid_state_file');
  }
}

function safeFailureCode(error) {
  if (error instanceof PullerError && /^[a-z0-9_]{1,64}$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request_timeout';
  return 'request_failed';
}

function emit(log, message) {
  if (typeof log === 'function') log(message);
}

function header(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const key = Object.keys(response?.headers ?? {}).find((value) => value.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : null;
}

function retryAfterMs(response, now) {
  const value = header(response, 'retry-after');
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - asMs(now);
  return Number.isFinite(ms) ? Math.max(0, Math.min(60_000, ms)) : null;
}

async function requestWithRetry({ fetcher, url, token, timeoutMs, now, limits }) {
  const retries = limits.retries ?? 3;
  const sleep = limits.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseBackoffMs = limits.baseBackoffMs ?? 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      const signal = typeof limits.timeoutSignal === 'function'
        ? limits.timeoutSignal(timeoutMs)
        : typeof globalThis.AbortSignal?.timeout === 'function' ? globalThis.AbortSignal.timeout(timeoutMs) : undefined;
      response = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal });
    } catch {
      if (attempt >= retries) throw new PullerError('network_error');
      await sleep(Math.min(60_000, baseBackoffMs * (2 ** attempt)));
      continue;
    }
    if (response.status === 401) throw new PullerError('http_401');
    if (response.status === 404) throw new PullerError('route_disabled');
    if ([429, 502, 503, 504].includes(response.status)) {
      if (attempt >= retries) throw new PullerError(`http_${response.status}`);
      const delay = response.status === 429 ? retryAfterMs(response, now) : null;
      await sleep(delay ?? Math.min(60_000, baseBackoffMs * (2 ** attempt)));
      continue;
    }
    if (!response.ok) throw new PullerError(`http_${response.status}`);
    return response;
  }
  throw new PullerError('request_failed');
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new PullerError('invalid_list_response');
  }
}

async function* bodyChunks(response) {
  const body = response.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.from(chunk);
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        yield Buffer.from(item.value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (typeof response.arrayBuffer === 'function') {
    yield Buffer.from(await response.arrayBuffer());
    return;
  }
  fail('empty_response_body');
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (!result.bytesWritten) fail('filesystem_error');
    offset += result.bytesWritten;
  }
}

async function localFileMatches(workspaceDir, key, size) {
  const file = path.join(workspaceDir, ...key.split('/'));
  if (!(await inspectDirectoryTree(path.dirname(file)))) return false;
  const stat = await safeExistingFile(file);
  return Boolean(stat && stat.size === size);
}

async function downloadAtomic({ workspaceDir, key, expectedSize, response }) {
  const parts = key.split('/');
  const parent = await ensureDirectoryTree(path.join(workspaceDir, ...parts.slice(0, -1)));
  const target = path.join(parent, parts.at(-1));
  await safeExistingFile(target);
  const temp = path.join(parent, `.${parts.at(-1)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  let size = 0;
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600);
    for await (const chunk of bodyChunks(response)) {
      size += chunk.length;
      if (size > expectedSize) fail('size_mismatch');
      await writeAll(handle, chunk);
    }
    if (size !== expectedSize) fail('size_mismatch');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await ensureDirectoryTree(parent);
    await safeExistingFile(target);
    await fs.promises.rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (error instanceof PullerError) throw error;
    throw new PullerError('download_failed');
  }
}

async function safeWalkFiles(directory, relative = '') {
  if (!(await inspectDirectoryTree(directory))) return [];
  const stat = await safeLstat(directory);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') fail('unsafe_path');
    const child = path.join(directory, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const childStat = await fs.promises.lstat(child);
    if (childStat.isSymbolicLink()) fail('unsafe_path');
    if (childStat.isDirectory()) files.push(...await safeWalkFiles(child, rel));
    else if (childStat.isFile()) files.push({ file: child, relative: rel, size: childStat.size });
    else fail('unsafe_path');
  }
  return files;
}

function isoWeekKey(ms) {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function retainedManifestNames(names, nowMs, keepDaily, keepWeekly) {
  const valid = names
    .map((name) => ({ name, at: parseManifestName(name) }))
    .filter((item) => item.at !== null)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const keep = new Set(valid.length ? [valid[0].name] : []);
  const dayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const dailyStart = dayStart - Math.max(0, keepDaily - 1) * 24 * 60 * 60 * 1000;
  const days = new Set();
  for (const item of valid) {
    if (item.at < dailyStart) continue;
    const day = new Date(item.at).toISOString().slice(0, 10);
    if (!days.has(day) && days.size < keepDaily) {
      keep.add(item.name);
      days.add(day);
    }
  }
  const weekCandidates = valid.filter((item) => item.at < dailyStart);
  const weeks = new Set();
  for (const item of weekCandidates) {
    const week = isoWeekKey(item.at);
    if (!weeks.has(week) && weeks.size < keepWeekly) {
      keep.add(item.name);
      weeks.add(week);
    }
  }
  return keep;
}

async function removeKey(workspaceDir, key) {
  const parts = key.split('/');
  const parent = path.join(workspaceDir, ...parts.slice(0, -1));
  if (!(await inspectDirectoryTree(parent))) return false;
  const stat = await safeLstat(path.join(parent, parts.at(-1)));
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_path');
  await fs.promises.unlink(path.join(parent, parts.at(-1)));
  return true;
}

function isStrictlyInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspacePaths(config, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) fail('invalid_workspace_slug');
  const storeRoot = path.resolve(config.storeDir);
  const stateRoot = path.resolve(config.stateDir);
  const storeTarget = path.resolve(storeRoot, slug);
  const stateFile = path.resolve(stateRoot, `${slug}.json`);
  const seenFile = path.resolve(stateRoot, `${slug}.seen.json`);
  if (!isStrictlyInside(storeRoot, storeTarget) || !isStrictlyInside(stateRoot, stateFile) || !isStrictlyInside(stateRoot, seenFile)) fail('unsafe_path');
  if (storeTarget === stateRoot || isStrictlyInside(storeTarget, stateRoot)) fail('unsafe_path');
  return { storeRoot, stateRoot, storeTarget, stateFile, seenFile };
}

async function inspectPurgeTree(directory, root = true) {
  const stat = await safeLstat(directory);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    if (root) fail('unsafe_path');
    return;
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory()) fail('unsafe_path');
  let entries;
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    throw new PullerError('filesystem_error');
  }
  for (const name of entries) await inspectPurgeTree(path.join(directory, name), false);
}

async function removePurgeTree(directory, root = true) {
  const stat = await safeLstat(directory);
  if (!stat) return { removed: false, rootSymlink: false };
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(directory);
    return { removed: true, rootSymlink: root };
  }
  if (stat.isFile()) {
    await fs.promises.unlink(directory);
    return { removed: true, rootSymlink: false };
  }
  if (!stat.isDirectory()) fail('unsafe_path');
  const entries = await fs.promises.readdir(directory);
  for (const name of entries) await removePurgeTree(path.join(directory, name), false);
  await fs.promises.rmdir(directory);
  return { removed: true, rootSymlink: false };
}

async function removeTombstoneTree(directory) {
  let stat = await safeLstat(directory);
  if (!stat) return { removed: false, symlinkRemoved: false };
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(directory);
    return { removed: true, symlinkRemoved: true };
  }
  if (!stat.isDirectory()) fail('unsafe_path');
  try {
    await inspectPurgeTree(directory);
  } catch (error) {
    stat = await safeLstat(directory);
    if (!stat?.isSymbolicLink()) throw error;
    await fs.promises.unlink(directory);
    return { removed: true, symlinkRemoved: true };
  }
  stat = await safeLstat(directory);
  if (!stat) return { removed: false, symlinkRemoved: false };
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(directory);
    return { removed: true, symlinkRemoved: true };
  }
  if (!stat.isDirectory()) fail('unsafe_path');
  const result = await removePurgeTree(directory);
  return { removed: result.removed, symlinkRemoved: result.rootSymlink };
}

async function cleanPurgeLeftovers(storeDir, { dryRun = false, log = () => {} } = {}) {
  const root = path.resolve(storeDir);
  if (!(await inspectDirectoryTree(root))) return { count: 0, failed: false };
  let entries;
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    throw new PullerError('filesystem_error');
  }
  const leftovers = entries.filter((name) => name.startsWith('.purging-')).sort();
  let failed = false;
  for (const name of leftovers) {
    emit(log, `purge leftover ${name}`);
    if (dryRun) continue;
    const directory = path.join(root, name);
    try {
      const result = await removeTombstoneTree(directory);
      if (result.symlinkRemoved) emit(log, `purge leftover symlink removed ${name}; target untouched`);
    } catch (error) {
      failed = true;
      emit(log, `purge leftover cleanup failed ${name} ${safeFailureCode(error)}`);
    }
  }
  return { count: leftovers.length, failed };
}

async function purgeWorkspaceFiles(config, slug, hooks = {}) {
  const paths = workspacePaths(config, slug);
  const storeExists = await inspectDirectoryTree(paths.storeRoot);
  const stateExists = await inspectDirectoryTree(paths.stateRoot);
  let storeStat = null;
  if (storeExists) {
    storeStat = await safeLstat(paths.storeTarget);
    if (storeStat && (storeStat.isSymbolicLink() || !storeStat.isDirectory())) fail('unsafe_path');
    if (storeStat) await inspectPurgeTree(paths.storeTarget);
  }
  const stateStats = [];
  if (stateExists) {
    for (const file of [paths.stateFile, paths.seenFile]) {
      const stat = await safeLstat(file);
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('unsafe_path');
      stateStats.push(stat);
    }
  } else {
    stateStats.push(null, null);
  }
  let removed = false;
  let symlinkRemoved = false;
  if (storeStat) {
    const tombstone = path.join(paths.storeRoot, `.purging-${slug}-${crypto.randomBytes(8).toString('hex')}`);
    await fs.promises.rename(paths.storeTarget, tombstone);
    await hooks.afterTombstoneRename?.({ tombstone, storeTarget: paths.storeTarget });
    const result = await removeTombstoneTree(tombstone);
    removed = result.removed || removed;
    symlinkRemoved = result.symlinkRemoved;
  }
  for (const [index, file] of [paths.stateFile, paths.seenFile].entries()) {
    if (!stateStats[index]) continue;
    await fs.promises.unlink(file);
    removed = true;
  }
  return { ...paths, removed, symlinkRemoved };
}

async function workspaceListAgeSeconds(file, nowMs) {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    return Math.max(0, (nowMs - stat.mtimeMs) / 1000);
  } catch {
    return null;
  }
}

async function readOptionalWorkspaceList(file) {
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    return isMissing(error) ? { status: 'absent' } : { status: 'unknown' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'unknown' };
  try {
    const workspaces = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!Array.isArray(workspaces) || workspaces.length === 0) return { status: 'unknown' };
    const slugs = new Set();
    const ids = new Set();
    for (const workspace of workspaces) {
      validateWorkspace(workspace);
      if (slugs.has(workspace.slug) || ids.has(workspace.id)) return { status: 'unknown' };
      slugs.add(workspace.slug);
      ids.add(workspace.id);
    }
    return { status: 'valid', workspaces };
  } catch {
    return { status: 'unknown' };
  }
}

async function readPurgedState(stateDir) {
  const saved = await readJsonSafe(path.join(stateDir, 'purged.json'), { count: 0 });
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Number.isSafeInteger(saved.count) || saved.count < 0) fail('invalid_purged_file');
  const slugs = saved.slugs ?? [];
  if (!Array.isArray(slugs) || slugs.some((slug) => typeof slug !== 'string' || !SLUG_RE.test(slug))) fail('invalid_purged_file');
  return { count: saved.count, slugs: [...new Set(slugs)].sort() };
}

async function writePurgedState(stateDir, { count, slugs }) {
  if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(slugs) || slugs.some((slug) => !SLUG_RE.test(slug))) fail('invalid_purged_file');
  await atomicWriteFile(path.join(stateDir, 'purged.json'), `${JSON.stringify({ count, slugs: [...new Set(slugs)].sort() }, null, 2)}\n`);
}

async function scanOrphanWorkspaces(storeDir, listedSlugs) {
  const root = path.resolve(storeDir);
  if (!(await inspectDirectoryTree(root))) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    throw new PullerError('filesystem_error');
  }
  const orphans = [];
  for (const slug of entries) {
    if (slug.startsWith('.purging-') || !SLUG_RE.test(slug) || listedSlugs.has(slug)) continue;
    const stat = await safeLstat(path.join(root, slug));
    if (stat?.isDirectory() && !stat.isSymbolicLink()) orphans.push(slug);
  }
  return orphans.sort();
}

export async function retention({
  workspaceDir,
  stateDir,
  slug,
  prefix = 'tabula',
  now = Date.now,
  keepDaily = 7,
  keepWeekly = 4,
  objectGraceDays = 35,
  listedObjects = [],
  completeListing = true,
  failed = false,
  dryRun = false,
  log = () => {},
}) {
  validatePrefix(prefix);
  if (failed || !completeListing) return { deleted: [], keptManifests: [] };
  const nowMs = asMs(now);
  const base = path.resolve(workspaceDir);
  await inspectDirectoryTree(base);
  const manifestDir = path.join(base, ...`${prefix}/manifests`.split('/'));
  const manifestFiles = await safeWalkFiles(manifestDir);
  const manifests = manifestFiles.filter((item) => !item.relative.includes('/') && parseManifestName(item.relative) !== null);
  const keep = retainedManifestNames(manifests.map((item) => item.relative), nowMs, keepDaily, keepWeekly);
  const deleted = [];
  for (const item of manifests) {
    if (keep.has(item.relative)) continue;
    const key = `${prefix}/manifests/${item.relative}`;
    deleted.push(key);
    if (dryRun) emit(log, `would delete ${slug ?? ''} ${key}`.trim());
    else await removeKey(base, key);
  }

  const seenFile = stateDir && slug ? path.join(stateDir, `${slug}.seen.json`) : null;
  const savedSeen = seenFile ? await readJsonSafe(seenFile, { lastSeen: {} }) : { lastSeen: {} };
  if (!savedSeen || typeof savedSeen !== 'object' || Array.isArray(savedSeen) || !savedSeen.lastSeen || typeof savedSeen.lastSeen !== 'object' || Array.isArray(savedSeen.lastSeen)) fail('invalid_seen_file');
  const lastSeen = { ...savedSeen.lastSeen };
  for (const item of listedObjects) {
    validateKey(item.key, prefix, 'objects');
    lastSeen[item.key] = new Date(nowMs).toISOString();
  }
  const current = new Set(listedObjects.map((item) => item.key));
  const objectDir = path.join(base, ...`${prefix}/objects`.split('/'));
  const objectFiles = await safeWalkFiles(objectDir);
  const graceMs = objectGraceDays * 24 * 60 * 60 * 1000;
  for (const item of objectFiles) {
    if (/^\..+\.tmp-[a-f0-9]{16}$/.test(item.relative)) continue;
    if (item.relative.includes('/') || !OBJECT_ID_RE.test(item.relative)) fail('invalid_key');
    const key = `${prefix}/objects/${item.relative}`;
    if (current.has(key)) continue;
    const lastSeenAt = Date.parse(lastSeen[key] ?? '');
    if (!Number.isFinite(lastSeenAt) || nowMs - lastSeenAt < graceMs) continue;
    deleted.push(key);
    if (dryRun) emit(log, `would delete ${slug ?? ''} ${key}`.trim());
    else {
      await removeKey(base, key);
      delete lastSeen[key];
    }
  }
  if (seenFile && !dryRun) await atomicWriteFile(seenFile, `${JSON.stringify({ lastSeen }, null, 2)}\n`);
  return { deleted, keptManifests: [...keep].sort() };
}

async function listStoredFiles(workspaceDir, prefix) {
  const root = path.join(workspaceDir, ...prefix.split('/'));
  const files = await safeWalkFiles(root);
  return { files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0) };
}

function initialState(workspace) {
  return {
    workspaceId: workspace.id,
    deletedSince: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    files: 0,
    bytes: 0,
    newFiles: 0,
    newBytes: 0,
    lastManifest: null,
  };
}

function normalizeWorkspaceState(workspace, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_state_file');
  const state = { ...initialState(workspace), ...value, workspaceId: workspace.id };
  if (state.deletedSince === undefined || state.deletedSince === null) state.deletedSince = null;
  else if (typeof state.deletedSince !== 'string' || !Number.isFinite(Date.parse(state.deletedSince))) fail('invalid_state_file');
  return state;
}

async function readWorkspaceState(stateDir, workspace) {
  const saved = await readJsonSafe(path.join(stateDir, `${workspace.slug}.json`), initialState(workspace));
  return normalizeWorkspaceState(workspace, saved);
}

export async function pullWorkspace({ workspace, baseUrl, token, storeDir, stateDir, fetch: fetcher = globalThis.fetch, now = Date.now, log = () => {}, limits = {} }) {
  validateWorkspace(workspace);
  if (typeof baseUrl !== 'string' || typeof token !== 'string' || !token || typeof fetcher !== 'function') fail('invalid_pull_options');
  const prefix = validatePrefix(limits.prefix ?? 'tabula');
  const root = path.resolve(storeDir);
  const stateRoot = stateDir ? path.resolve(stateDir) : null;
  const workspaceDir = path.join(root, workspace.slug);
  const stateFile = stateRoot ? path.join(stateRoot, `${workspace.slug}.json`) : null;
  const existing = stateFile ? await readJsonSafe(stateFile, initialState(workspace)) : initialState(workspace);
  const state = normalizeWorkspaceState(workspace, existing);
  state.deletedSince = null;
  const attemptedAt = asIso(now);
  state.lastAttemptAt = attemptedAt;
  state.lastError = null;
  state.newFiles = 0;
  state.newBytes = 0;
  const dryRun = limits.dryRun === true;
  if (!dryRun && stateFile) await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const timeoutMs = (limits.requestTimeoutSeconds ?? 120) * 1000;
  let firstRequest = true;
  const retryFetch = async (url) => {
    const firstTimeout = firstRequest && workspace.state === 'stopped' ? 60_000 : timeoutMs;
    const response = await requestWithRetry({ fetcher, url, token, timeoutMs: firstTimeout, now, limits });
    firstRequest = false;
    return response;
  };
  let downloadedCount = 0;
  let downloadedBytes = 0;
  try {
    if (dryRun) await inspectDirectoryTree(workspaceDir);
    else {
      await ensureDirectoryTree(root);
      await ensureDirectoryTree(workspaceDir);
    }
    const routeList = async (kind) => {
      const fullPrefix = `${prefix}/${kind}/`;
      const results = [];
      const seen = new Set();
      let after = null;
      for (let page = 0; page < 100_000; page++) {
        const url = new URL('/api/backup-export/list', baseUrl);
        url.searchParams.set('prefix', fullPrefix);
        url.searchParams.set('limit', '1000');
        if (after !== null) url.searchParams.set('after', after);
        const response = await retryFetch(url);
        const body = await responseJson(response);
        if (!body || !Array.isArray(body.keys) || body.keys.length > 1000 || !(body.next === null || typeof body.next === 'string')) fail('invalid_list_response');
        let prior = null;
        for (const item of body.keys) {
          if (!item || typeof item !== 'object') fail('invalid_list_response');
          const key = validateKey(item.key, prefix, kind);
          if (!Number.isSafeInteger(item.size) || item.size < 0 || (prior !== null && key <= prior) || (after !== null && key <= after) || seen.has(key)) fail('invalid_list_response');
          prior = key;
          seen.add(key);
          results.push({ key, size: item.size, lastModified: item.lastModified ?? null });
        }
        if (body.next === null) return results;
        if (typeof body.next !== 'string' || body.next.length > 512 || body.next !== prior || (after !== null && body.next <= after)) fail('invalid_list_response');
        after = body.next;
      }
      throw new PullerError('too_many_list_pages');
    };
    const objects = await routeList('objects');
    const manifests = await routeList('manifests');
    const seenFile = stateRoot ? path.join(stateRoot, `${workspace.slug}.seen.json`) : null;
    if (seenFile && !dryRun) {
      const savedSeen = await readJsonSafe(seenFile, { lastSeen: {} });
      if (!savedSeen || typeof savedSeen !== 'object' || !savedSeen.lastSeen || typeof savedSeen.lastSeen !== 'object' || Array.isArray(savedSeen.lastSeen)) fail('invalid_seen_file');
      const lastSeen = { ...savedSeen.lastSeen };
      const listedAt = asIso(now);
      for (const item of objects) lastSeen[item.key] = listedAt;
      await atomicWriteFile(seenFile, `${JSON.stringify({ lastSeen }, null, 2)}\n`);
    }
    const toPull = [...objects, ...manifests];
    for (const item of toPull) {
      const matches = await localFileMatches(workspaceDir, item.key, item.size);
      if (matches) continue;
      if (dryRun) {
        emit(log, `would fetch ${workspace.slug} ${item.key}`);
        continue;
      }
      const url = new URL('/api/backup-export/object', baseUrl);
      url.searchParams.set('key', item.key);
      emit(log, `fetch ${workspace.slug} ${item.key}`);
      const response = await retryFetch(url);
      await downloadAtomic({ workspaceDir, key: item.key, expectedSize: item.size, response });
      downloadedCount++;
      downloadedBytes += item.size;
      state.newFiles = downloadedCount;
      state.newBytes = downloadedBytes;
    }
    const newestManifest = manifests
      .map((item) => item.key.slice(`${prefix}/manifests/`.length))
      .filter((name) => parseManifestName(name) !== null)
      .sort((a, b) => parseManifestName(b) - parseManifestName(a))[0] ?? null;
    if (!dryRun) {
      await retention({
        workspaceDir,
        stateDir: stateRoot,
        slug: workspace.slug,
        prefix,
        now,
        keepDaily: limits.keepDaily ?? 7,
        keepWeekly: limits.keepWeekly ?? 4,
        objectGraceDays: limits.objectGraceDays ?? 35,
        listedObjects: objects,
        completeListing: true,
        failed: false,
        log,
      });
      const totals = await listStoredFiles(workspaceDir, prefix);
      state.files = totals.files;
      state.bytes = totals.bytes;
      state.lastSuccessAt = asIso(now);
      state.lastError = null;
      state.lastManifest = newestManifest;
      await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } else {
      await retention({
        workspaceDir,
        stateDir: stateRoot,
        slug: workspace.slug,
        prefix,
        now,
        keepDaily: limits.keepDaily ?? 7,
        keepWeekly: limits.keepWeekly ?? 4,
        objectGraceDays: limits.objectGraceDays ?? 35,
        listedObjects: objects,
        completeListing: true,
        failed: false,
        dryRun: true,
        log,
      });
    }
    return { ok: true, skipped: false, state: { ...state }, downloadedFiles: downloadedCount, downloadedBytes };
  } catch (error) {
    const code = safeFailureCode(error);
    state.lastError = code;
    state.newFiles = downloadedCount;
    state.newBytes = downloadedBytes;
    if (!dryRun) {
      try {
        const totals = await listStoredFiles(workspaceDir, prefix);
        state.files = totals.files;
        state.bytes = totals.bytes;
      } catch {
        // Keep the last known totals when the store path itself is unsafe or unavailable.
      }
    }
    emit(log, `failed ${workspace.slug} ${code}`);
    if (!dryRun && stateFile) {
      try {
        await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      } catch {
        // A broken state path must not turn the error into a message that could reveal request details.
      }
    }
    return { ok: false, skipped: false, state: { ...state }, error: code, downloadedFiles: downloadedCount, downloadedBytes };
  }
}

function metricNumber(value, nowMs, absent = 0) {
  if (value === null || value === undefined) return absent;
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) ? number : absent;
}

function metricSeconds(value, nowMs, absent = 0) {
  return value === null || value === undefined ? absent : Math.floor(metricNumber(value, nowMs, absent) / 1000);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export async function writeMetrics({
  metricsFile,
  workspaces,
  states = {},
  results = {},
  now = Date.now,
  lastRunAt = now,
  pendingPurgeSlugs = [],
  purgedTotal = 0,
  orphanWorkspaceCount = 0,
  configuredWorkspaceCount = workspaces.length,
  workspaceListAge = 1e12,
  purgeLeftovers = 0,
}) {
  const nowMs = asMs(now);
  const lastRunSeconds = Math.floor(asMs(lastRunAt) / 1000);
  const metricDefs = [
    ['tabula_backup_age_seconds', 'Seconds since the last successful backup pull.', 'gauge'],
    ['tabula_backup_last_attempt_timestamp_seconds', 'Unix timestamp of the last backup pull attempt.', 'gauge'],
    ['tabula_backup_last_success_timestamp_seconds', 'Unix timestamp of the last successful backup pull.', 'gauge'],
    ['tabula_backup_stored_bytes', 'Bytes stored locally for the workspace.', 'gauge'],
    ['tabula_backup_files', 'Files stored locally for the workspace.', 'gauge'],
    ['tabula_backup_has_manifest', 'Whether a manifest has been pulled for the workspace.', 'gauge'],
    ['tabula_backup_last_run_ok', 'Whether the last backup pull run succeeded or was intentionally skipped.', 'gauge'],
    ['tabula_backup_pending_purge', 'Whether a deleted workspace is still inside its purge grace period.', 'gauge'],
  ];
  const lines = [];
  for (const [name, help, type] of metricDefs) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const workspace of workspaces) {
    const state = states[workspace.slug] ?? initialState(workspace);
    const label = `workspace="${escapeLabel(workspace.slug)}"`;
    const success = metricNumber(state.lastSuccessAt, nowMs, NaN);
    const age = Number.isFinite(success) ? Math.max(0, (nowMs - success) / 1000) : 1e12;
    const result = results[workspace.slug];
    const ok = result?.skipped || result?.ok === true ? 1 : result ? 0 : 1;
    lines.push(`tabula_backup_age_seconds{${label}} ${Number.isFinite(age) ? age : 1e12}`);
    lines.push(`tabula_backup_last_attempt_timestamp_seconds{${label}} ${metricSeconds(state.lastAttemptAt, nowMs)}`);
    lines.push(`tabula_backup_last_success_timestamp_seconds{${label}} ${metricSeconds(state.lastSuccessAt, nowMs)}`);
    lines.push(`tabula_backup_stored_bytes{${label}} ${Number.isSafeInteger(state.bytes) && state.bytes >= 0 ? state.bytes : 0}`);
    lines.push(`tabula_backup_files{${label}} ${Number.isSafeInteger(state.files) && state.files >= 0 ? state.files : 0}`);
    lines.push(`tabula_backup_has_manifest{${label}} ${state.lastManifest ? 1 : 0}`);
    lines.push(`tabula_backup_last_run_ok{${label}} ${ok}`);
  }
  for (const slug of [...new Set(pendingPurgeSlugs)].sort()) {
    lines.push(`tabula_backup_pending_purge{workspace="${escapeLabel(slug)}"} 1`);
  }
  lines.push(
    '# HELP tabula_backup_purged_total Number of workspace copies purged by this pull host.',
    '# TYPE tabula_backup_purged_total counter',
    `tabula_backup_purged_total ${Number.isSafeInteger(purgedTotal) && purgedTotal >= 0 ? purgedTotal : 0}`,
    '# HELP tabula_backup_workspace_list_age_seconds Age of the workspace list file in seconds.',
    '# TYPE tabula_backup_workspace_list_age_seconds gauge',
    `tabula_backup_workspace_list_age_seconds ${Number.isFinite(workspaceListAge) && workspaceListAge >= 0 ? workspaceListAge : 1e12}`,
    '# HELP tabula_backup_purge_leftovers Number of interrupted purge tombstones found at run start.',
    '# TYPE tabula_backup_purge_leftovers gauge',
    `tabula_backup_purge_leftovers ${Number.isSafeInteger(purgeLeftovers) && purgeLeftovers >= 0 ? purgeLeftovers : 0}`,
    '# HELP tabula_backup_orphan_workspaces Number of store directories missing from workspaces.json.',
    '# TYPE tabula_backup_orphan_workspaces gauge',
    `tabula_backup_orphan_workspaces ${Number.isSafeInteger(orphanWorkspaceCount) && orphanWorkspaceCount >= 0 ? orphanWorkspaceCount : 0}`,
    '# HELP tabula_backup_puller_last_run_timestamp_seconds Unix timestamp of the last puller run.',
    '# TYPE tabula_backup_puller_last_run_timestamp_seconds gauge',
    `tabula_backup_puller_last_run_timestamp_seconds ${lastRunSeconds}`,
    '# HELP tabula_backup_workspaces_total Number of configured workspaces.',
    '# TYPE tabula_backup_workspaces_total gauge',
    `tabula_backup_workspaces_total ${Number.isSafeInteger(configuredWorkspaceCount) && configuredWorkspaceCount >= 0 ? configuredWorkspaceCount : workspaces.length}`,
  );
  await atomicWriteFile(metricsFile, `${lines.join('\n')}\n`);
  return `${lines.join('\n')}\n`;
}

async function updateGlobalMetrics(metricsFile, values) {
  const parent = path.dirname(metricsFile);
  let current = '';
  if (await inspectDirectoryTree(parent)) {
    await safeExistingFile(metricsFile);
    try {
      current = await fs.promises.readFile(metricsFile, 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw new PullerError('filesystem_error');
    }
  }
  const definitions = {
    tabula_backup_purged_total: ['Number of workspace copies purged by this pull host.', 'counter'],
    tabula_backup_workspace_list_age_seconds: ['Age of the workspace list file in seconds.', 'gauge'],
    tabula_backup_purge_leftovers: ['Number of interrupted purge tombstones found at run start.', 'gauge'],
  };
  const lines = current.split('\n').filter((line) => !Object.keys(values).some((name) => line.startsWith(`# HELP ${name} `)
    || line.startsWith(`# TYPE ${name} `) || line.startsWith(`${name} `) || line.startsWith(`${name}{`)));
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const [name, value] of Object.entries(values)) {
    const [help, type] = definitions[name] ?? fail('invalid_metric');
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  }
  await atomicWriteFile(metricsFile, `${lines.join('\n')}\n`);
}

async function readMasterFile(file) {
  if (!(await inspectDirectoryTree(path.dirname(file)))) throw new PullerError('pull_master_unavailable');
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch {
    throw new PullerError('pull_master_unavailable');
  }
  // The puller runs on the Linux host; Windows reports every file as 0666, so the mode check is skipped there (test runs only).
  if (stat.isSymbolicLink() || !stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) throw new PullerError('unsafe_pull_master_file');
  let master;
  try {
    master = await fs.promises.readFile(file, 'utf8');
  } catch {
    throw new PullerError('pull_master_unavailable');
  }
  master = master.replace(/\r?\n$/, '');
  if (!master) throw new PullerError('empty_pull_master');
  return master;
}

function parseArguments(argv) {
  const args = { config: null, only: null, dryRun: false, purge: null, yes: false, force: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--config' && argv[index + 1]) args.config = argv[++index];
    else if (arg === '--only' && argv[index + 1]) args.only = argv[++index];
    else if (arg === '--purge' && argv[index + 1]) args.purge = argv[++index];
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else fail('invalid_arguments');
  }
  if (!args.config || (args.only !== null && !SLUG_RE.test(args.only)) || (args.purge !== null && !SLUG_RE.test(args.purge))
    || (args.yes && args.purge === null) || (args.force && args.purge === null) || (args.purge !== null && (args.only !== null || args.dryRun))) fail('invalid_arguments');
  return args;
}

async function runPool(items, concurrency, task) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        results[index] = { ok: false, skipped: false, error: safeFailureCode(error), state: initialState(items[index]) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function main({ argv = [], env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now, log = (line) => process.stdout.write(`${line}\n`), purgeHooks = {} } = {}) {
  void env;
  let args;
  let config;
  let master;
  let workspaces;
  let purgedState;
  let runAt;
  let workspaceListAge = 1e12;
  let workspaceListAgeKnown = false;
  let workspaceListStale = false;
  let purgeLeftovers = 0;
  let recoveryFailed = false;
  try {
    args = parseArguments(argv);
    let raw;
    try {
      raw = JSON.parse(await fs.promises.readFile(args.config, 'utf8'));
    } catch {
      throw new PullerError('invalid_config_file');
    }
    config = validateConfig(raw);
    runAt = asIso(now);
    const readOnly = args.dryRun || (args.purge !== null && !args.yes);
    const leftovers = await cleanPurgeLeftovers(config.storeDir, { dryRun: readOnly, log });
    purgeLeftovers = leftovers.count;
    recoveryFailed = leftovers.failed;
    const listAge = await workspaceListAgeSeconds(config.workspacesFile, Date.parse(runAt));
    workspaceListAgeKnown = listAge !== null;
    workspaceListAge = listAge ?? 1e12;
    if (!readOnly) {
      try {
        await updateGlobalMetrics(config.metricsFile, {
          tabula_backup_workspace_list_age_seconds: workspaceListAge,
          tabula_backup_purge_leftovers: purgeLeftovers,
        });
      } catch {
        emit(log, 'metrics write failed');
      }
    }
    if (args.purge !== null) {
      const paths = workspacePaths(config, args.purge);
      if (!args.yes) {
        emit(log, `would remove ${paths.storeTarget}`);
        emit(log, `would remove ${paths.stateFile}`);
        emit(log, `would remove ${paths.seenFile}`);
        return 2;
      }
      purgedState = await readPurgedState(config.stateDir);
      const operatorWorkspaceList = await readOptionalWorkspaceList(config.workspacesFile);
      if (operatorWorkspaceList.status === 'unknown' && !args.force) {
        emit(log, `purge refused ${args.purge}: workspace list is invalid or unreadable; pass --force to purge`);
        try {
          await updateGlobalMetrics(config.metricsFile, {
            tabula_backup_purged_total: purgedState.count,
            tabula_backup_workspace_list_age_seconds: workspaceListAge,
            tabula_backup_purge_leftovers: purgeLeftovers,
          });
        } catch {
          emit(log, 'metrics write failed');
        }
        return 2;
      }
      if (operatorWorkspaceList.status === 'valid') {
        workspaceListStale = !workspaceListAgeKnown || workspaceListAge > config.workspacesMaxAgeHours * 60 * 60;
        if (workspaceListStale && !args.force) {
          emit(log, `purge refused ${args.purge}: workspace list is stale; pass --force to purge`);
          try {
            await updateGlobalMetrics(config.metricsFile, {
              tabula_backup_purged_total: purgedState.count,
              tabula_backup_workspace_list_age_seconds: workspaceListAge,
              tabula_backup_purge_leftovers: purgeLeftovers,
            });
          } catch {
            emit(log, 'metrics write failed');
          }
          return 2;
        }
        const listed = operatorWorkspaceList.workspaces.find((workspace) => workspace.slug === args.purge);
        if (listed && listed.state !== 'deleted' && !args.force) {
          emit(log, `purge refused ${args.purge}: listed workspace state is ${listed.state}; pass --force to purge`);
          try {
            await updateGlobalMetrics(config.metricsFile, {
              tabula_backup_purged_total: purgedState.count,
              tabula_backup_workspace_list_age_seconds: workspaceListAge,
              tabula_backup_purge_leftovers: purgeLeftovers,
            });
          } catch {
            emit(log, 'metrics write failed');
          }
          return 2;
        }
      }
      try {
        const result = await purgeWorkspaceFiles(config, args.purge, purgeHooks);
        const purgedSlugs = new Set(purgedState.slugs);
        purgedSlugs.add(args.purge);
        const nextPurgedTotal = purgedState.count + (result.removed ? 1 : 0);
        await writePurgedState(config.stateDir, { count: nextPurgedTotal, slugs: [...purgedSlugs] });
        if (result.symlinkRemoved) emit(log, `purge symlink removed for ${args.purge}; target untouched`);
        try {
          await updateGlobalMetrics(config.metricsFile, {
            tabula_backup_purged_total: nextPurgedTotal,
            tabula_backup_workspace_list_age_seconds: workspaceListAge,
            tabula_backup_purge_leftovers: purgeLeftovers,
          });
        } catch {
          emit(log, 'metrics write failed');
        }
        if (result.removed) {
          emit(log, `purged ${args.purge} (operator request)`);
        } else {
          emit(log, `nothing to remove for ${args.purge}`);
        }
        return 0;
      } catch (error) {
        emit(log, `purge failed ${args.purge} ${safeFailureCode(error)}`);
        return 1;
      }
    }
    try {
      workspaces = JSON.parse(await fs.promises.readFile(config.workspacesFile, 'utf8'));
    } catch {
      throw new PullerError('invalid_workspaces_file');
    }
    if (!Array.isArray(workspaces) || workspaces.length === 0) throw new PullerError('invalid_workspaces_file');
    const slugs = new Set();
    const ids = new Set();
    for (const workspace of workspaces) {
      validateWorkspace(workspace);
      if (slugs.has(workspace.slug) || ids.has(workspace.id)) throw new PullerError('duplicate_workspace');
      slugs.add(workspace.slug);
      ids.add(workspace.id);
    }
    workspaceListStale = !workspaceListAgeKnown || workspaceListAge > config.workspacesMaxAgeHours * 60 * 60;
    purgedState = await readPurgedState(config.stateDir);
    master = await readMasterFile(config.pullMasterFile);
  } catch (error) {
    emit(log, `configuration error ${safeFailureCode(error)}`);
    return 2;
  }
  if (typeof fetcher !== 'function') {
    emit(log, 'configuration error invalid_fetch');
    return 2;
  }
  const runAtMs = Date.parse(runAt);
  const states = {};
  const results = {};
  const pendingPurgeSlugs = [];
  const purgedSlugs = new Set();
  const previouslyPurgedSlugs = new Set(purgedState.slugs);
  let purgedTotal = purgedState.count;
  let hadFailure = workspaceListStale || recoveryFailed;
  if (workspaceListStale) emit(log, 'purge skipped stale list');
  let orphanSlugs;
  try {
    orphanSlugs = await scanOrphanWorkspaces(config.storeDir, new Set(workspaces.map((item) => item.slug)));
  } catch (error) {
    emit(log, `configuration error ${safeFailureCode(error)}`);
    return 2;
  }
  for (const slug of orphanSlugs) emit(log, `orphan ${slug}`);

  const pullWorkspaces = [];
  for (const workspace of workspaces) {
    try {
      if (workspace.state === 'deleted' && previouslyPurgedSlugs.has(workspace.slug)) {
        purgedSlugs.add(workspace.slug);
        continue;
      }
      if (workspace.state !== 'deleted' && previouslyPurgedSlugs.delete(workspace.slug)) {
        if (!args.dryRun) await writePurgedState(config.stateDir, { count: purgedTotal, slugs: [...previouslyPurgedSlugs] });
      }
      const state = await readWorkspaceState(config.stateDir, workspace);
      if (workspace.state === 'deleted') {
        const deletedSince = state.deletedSince ?? runAt;
        const deletedSinceMs = Date.parse(deletedSince);
        const elapsedMs = Math.max(0, runAtMs - deletedSinceMs);
        const deletedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
        if (args.dryRun) {
          if (elapsedMs >= config.deletedGraceDays * 24 * 60 * 60 * 1000) {
            emit(log, `would purge ${workspace.slug} (deleted ${deletedDays} days ago)`);
          } else if (state.deletedSince === null) {
            emit(log, `would start deleted grace for ${workspace.slug}`);
            pendingPurgeSlugs.push(workspace.slug);
            states[workspace.slug] = { ...state, deletedSince: runAt };
          } else {
            emit(log, `skipped ${workspace.slug} deleted`);
            pendingPurgeSlugs.push(workspace.slug);
            states[workspace.slug] = state;
          }
          results[workspace.slug] = { ok: true, skipped: true, state: states[workspace.slug] ?? state };
          continue;
        }
        if (state.deletedSince === null) {
          state.deletedSince = runAt;
          await atomicWriteFile(path.join(config.stateDir, `${workspace.slug}.json`), `${JSON.stringify(state, null, 2)}\n`);
        }
        if (elapsedMs >= config.deletedGraceDays * 24 * 60 * 60 * 1000) {
          if (workspaceListStale) {
            pendingPurgeSlugs.push(workspace.slug);
            states[workspace.slug] = state;
            results[workspace.slug] = { ok: true, skipped: true, state };
            continue;
          }
          const purged = await purgeWorkspaceFiles(config, workspace.slug, purgeHooks);
          if (purged.removed) purgedTotal++;
          previouslyPurgedSlugs.add(workspace.slug);
          await writePurgedState(config.stateDir, { count: purgedTotal, slugs: [...previouslyPurgedSlugs] });
          purgedSlugs.add(workspace.slug);
          if (purged.symlinkRemoved) emit(log, `purge symlink removed for ${workspace.slug}; target untouched`);
          emit(log, `purged ${workspace.slug} (deleted ${deletedDays} days ago)`);
          continue;
        }
        pendingPurgeSlugs.push(workspace.slug);
        states[workspace.slug] = state;
        results[workspace.slug] = { ok: true, skipped: true, state };
        emit(log, `skipped ${workspace.slug} deleted`);
        continue;
      }

      if (state.deletedSince !== null) {
        state.deletedSince = null;
        if (!args.dryRun) await atomicWriteFile(path.join(config.stateDir, `${workspace.slug}.json`), `${JSON.stringify(state, null, 2)}\n`);
      }
      states[workspace.slug] = state;
      if (SKIP_STATES.has(workspace.state)) {
        if (!args.dryRun) await atomicWriteFile(path.join(config.stateDir, `${workspace.slug}.json`), `${JSON.stringify(state, null, 2)}\n`);
        results[workspace.slug] = { ok: true, skipped: true, state };
        emit(log, `skipped ${workspace.slug} ${workspace.state}`);
      } else if (!args.only || workspace.slug === args.only) {
        pullWorkspaces.push(workspace);
      }
    } catch (error) {
      const code = safeFailureCode(error);
      hadFailure = true;
      states[workspace.slug] = initialState(workspace);
      results[workspace.slug] = { ok: false, skipped: false, error: code, state: states[workspace.slug] };
      emit(log, `failed ${workspace.slug} ${code}`);
    }
  }

  const completed = await runPool(pullWorkspaces, config.concurrency, async (workspace) => {
    const baseUrl = config.baseUrlTemplate.replace('{slug}', workspace.slug);
    const token = pullToken(master, workspace.id);
    return pullWorkspace({
      workspace,
      baseUrl,
      token,
      storeDir: config.storeDir,
      stateDir: config.stateDir,
      fetch: fetcher,
      now,
      log,
      limits: {
        prefix: config.prefix,
        requestTimeoutSeconds: config.requestTimeoutSeconds,
        keepDaily: config.keepDaily,
        keepWeekly: config.keepWeekly,
        objectGraceDays: config.objectGraceDays,
        dryRun: args.dryRun,
      },
    });
  });
  for (let index = 0; index < pullWorkspaces.length; index++) {
    const workspace = pullWorkspaces[index];
    const result = completed[index];
    states[workspace.slug] = result.state;
    results[workspace.slug] = result;
    if (!result.ok) {
      hadFailure = true;
      emit(log, `failed ${workspace.slug} ${result.error}`);
    }
  }

  const metricWorkspaces = workspaces.filter((workspace) => !purgedSlugs.has(workspace.slug));
  if (!args.dryRun) {
    try {
      await writeMetrics({
        metricsFile: config.metricsFile,
        workspaces: metricWorkspaces,
        states,
        results,
        now,
        lastRunAt: runAt,
        pendingPurgeSlugs,
        purgedTotal,
        orphanWorkspaceCount: orphanSlugs.length,
        configuredWorkspaceCount: workspaces.length,
        workspaceListAge,
        purgeLeftovers,
      });
    } catch {
      emit(log, 'metrics write failed');
    }
  }
  return hadFailure ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 2;
  });
}
