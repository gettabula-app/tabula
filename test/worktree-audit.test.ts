import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWorktrees, verdictFor } from '../scripts/worktree-audit.mjs';

const script = fileURLToPath(new URL('../scripts/worktree-audit.mjs', import.meta.url));
const hourMs = 60 * 60 * 1000;
const fixedNow = Date.parse('2026-10-10T12:00:00.000Z');

type Fixture = {
  scratch: string;
  root: string;
  repo: string;
  paths: Record<'merged' | 'ahead' | 'detached' | 'prototype' | 'other' | 'missing' | 'recent' | 'boundary' | 'overdue', string>;
};

let fixture: Fixture;
let scratchPath: string | undefined;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(cwd: string, message: string, timestamp: number): void {
  const date = new Date(timestamp).toISOString();
  git(cwd, ['add', '--all']);
  git(cwd, ['commit', '--quiet', '-m', message], {
    GIT_AUTHOR_NAME: 'Audit test',
    GIT_AUTHOR_EMAIL: 'audit-test@example.invalid',
    GIT_COMMITTER_NAME: 'Audit test',
    GIT_COMMITTER_EMAIL: 'audit-test@example.invalid',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

function addWorktree(repo: string, branch: string, worktreePath: string, ref = 'main'): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, worktreePath, ref]);
}

function setTreeTime(root: string, timestamp: number): void {
  const seconds = timestamp / 1000;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const entryPath = path.join(root, entry.name);
    const info = fs.lstatSync(entryPath);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) setTreeTime(entryPath, timestamp);
    fs.utimesSync(entryPath, seconds, seconds);
  }
  fs.utimesSync(root, seconds, seconds);
}

