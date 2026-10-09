#!/usr/bin/env node
// Checks changelog fragments and folds them into CHANGELOG.md after a change is ready to merge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SECTIONS, foldFragments, fragmentFiles, parseFragment } from './lib/changelog.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const USAGE = `Usage: node scripts/changelog.mjs <fold|check> [--dry-run] [--root <dir>]

  fold             fold changelog.d/*.md into CHANGELOG.md, then remove the fragments
  fold --dry-run   show the fold summary without changing files
  check            validate every fragment and the CHANGELOG.md Unreleased heading
  --root <dir>     use a repository root other than this checkout`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'fold' && command !== 'check') throw new Error(`unknown subcommand ${command ?? '(missing)'}`);
  let root = DEFAULT_ROOT;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--root needs a directory');
      root = path.resolve(value);
    } else if (arg === '--dry-run') {
      if (command !== 'fold') throw new Error('--dry-run is only valid with fold');
      dryRun = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return { command, root, dryRun };
}

/** @param {string} root @param {string} relative */
function inside(root, relative) {
  const file = path.resolve(root, relative);
  const fromRoot = path.relative(root, file);
  if (fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) {
    throw new Error(`${relative}: path is outside the repository root`);
  }
  return file;
}

/** @param {string} root */
function assertRoot(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory()) throw new Error(`${root}: repository root must be a directory, not a symlink`);
  const fragmentsDir = inside(root, 'changelog.d');
  const dirStat = fs.lstatSync(fragmentsDir);
  if (!dirStat.isDirectory()) throw new Error('changelog.d: expected a directory, not a symlink or file');
  const changelog = inside(root, 'CHANGELOG.md');
  const changelogStat = fs.lstatSync(changelog);
  if (!changelogStat.isFile()) throw new Error('CHANGELOG.md: expected a regular file, not a symlink or directory');
  return { fragmentsDir, changelog };
}

/** @param {string} root @param {string[]} names */
function readFragments(root, names) {
  /** @type {{ name: string, section: string, bullets: string[] }[]} */
  const fragments = [];
  /** @type {string[]} */
  const errors = [];
  for (const name of names) {
    const file = inside(root, `changelog.d/${name}`);
    try {
      if (!fs.lstatSync(file).isFile()) {
        errors.push(`${name}: expected a regular file`);
        continue;
      }
      fragments.push({ name, ...parseFragment(name, fs.readFileSync(file, 'utf8')) });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${name}: could not read fragment`);
    }
  }
  return { fragments, errors };
}

/** @param {{ section: string, bullet: string, from: string }[]} folded @param {number} fragmentCount */
export function formatFoldSummary(folded, fragmentCount) {
  const lines = [`Folded ${folded.length} entries from ${fragmentCount} fragments`];
  for (const section of SECTIONS) {
    const count = folded.filter((entry) => entry.section === section).length;
    if (count) lines.push(`${section}: ${count}`);
  }
  return lines.join('\n');
}

/** @param {{ command: string, root: string, dryRun: boolean }} opts */
function run(opts) {
  const { fragmentsDir, changelog } = assertRoot(opts.root);
  const names = fragmentFiles(fragmentsDir);
  const { fragments, errors } = readFragments(opts.root, names);
  if (opts.command === 'check') {
    let changelogText;
    try {
      changelogText = fs.readFileSync(changelog, 'utf8');
    } catch (error) {
      errors.push(`CHANGELOG.md: ${error instanceof Error ? error.message : 'could not read file'}`);
      changelogText = '';
    }
    if (!changelogText.split(/\r?\n/).includes('## [Unreleased]')) {
      errors.push('CHANGELOG.md: missing ## [Unreleased] heading');
    }
    for (const error of errors) console.error(error);
    if (errors.length) return 1;
    console.log(`${names.length} fragments OK`);
    return 0;
  }

  for (const error of errors) console.error(error);
  if (errors.length) return 1;
  const changelogText = fs.readFileSync(changelog, 'utf8');
  let result;
  try {
    result = foldFragments(changelogText, fragments);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!opts.dryRun && fragments.length) {
    // Do not remove any fragments until the changelog write has completed successfully.
    fs.writeFileSync(changelog, result.text, 'utf8');
    for (const name of names) fs.unlinkSync(inside(opts.root, `changelog.d/${name}`));
  }
  console.log(formatFoldSummary(result.folded, fragments.length));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
  }
  if (opts) {
    try {
      process.exitCode = run(opts);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
