#!/usr/bin/env node
// Usage: node scripts/worktree-audit.mjs [--json] [--root <project-root>] [--main <ref>] [--no-size]
// Read-only inventory of Git worktrees; it never prunes, removes, checks out, or changes a worktree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STALE_AFTER_HOURS = 24;
const DEFAULT_MAIN = 'origin/main';

export const USAGE = [
  'Usage: node scripts/worktree-audit.mjs [--json] [--root <project-root>] [--main <ref>] [--no-size]',
  '',
  '  --json          print a JSON report',
  '  --root <dir>    project root containing tabula/ and optional proto/ (default: discovered from this checkout)',
  '  --main <ref>    commit or ref used to calculate merged/ahead state (default: origin/main)',
  '  --no-size       skip directory size scans',
].join('\n');

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env },
  });
}

function discoverProjectRoot() {
  const commonDir = git(SCRIPT_DIR, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const repoRoot = path.dirname(commonDir);
  const parent = path.dirname(repoRoot);
  if (path.basename(repoRoot).toLowerCase() === 'tabula'
    && (fs.existsSync(path.join(parent, 'proto')) || fs.existsSync(path.join(parent, 'wt')))) {
    return parent;
  }
  return repoRoot;
}

/** @param {string[]} argv @param {string} defaultRoot */
export function parseArgs(argv, defaultRoot = path.resolve(SCRIPT_DIR, '../..')) {
  const opts = { json: false, root: path.resolve(defaultRoot), main: DEFAULT_MAIN, includeSize: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--no-size') {
      opts.includeSize = false;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--root' || arg === '--main') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(arg + ' needs a value');
      if (arg === '--root') opts.root = path.resolve(value);
      else opts.main = value;
    } else {
      throw new Error('unknown option ' + arg);
    }
  }
  return opts;
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function findRepoRoot(projectRoot) {
  const root = path.resolve(projectRoot);
  if (!isDirectory(root)) throw new Error(root + ': project root is not a directory');
  const nestedRepo = path.join(root, 'tabula');
  if (fs.existsSync(path.join(nestedRepo, '.git'))) return nestedRepo;
  if (fs.existsSync(path.join(root, '.git'))) return root;
  throw new Error(root + ': could not find a Git repository at tabula/ or the supplied root');
}

function parseWorktrees(output) {
  const fields = new Map();
  const records = [];
  const finish = () => {
    if (!fields.has('worktree')) return;
    records.push({
      path: fields.get('worktree'),
      head: fields.get('HEAD') ?? null,
      branchRef: fields.get('branch') ?? null,
      detached: fields.has('detached'),
      prunable: fields.has('prunable'),
      locked: fields.has('locked'),
      lockedReason: fields.get('locked') ?? null,
      prunableReason: fields.get('prunable') ?? null,
      bare: fields.has('bare'),
    });
    fields.clear();
  };
  for (const field of output.split('\0')) {
    if (!field) {
      finish();
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    fields.set(key, value);
  }
  finish();
  return records;
}

function readPrototypeRegister(projectRoot) {
  const registerPath = path.join(projectRoot, 'proto', 'README.md');
  let source;
  try {
    source = fs.readFileSync(registerPath, 'utf8');
  } catch {
    return new Map();
  }
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || cells[0] === 'Name' || /^:?-{3,}:?$/.test(cells[0])) continue;
    const name = cells[0];
    const reviewBy = cells[5];
    if (name && /^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) entries.set(name, { name, reviewBy });
  }
  return entries;
}

function pathApiFor(options = {}) {
  const platform = options.platform ?? process.platform;
  return options.pathApi ?? (platform === 'win32' ? path.win32 : path);
}

/**
 * Resolve path aliases through the native filesystem implementation when possible.
 * Missing worktrees still get a stable path by resolving their existing parent.
 * @param {string} value
 * @param {{platform?: string, pathApi?: typeof path, realpath?: (value: string) => string}} options
 */
export function normalizePath(value, options = {}) {
  const pathApi = pathApiFor(options);
  const absolutePath = pathApi.resolve(String(value));
  const realpath = options.realpath ?? ((candidate) => fs.realpathSync.native(candidate));
  try {
    return pathApi.normalize(realpath(absolutePath));
  } catch {
    try {
      const resolvedParent = realpath(pathApi.dirname(absolutePath));
      return pathApi.normalize(pathApi.join(resolvedParent, pathApi.basename(absolutePath)));
    } catch {
      return pathApi.normalize(absolutePath);
    }
  }
}

function relativeInside(parent, child, pathOptions = {}) {
  const pathApi = pathApiFor(pathOptions);
  const relative = pathApi.relative(normalizePath(parent, pathOptions), normalizePath(child, pathOptions));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(relative);
}

