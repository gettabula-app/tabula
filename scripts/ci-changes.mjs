#!/usr/bin/env node
// Decides how much of CI a change needs (.github/workflows/ci.yml, job "changes"). Reads the changed paths from stdin,
// one per line as `git diff --name-only` prints them, and prints two lines for $GITHUB_OUTPUT:
//
//   code=true|false   something changed outside the ignore set below, so the full pipeline runs
//   guide=true|false  something changed under docs/guide/ or docs/images/, which are built into the app (scripts/vite-docs.mjs)
//
// Markdown, docs/ and licence files do not need the test matrix, except changelog.d/*.md fragments: a fragment-only PR
// must start CI so quality can run the changelog format check. The guide still gets a build of its own. No paths at all
// means there was nothing to compare, so both are true and everything runs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Paths that cannot break the app: any Markdown file except changelog.d fragments, anything under docs/, design/
 * (static mockups that no build or image includes), LICENSE* in the repo root, dependabot.yml.
 */
const IGNORED = [/\.md$/, /^docs\//, /^design\//, /^LICENSE[^/]*$/, /^\.github\/dependabot\.yml$/];
const CHANGELOG_FRAGMENT = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/;

/** @param {string[]} paths @returns {{ code: boolean, guide: boolean }} */
export function classify(paths) {
  const files = paths.map((p) => p.replace(/\r$/, '')).filter(Boolean);
  if (!files.length) return { code: true, guide: true };
  return {
    code: files.some((f) => CHANGELOG_FRAGMENT.test(f) || !IGNORED.some((re) => re.test(f))),
    guide: files.some((f) => f.startsWith('docs/guide/') || f.startsWith('docs/images/')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { code, guide } = classify(fs.readFileSync(0, 'utf8').split('\n'));
  console.log(`code=${code}`);
  console.log(`guide=${guide}`);
}