function makeFixture(): Fixture {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula worktree audit '));
  scratchPath = scratch;
  const root = path.join(scratch, 'workspace with spaces');
  const repo = path.join(root, 'tabula');
  const paths = {
    merged: path.join(root, 'wt', 'audit merged task'),
    ahead: path.join(root, 'wt', 'audit ahead task'),
    detached: path.join(root, 'wt', 'audit detached task'),
    prototype: path.join(root, 'proto', 'prototype preview'),
    other: path.join(root, 'scratch worktrees', 'unclassified checkout'),
    missing: path.join(root, 'wt', 'audit missing task'),
    recent: path.join(root, 'wt', 'audit recent task'),
    boundary: path.join(root, 'wt', 'audit boundary task'),
    overdue: path.join(root, 'wt', 'audit overdue task'),
  };

  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet']);
  git(repo, ['checkout', '--quiet', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Audit test']);
  git(repo, ['config', 'user.email', 'audit-test@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  for (const name of ['staged.txt', 'modified.txt', 'deleted.txt', 'rename-old.txt', 'seed.txt']) {
    fs.writeFileSync(path.join(repo, name), `base ${name}\n`);
  }
  commit(repo, 'initial audit fixture', fixedNow - hourMs * 3);

  addWorktree(repo, 'audit/merged', paths.merged);
  fs.writeFileSync(path.join(paths.merged, 'merged-branch.txt'), 'merged commit\n');
  commit(paths.merged, 'merged branch commit', fixedNow - hourMs * 2);
  git(repo, ['merge', '--quiet', '--ff-only', 'audit/merged']);

  addWorktree(repo, 'audit/ahead', paths.ahead);
  fs.writeFileSync(path.join(paths.ahead, 'ahead-branch.txt'), 'ahead commit\n');
  commit(paths.ahead, 'ahead branch commit', fixedNow - hourMs * 2);

  fs.mkdirSync(path.dirname(paths.detached), { recursive: true });
  git(repo, ['worktree', 'add', '--quiet', '--detach', paths.detached, 'main']);

  addWorktree(repo, 'proto/branch-does-not-match-directory', paths.prototype);
  addWorktree(repo, 'audit/unclassified', paths.other);
  addWorktree(repo, 'audit/missing', paths.missing);
  addWorktree(repo, 'audit/recent', paths.recent);
  fs.writeFileSync(path.join(paths.recent, 'recent-activity.txt'), 'recent\n');
  commit(paths.recent, 'recent task activity', fixedNow - hourMs * 23.96);

  addWorktree(repo, 'audit/boundary', paths.boundary);
  fs.writeFileSync(path.join(paths.boundary, 'boundary-activity.txt'), 'exactly one day old\n');
  commit(paths.boundary, 'boundary task activity', fixedNow - hourMs * 24);

  addWorktree(repo, 'audit/overdue', paths.overdue);
  fs.writeFileSync(path.join(paths.overdue, 'overdue-activity.txt'), 'older than one day\n');
  commit(paths.overdue, 'overdue task activity', fixedNow - hourMs * 25);

  fs.mkdirSync(path.join(root, 'proto'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proto', 'README.md'), [
    '# Prototype register',
    '',
    '| Name | Owner | Purpose | Branch | Created | Review by | Port |',
    '|---|---|---|---|---|---|---|',
    '| prototype preview | Q&A | Directory name is the registration key | proto/branch-does-not-match-directory | 2026-10-10 | 2026-10-18 | none |',
    '',
  ].join('\n'));

  const ignoredTarget = path.join(scratch, 'large ignored dependency directory');
  fs.mkdirSync(ignoredTarget, { recursive: true });
  fs.writeFileSync(path.join(ignoredTarget, 'bundle.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  // Windows directory junctions do not require the symbolic-link privilege.
  fs.symlinkSync(ignoredTarget, path.join(paths.ahead, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  fs.writeFileSync(path.join(paths.ahead, 'staged.txt'), 'staged content\n');
  git(paths.ahead, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(paths.ahead, 'modified.txt'), 'modified content\n');
  fs.unlinkSync(path.join(paths.ahead, 'deleted.txt'));
  git(paths.ahead, ['mv', 'rename-old.txt', 'rename-new.txt']);
  fs.writeFileSync(path.join(paths.ahead, 'untracked.txt'), 'untracked\n');
  fs.writeFileSync(path.join(paths.ahead, 'node_modules-old.txt'), 'similarly named file still counts\n');
  expect(git(paths.ahead, ['check-ignore', 'node_modules']).trim()).toBe('node_modules');

  fs.rmSync(paths.missing, { recursive: true, force: true });
  setTreeTime(paths.recent, fixedNow - hourMs * 23.96);
  setTreeTime(paths.boundary, fixedNow - hourMs * 24);
  setTreeTime(paths.overdue, fixedNow - hourMs * 25);

  return { scratch, root, repo, paths };
}

function reportFor(options: { root?: string; main?: string; includeSize?: boolean; now?: () => number } = {}) {
  return auditWorktrees({
    root: options.root ?? fixture.root,
    main: options.main ?? 'main',
    includeSize: options.includeSize ?? false,
    now: options.now ?? (() => fixedNow),
  });
}

function normalizedPath(value: string, platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path;
  let normalized: string;
  try {
    normalized = pathApi.normalize(fs.realpathSync(value));
  } catch {
    try {
      normalized = pathApi.join(pathApi.normalize(fs.realpathSync(pathApi.dirname(value))), pathApi.basename(value));
    } catch {
      normalized = pathApi.resolve(value);
    }
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function byPath<T extends { path: string }>(report: { worktrees: T[] }, target: string): T | undefined {
  return report.worktrees.find((worktree) => normalizedPath(worktree.path) === normalizedPath(target));
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.repo,
    encoding: 'utf8',
    shell: false,
  });
}

beforeAll(() => {
  fixture = makeFixture();
}, 30_000);

afterAll(() => {
  if (scratchPath) fs.rmSync(scratchPath, { recursive: true, force: true });
});

describe('worktree audit inventory', () => {
  it('normalizes Windows path separators and case when comparing worktree paths', () => {
    expect(normalizedPath('C:/Users/Runner/worktree', 'win32'))
      .toBe(normalizedPath('c:\\users\\runner\\WORKTREE', 'win32'));
  });

  it('classifies task, prototype, and other paths and keeps directory registration separate from branch names', async () => {
    const report = await reportFor();
    const merged = byPath(report, fixture.paths.merged);
    const prototype = byPath(report, fixture.paths.prototype);
    const other = byPath(report, fixture.paths.other);

    expect(merged).toMatchObject({ kind: 'task', branch: 'audit/merged', detached: false, exists: true });
    expect(prototype).toMatchObject({
      kind: 'prototype',
      branch: 'proto/branch-does-not-match-directory',
      verdict: 'KEEP',
    });
    expect(other).toMatchObject({ kind: 'other', branch: 'audit/unclassified', verdict: 'MISPLACED' });
    expect(prototype?.path).toContain(' ');
    expect(report.root).toBe(fixture.root);
    expect(report.main).toBe('main');
  });

  it('distinguishes a branch merged into main from an ahead branch and a detached worktree', async () => {
    const report = await reportFor();

    expect(byPath(report, fixture.paths.merged)).toMatchObject({ merged: true, ahead: 0, verdict: 'REMOVE' });
    expect(byPath(report, fixture.paths.ahead)).toMatchObject({ merged: false, ahead: 1 });
    expect(byPath(report, fixture.paths.detached)).toMatchObject({ detached: true, branch: null, verdict: 'DETACHED' });
  });

  it('reports a removed registered worktree as missing and prunable with unavailable metrics', async () => {
    const report = await reportFor();
    const missing = byPath(report, fixture.paths.missing);

    expect(missing).toMatchObject({
      kind: 'task',
      exists: false,
      prunable: true,
      merged: null,
      ahead: null,
      lastCommitAgeHours: null,
      lastFileChangeAgeHours: null,
      sizeMb: null,
      status: { staged: null, modified: null, deleted: null, untracked: null, renamed: null, total: null },
    });
  });

  it('asks an owner before removing a worktree that is both locked and prunable', () => {
    expect(verdictFor({ exists: false, prunable: true, locked: true }, false, null)).toBe('ASK-OWNER');
  });

  it('counts each status once and ignores an ignored node_modules directory symlink', async () => {
    const report = await reportFor();
    const ahead = byPath(report, fixture.paths.ahead);

    expect(ahead?.status).toEqual({ staged: 1, modified: 1, deleted: 1, untracked: 2, renamed: 1, total: 6 });
  });

  it('uses the exact 24-hour boundary for staleness while rounding displayed ages', async () => {
    const report = await reportFor({ now: () => fixedNow });

    expect(byPath(report, fixture.paths.recent)).toMatchObject({
      stale: false,
      lastCommitAgeHours: 24,
      lastFileChangeAgeHours: 24,
    });
    expect(byPath(report, fixture.paths.boundary)).toMatchObject({
      stale: true,
      verdict: 'STALE',
      lastCommitAgeHours: 24,
      lastFileChangeAgeHours: 24,
    });
    expect(byPath(report, fixture.paths.overdue)).toMatchObject({ stale: true, verdict: 'STALE' });
  });

  it('leaves merge metrics unknown when the requested main ref does not exist', async () => {
    const report = await reportFor({ main: 'missing-local-main-ref' });
    const ahead = byPath(report, fixture.paths.ahead);

    expect(ahead).toMatchObject({ merged: null, ahead: null });
    expect(ahead?.warnings.join(' ')).toMatch(/main|ref/i);
  });
});

describe('worktree audit output', () => {
  it('prints the compact table for paths that contain spaces', () => {
    const result = runCli('--root', fixture.root, '--main', 'main', '--no-size');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('audit merged task');
    expect(result.stdout).toContain('prototype preview');
    expect(result.stdout).toContain('MISPLACED');
    expect(result.stdout).toContain('DETACHED');
  });

  it('prints the documented JSON shape and honors --no-size', () => {
    const result = runCli('--json', '--root', fixture.root, '--main', 'main', '--no-size');

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      generatedAt: unknown;
      root: string;
      main: string;
      worktrees: Array<{ path: string; sizeMb: number | null; status: { total: number | null } }>;
    };
    expect(report).toMatchObject({ root: fixture.root, main: 'main' });
    expect(report.generatedAt).toBeDefined();
    const ahead = byPath(report, fixture.paths.ahead);
    expect(ahead).toMatchObject({
      sizeMb: null,
      status: { total: 6 },
    });
  });

  it('does not follow the ignored dependency symlink when calculating size', async () => {
    const report = await reportFor({ includeSize: true });
    const ahead = byPath(report, fixture.paths.ahead);

    expect(ahead?.sizeMb).toEqual(expect.any(Number));
    expect(ahead?.sizeMb).toBeLessThan(1);
  });

  it('does not refresh or write a worktree index while auditing', async () => {
    const indexPath = path.resolve(fixture.paths.ahead, git(fixture.paths.ahead, ['rev-parse', '--git-path', 'index']).trim());
    const unchangedFile = path.join(fixture.paths.ahead, 'seed.txt');
    const future = Date.now() + 2_000;
    fs.utimesSync(unchangedFile, future / 1000, future / 1000);
    const before = fs.readFileSync(indexPath);
    const beforeMtime = fs.statSync(indexPath).mtimeMs;

    reportFor();

    expect(fs.readFileSync(indexPath)).toEqual(before);
    expect(fs.statSync(indexPath).mtimeMs).toBe(beforeMtime);
  });
});
