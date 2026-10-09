import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangelogError, SECTIONS, foldFragments, fragmentFiles, parseFragment } from '../scripts/lib/changelog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'changelog.mjs');
const temporaryRoots: string[] = [];
const fragment = (body: string, name = 'change.md') => parseFragment(name, body);

afterEach(() => {
  for (const dir of temporaryRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('changelog fragments', () => {
  it('parses every real fragment', () => {
    const dir = path.join(root, 'changelog.d');
    for (const name of fragmentFiles(dir)) {
      expect(() => parseFragment(name, fs.readFileSync(path.join(dir, name), 'utf8'))).not.toThrow();
    }
  });

  it('parses a valid fragment and every allowed section', () => {
    expect(fragment('section: Added\n\n- First bullet.\n')).toEqual({ section: 'Added', bullets: ['First bullet.'] });
    for (const section of SECTIONS) {
      expect(fragment(`section: ${section}\n\n- Entry.\n`).section).toBe(section);
    }
  });

  it('rejects an invalid section and a missing blank line', () => {
    expect(() => fragment('section: Planned\n\n- Entry.\n')).toThrow(/change\.md: first line/);
    expect(() => fragment('section: Added\n- Entry.\n')).toThrow(/change\.md: the section line must be followed by one blank line/);
  });

  it('rejects non-bullet content and empty bullets', () => {
    expect(() => fragment('section: Added\n\nA paragraph.\n')).toThrow(/change\.md: line 3: expected a bullet/);
    expect(() => fragment('section: Added\n\n- \n')).toThrow(/change\.md: line 3: bullet text must not be empty/);
    expect(() => fragment('section: Added\n\n')).toThrow(/change\.md: fragment must contain at least one bullet/);
  });

  it('joins indented continuation lines to the bullet with one space', () => {
    expect(fragment('section: Changed\n\n- First part.  \n  Second part.  \n  Third part.\n').bullets)
      .toEqual(['First part. Second part. Third part.']);
  });

  it('rejects tabs, oversize fragments, key-shaped strings and invalid file names', () => {
    expect(() => fragment('section: Added\n\n- Bad\tindent.\n')).toThrow(/change\.md: tabs are not allowed/);
    expect(() => fragment(`section: Added\n\n- ${'x'.repeat(8 * 1024)}\n`)).toThrow(/change\.md: fragment is larger than 8 KB/);
    for (const secret of ['sk-ant-', `sk-${'a'.repeat(20)}`, `AKIA${'A'.repeat(16)}`, '-----BEGIN PRIVATE KEY-----']) {
      expect(() => fragment(`section: Security\n\n- ${secret}\n`)).toThrow(/change\.md: fragment looks like it contains a secret key/);
    }
    expect(() => parseFragment('Wrong Name.MD', 'section: Added\n\n- Entry.\n')).toThrow(/Wrong Name\.MD: invalid fragment file name/);
  });

  it('requires LF, a final newline and no more than 20 bullets', () => {
    expect(() => fragment('section: Added\r\n\r\n- Entry.\r\n')).toThrow(/change\.md: use LF line endings/);
    expect(() => fragment('section: Added\n\n- Entry.')).toThrow(/change\.md: file must end with a newline/);
    expect(() => fragment(`section: Added\n\n${Array.from({ length: 21 }, (_, i) => `- Entry ${i + 1}.`).join('\n')}\n`))
      .toThrow(/change\.md: a fragment may contain at most 20 bullets/);
  });

  it('lists only sorted Markdown fragments and excludes README.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-list-'));
    temporaryRoots.push(dir);
    for (const name of ['z.md', 'README.md', 'a.md', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '');
    expect(fragmentFiles(dir)).toEqual(['a.md', 'z.md']);
  });

  it('creates missing sections at the top in section order', () => {
    const source = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n\nReleased text.\n';
    const fragments = ['Security', 'Removed', 'Added', 'Deprecated', 'Fixed', 'Changed'].map((section) => ({
      name: `${section.toLowerCase()}.md`, section, bullets: [`${section} entry.`],
    }));
    const result = foldFragments(source, fragments);
    const headings = result.text.slice(result.text.indexOf('## [Unreleased]'), result.text.indexOf('## [1.0.0]'))
      .split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual(SECTIONS.map((section) => `### ${section}`));
    expect(result.folded.map((entry) => entry.section)).toEqual(SECTIONS);
  });

  it('inserts at the top of the first duplicate section heading', () => {
    const source = '## [Unreleased]\n\n### Added\n- Existing first.\n\n### Added\n- Existing second.\n';
    const result = foldFragments(source, [{ name: 'one.md', section: 'Added', bullets: ['New entry.'] }]);
    expect(result.text).toBe('## [Unreleased]\n\n### Added\n- New entry.\n- Existing first.\n\n### Added\n- Existing second.\n');
  });

  it('keeps every original line byte-identical and in relative order', () => {
    const source = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Existing line.  \n  Existing continuation.\n\n## [1.0.0]\n\nReleased.\n';
    const result = foldFragments(source, [
      { name: 'two.md', section: 'Added', bullets: ['New added entry.'] },
      { name: 'one.md', section: 'Fixed', bullets: ['New fixed entry.'] },
    ]);
    const outputLines = result.text.split('\n');
    let cursor = 0;
    for (const originalLine of source.split('\n')) {
      const found = outputLines.indexOf(originalLine, cursor);
      expect(found).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });

  it('orders bullets by fragment name and leaves the released block unchanged', () => {
    const released = '## [1.0.0]\n\n### Fixed\n- Released exactly as written.\n';
    const source = `## [Unreleased]\n\n### Added\n- Existing entry.\n\n${released}`;
    const result = foldFragments(source, [
      { name: 'z-last.md', section: 'Added', bullets: ['From z.'] },
      { name: 'a-first.md', section: 'Added', bullets: ['From a.'] },
    ]);
    expect(result.text).toContain('### Added\n- From a.\n- From z.\n- Existing entry.');
    expect(result.text.endsWith(released)).toBe(true);
    expect(result.folded.map((entry) => entry.from)).toEqual(['a-first.md', 'z-last.md']);
  });

  it('returns identical text with zero fragments and errors when Unreleased is missing', () => {
    const source = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n';
    expect(foldFragments(source, []).text).toBe(source);
    expect(() => foldFragments('# Changelog\n\n## [1.0.0]\n', [{ name: 'a.md', section: 'Added', bullets: ['Entry.'] }]))
      .toThrow(/CHANGELOG\.md: missing ## \[Unreleased\] heading/);
  });

  it('refuses CRLF changelogs with a clear error', () => {
    expect(() => foldFragments('## [Unreleased]\r\n\r\n', [{ name: 'a.md', section: 'Added', bullets: ['Entry.'] }]))
      .toThrow(/CHANGELOG\.md: CRLF line endings are not supported; use LF/);
  });

  it('runs fold, dry-run and check in an isolated fixture root', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-cli-'));
    temporaryRoots.push(fixtureRoot);
    fs.mkdirSync(path.join(fixtureRoot, 'changelog.d'));
    fs.writeFileSync(path.join(fixtureRoot, 'CHANGELOG.md'), '## [Unreleased]\n\n### Fixed\n- Existing.\n');
    fs.writeFileSync(path.join(fixtureRoot, 'changelog.d', 'fix-one.md'), 'section: Fixed\n\n- New fix.\n');
    const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    expect(run('check', '--root', fixtureRoot)).toBe('1 fragments OK\n');
    expect(run('fold', '--root', fixtureRoot)).toContain('Folded 1 entries from 1 fragments');
    expect(fs.readFileSync(path.join(fixtureRoot, 'CHANGELOG.md'), 'utf8'))
      .toContain('### Fixed\n- New fix.\n- Existing.');
    expect(fs.existsSync(path.join(fixtureRoot, 'changelog.d', 'fix-one.md'))).toBe(false);
    expect(run('check', '--root', fixtureRoot)).toBe('0 fragments OK\n');

    const nextFragment = path.join(fixtureRoot, 'changelog.d', 'dry-run.md');
    fs.writeFileSync(nextFragment, 'section: Added\n\n- Dry run entry.\n');
    const beforeChangelog = fs.readFileSync(path.join(fixtureRoot, 'CHANGELOG.md'), 'utf8');
    const beforeFragment = fs.readFileSync(nextFragment, 'utf8');
    expect(run('fold', '--dry-run', '--root', fixtureRoot)).toContain('Folded 1 entries from 1 fragments');
    expect(fs.readFileSync(path.join(fixtureRoot, 'CHANGELOG.md'), 'utf8')).toBe(beforeChangelog);
    expect(fs.readFileSync(nextFragment, 'utf8')).toBe(beforeFragment);

    fs.writeFileSync(path.join(fixtureRoot, 'changelog.d', 'bad.md'), 'section: Added\n\nparagraph\n');
    let failure: unknown;
    try {
      run('check', '--root', fixtureRoot);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException & { status?: number }).status).toBe(1);
    expect(String((failure as { stderr?: Buffer }).stderr)).toContain('bad.md: line 3: expected a bullet');
  });

  it('has an Unreleased heading and supports a real-repository dry run', () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog.split('\n')).toContain('## [Unreleased]');
    expect(() => execFileSync(process.execPath, [script, 'fold', '--dry-run'], { encoding: 'utf8' })).not.toThrow();
  });

  it('uses ChangelogError for parser errors', () => {
    expect(() => parseFragment('bad.md', 'wrong\n')).toThrow(ChangelogError);
  });
});