export function classify(worktreePath, projectRoot, prototypes, pathOptions = {}) {
  const pathApi = pathApiFor(pathOptions);
  const absolutePath = normalizePath(worktreePath, pathOptions);
  const canonicalProjectRoot = normalizePath(projectRoot, pathOptions);
  const taskRoot = pathApi.join(canonicalProjectRoot, 'wt');
  const prototypeRoot = pathApi.join(canonicalProjectRoot, 'proto');
  if (relativeInside(taskRoot, absolutePath, pathOptions)) return { kind: 'task', prototype: null };
  if (relativeInside(prototypeRoot, absolutePath, pathOptions)) {
    const name = pathApi.relative(normalizePath(prototypeRoot, pathOptions), absolutePath).split(pathApi.sep)[0];
    return { kind: 'prototype', prototype: prototypes.get(name) ?? null };
  }
  return { kind: 'other', prototype: null };
}

function compactAge(hours) {
  return hours === null ? null : Math.max(0, Math.round(hours * 10) / 10);
}

function ageFromMilliseconds(nowMs, thenMs) {
  return Math.max(0, (nowMs - thenMs) / 3_600_000);
}

function pathHasIgnoredComponent(relativePath) {
  return relativePath.split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules');
}

function parseStatus(output) {
  const counts = { staged: 0, modified: 0, deleted: 0, untracked: 0, renamed: 0, total: 0 };
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const record = entries[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (pathHasIgnoredComponent(filePath)) {
      if (status.includes('R') || status.includes('C')) i++;
      continue;
    }
    counts.total++;
    if (status === '??') {
      counts.untracked++;
      continue;
    }
    const indexStatus = status[0] ?? ' ';
    const worktreeStatus = status[1] ?? ' ';
    if (indexStatus !== ' ' && indexStatus !== 'D' && indexStatus !== 'R' && indexStatus !== 'C') counts.staged++;
    if (worktreeStatus === 'M' || worktreeStatus === 'U') counts.modified++;
    if (status.includes('D')) counts.deleted++;
    if (status.includes('R') || status.includes('C')) {
      counts.renamed++;
      i++;
    }
  }
  return counts;
}

function unavailableStatus() {
  return { staged: null, modified: null, deleted: null, untracked: null, renamed: null, total: null };
}

function lastFileModification(worktreePath, nowMs) {
  const output = git(worktreePath, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  let newest = null;
  for (const relativePath of output.split('\0')) {
    if (!relativePath || pathHasIgnoredComponent(relativePath)) continue;
    const absolutePath = path.resolve(worktreePath, relativePath);
    if (!relativeInside(worktreePath, absolutePath)) continue;
    try {
      const stat = fs.lstatSync(absolutePath);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // A file removed between Git enumeration and stat is not a modification.
    }
  }
  return newest === null ? null : ageFromMilliseconds(nowMs, newest);
}

function directorySize(rootPath) {
  let bytes = 0;
  const warnings = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      warnings.push(path.relative(rootPath, directory) + ': could not read directory');
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        try {
          bytes += fs.lstatSync(file).size;
        } catch {
          warnings.push(path.relative(rootPath, file) + ': could not read file size');
        }
      }
    }
  };
  visit(rootPath);
  return { sizeMb: Math.round((bytes / (1024 * 1024)) * 10) / 10, warnings };
}

function readMainCommit(repoRoot, main) {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--end-of-options', main + '^{commit}']).trim();
  } catch {
    return null;
  }
}

function isAncestor(repoRoot, ancestor, descendant) {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' });
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    return null;
  }
}

function commitAge(repoRoot, head, nowMs) {
  try {
    const value = Number(git(repoRoot, ['show', '-s', '--format=%ct', head]).trim());
    return Number.isFinite(value) ? ageFromMilliseconds(nowMs, value * 1000) : null;
  } catch {
    return null;
  }
}

export function verdictFor(worktree, isPrimary, registeredPrototype) {
  if (isPrimary) return 'KEEP';
  if (worktree.locked) return 'ASK-OWNER';
  if (!worktree.exists) return worktree.prunable ? 'REMOVE' : 'ASK-OWNER';
  if (worktree.detached) return 'DETACHED';
  if (worktree.kind === 'other') return 'MISPLACED';
  if (worktree.kind === 'prototype') {
    if (!registeredPrototype) return 'ASK-OWNER';
    return worktree.reviewOverdue ? 'OVERDUE' : 'KEEP';
  }
  if (!worktree.status || worktree.status.total === null || worktree.status.total > 0 || worktree.merged === null) return 'ASK-OWNER';
  if (worktree.merged) return 'REMOVE';
  if (worktree.stale) return 'STALE';
  return 'KEEP';
}

/**
 * Inventory worktrees without changing Git or filesystem state.
 * @param {{root: string, main?: string, includeSize?: boolean, now?: () => number}} options
 */
export function auditWorktrees({ root, main = DEFAULT_MAIN, includeSize = true, now = () => Date.now() }) {
  const projectRoot = path.resolve(root);
  const canonicalProjectRoot = normalizePath(projectRoot);
  const repoRoot = findRepoRoot(canonicalProjectRoot);
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new Error('now must return epoch milliseconds');
  const prototypes = readPrototypeRegister(canonicalProjectRoot);
  const mainCommit = readMainCommit(repoRoot, main);
  const worktrees = parseWorktrees(git(repoRoot, ['worktree', 'list', '--porcelain', '-z'])).map((raw) => {
    const worktreePath = path.resolve(String(raw.path));
    const { kind, prototype } = classify(worktreePath, canonicalProjectRoot, prototypes);
    const exists = isDirectory(worktreePath);
    const head = raw.head ? String(raw.head) : null;
    const warnings = [];
    let status = unavailableStatus();
    let lastCommitAgeHours = null;
    let lastFileChangeAgeHours = null;
    let sizeMb = null;
    let merged = null;
    let ahead = null;
    if (exists) {
      try {
        status = parseStatus(git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']));
      } catch {
        warnings.push('Git status could not be read');
      }
      if (head) {
        lastCommitAgeHours = commitAge(repoRoot, head, nowMs);
        if (lastCommitAgeHours === null) warnings.push('last commit age is unavailable');
        if (mainCommit) {
          merged = isAncestor(repoRoot, head, mainCommit);
          if (merged === null) warnings.push('merged state is unavailable');
          try {
            ahead = Number(git(repoRoot, ['rev-list', '--count', mainCommit + '..' + head]).trim());
            if (!Number.isFinite(ahead)) ahead = null;
          } catch {
            ahead = null;
          }
          if (ahead === null) warnings.push('ahead count is unavailable');
        }
      }
      try {
        lastFileChangeAgeHours = lastFileModification(worktreePath, nowMs);
      } catch {
        warnings.push('last file modification age is unavailable');
      }
      if (includeSize) {
        const size = directorySize(worktreePath);
        sizeMb = size.sizeMb;
        warnings.push(...size.warnings);
      }
    } else {
      warnings.push('worktree path is missing');
    }
    if (!mainCommit) warnings.push('main ref ' + main + ' is unavailable');
    const activityAges = [lastCommitAgeHours, lastFileChangeAgeHours].filter((value) => value !== null);
    const stale = activityAges.length === 2 ? Math.min(...activityAges) >= STALE_AFTER_HOURS : null;
    const reviewOverdue = Boolean(prototype && new Date(nowMs).toISOString().slice(0, 10) > prototype.reviewBy);
    const worktree = {
      path: worktreePath,
      kind,
      branch: raw.branchRef ? String(raw.branchRef).replace(/^refs\/heads\//, '') : null,
      detached: Boolean(raw.detached),
      exists,
      prunable: Boolean(raw.prunable),
      locked: Boolean(raw.locked),
      head,
      merged,
      ahead,
      status,
      lastCommitAgeHours: compactAge(lastCommitAgeHours),
      lastFileChangeAgeHours: compactAge(lastFileChangeAgeHours),
      sizeMb,
      stale,
      verdict: null,
      warnings,
    };
    worktree.verdict = verdictFor(worktree, normalizePath(worktreePath) === normalizePath(repoRoot), prototype);
    if (kind === 'prototype') {
      worktree.reviewBy = prototype?.reviewBy ?? null;
      worktree.reviewOverdue = reviewOverdue;
    }
    return worktree;
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    root: projectRoot,
    main,
    worktrees,
  };
}

function table(report) {
  const lines = [
    'KIND       VERDICT     BRANCH                         AHEAD DIRTY COMMIT(h) FILE(h) SIZE(MB) PATH',
  ];
  for (const entry of report.worktrees) {
    const branch = entry.branch ?? (entry.detached ? '(detached)' : '(no branch)');
    const statusCount = entry.status && entry.status.total !== null ? String(entry.status.total) : '—';
    const age = (value) => value === null ? '—' : value.toFixed(1);
    const size = entry.sizeMb === null ? '—' : entry.sizeMb.toFixed(1);
    lines.push([
      entry.kind.padEnd(10),
      entry.verdict.padEnd(11),
      branch.slice(0, 30).padEnd(30),
      entry.ahead === null ? '—'.padStart(5) : String(entry.ahead).padStart(5),
      statusCount.padStart(5),
      age(entry.lastCommitAgeHours).padStart(8),
      age(entry.lastFileChangeAgeHours).padStart(7),
      size.padStart(8),
      entry.path,
    ].join(' '));
    for (const warning of entry.warnings) lines.push('  warning: ' + warning);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2), discoverProjectRoot());
    if (opts.help) {
      console.log(USAGE);
    } else {
      const report = auditWorktrees({
        root: opts.root,
        main: opts.main,
        includeSize: opts.includeSize,
      });
      console.log(opts.json ? JSON.stringify(report, null, 2) : table(report));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}
