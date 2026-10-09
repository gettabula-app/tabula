// Parses changelog fragments and folds them into the Unreleased section without changing existing lines.
import fs from 'node:fs';

export const SECTIONS = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
/** Who a fragment is for: `user` (default) reads in the product's changelog page, `dev` is for people working on Tabula. */
export const AUDIENCES = Object.freeze(['user', 'dev']);
/** The marker a folded bullet of the `dev` audience ends with; a bullet without one is for users. */
export const DEV_MARKER = '<!-- audience: dev -->';
const MARKER_RE = /<!-- audience: (user|dev) -->$/;
const RELEASE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** An error tied to a changelog file. Its message always starts with the file name. */
export class ChangelogError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ChangelogError';
  }
}

/**
 * Parse one fragment, normalising each bullet and joining its continuation lines with one space.
 * @param {string} name Fragment file name (not its directory)
 * @param {string} text
 * @returns {{ section: string, audience: 'user' | 'dev', bullets: string[] }}
 */
export function parseFragment(name, text) {
  const fail = (message) => { throw new ChangelogError(`${name}: ${message}`); };
  if (typeof name !== 'string' || !/^[a-z0-9._-]+\.md$/.test(name) || name === 'README.md') {
    fail('invalid fragment file name; use lowercase letters, digits, dots, dashes or underscores and end with .md');
  }
  if (typeof text !== 'string') fail('fragment content must be text');
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024) fail('fragment is larger than 8 KB');
  if (text.includes('\r')) fail('use LF line endings; CRLF is not supported');
  if (/\t/.test(text)) fail('tabs are not allowed');
  if (/sk-ant-|sk-[A-Za-z0-9]{20}|AKIA[A-Z0-9]{16}|-----BEGIN/.test(text)) {
    fail('fragment looks like it contains a secret key; remove the key before continuing');
  }
  if (!text.endsWith('\n')) fail('file must end with a newline');

  const lines = text.slice(0, -1).split('\n');
  const header = /^section: ([A-Za-z]+)$/.exec(lines[0] ?? '');
  const section = header?.[1];
  if (!section || !SECTIONS.includes(section)) {
    fail(`first line must be section: followed by one of ${SECTIONS.join(', ')}`);
  }
  let audience = 'user';
  let first = 1;
  const audienceLine = /^audience: (.*)$/.exec(lines[1] ?? '');
  if (audienceLine) {
    if (!AUDIENCES.includes(audienceLine[1])) fail(`audience must be one of ${AUDIENCES.join(', ')}`);
    audience = audienceLine[1];
    first = 2;
  }
  if (lines[first] !== '') fail(`the ${first === 2 ? 'audience' : 'section'} line must be followed by one blank line`);

  /** @type {string[]} */
  const bullets = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      const bullet = line.slice(2).trim();
      if (!bullet) fail(`line ${i + 1}: bullet text must not be empty`);
      if (bullet.includes('<!--')) fail(`line ${i + 1}: HTML comments are reserved for the audience marker; use the audience: line`);
      bullets.push(bullet);
      if (bullets.length > 20) fail('a fragment may contain at most 20 bullets');
    } else if (line.startsWith('  ') && !line.startsWith('   ')) {
      if (!bullets.length) fail(`line ${i + 1}: continuation line has no bullet`);
      const continuation = line.slice(2).trim();
      if (!continuation) fail(`line ${i + 1}: continuation text must not be empty`);
      bullets[bullets.length - 1] += ` ${continuation}`;
    } else {
      fail(`line ${i + 1}: expected a bullet starting with "- " or a continuation indented by two spaces`);
    }
  }
  if (!bullets.length) fail('fragment must contain at least one bullet');
  return { section, audience, bullets };
}

/** Sorted fragment file names in a directory; the README and non-Markdown files are not fragments. @param {string} dir */
export function fragmentFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'README.md' && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Errors in a CHANGELOG.md that the tooling relies on: every `## ` heading is `## [Unreleased]` or `## [<version>] - <YYYY-MM-DD>`
 * with each version once, and an audience marker is exactly `<!-- audience: user|dev -->` at the end of a bullet.
 * @param {string} text
 * @returns {string[]}
 */
export function changelogProblems(text) {
  const problems = [];
  const seen = new Set();
  text.split('\n').forEach((line, index) => {
    const at = `CHANGELOG.md line ${index + 1}`;
    if (line.startsWith('## ') && line !== '## [Unreleased]') {
      const match = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line);
      if (!match || !RELEASE_VERSION_RE.test(match[1]) || Number.isNaN(Date.parse(`${match[2]}T00:00:00Z`))) {
        problems.push(`${at}: a release heading must read ## [<version>] - <YYYY-MM-DD>`);
      } else if (seen.has(match[1])) {
        problems.push(`${at}: release ${match[1]} appears twice`);
      } else {
        seen.add(match[1]);
      }
    }
    if (line.includes('<!--') && !(line.startsWith('- ') && MARKER_RE.test(line) && line.indexOf('<!--') === line.lastIndexOf('<!--'))) {
      problems.push(`${at}: an HTML comment must be a single audience marker at the end of a bullet`);
    }
  });
  return problems;
}

/**
 * Fold parsed fragments into the first Unreleased section. Existing lines retain their content and relative order. A bullet of the
 * `dev` audience gets the marker at its end. With `release` ({ version, date }), the Unreleased section is then cut: an empty
 * `## [Unreleased]` stays at the top and the old section, fragments included, becomes `## [<version>] - <date>`.
 * @param {string} changelogText
 * @param {{ name?: string, from?: string, section: string, audience?: string, bullets: string[] }[]} fragments
 * @param {{ release?: { version: string, date: string } }} [options]
 * @returns {{ text: string, folded: { section: string, bullet: string, from: string }[] }}
 */
export function foldFragments(changelogText, fragments, { release } = {}) {
  const changelogName = 'CHANGELOG.md';
  if (changelogText.includes('\r')) {
    throw new ChangelogError(`${changelogName}: CRLF line endings are not supported; use LF`);
  }
  const lines = changelogText.split('\n');
  const unreleased = lines.findIndex((line) => line === '## [Unreleased]');
  if (unreleased === -1) throw new ChangelogError(`${changelogName}: missing ## [Unreleased] heading`);
  const hasTrailingNewline = changelogText.endsWith('\n');
  const actualLineCount = lines.length - (hasTrailingNewline ? 1 : 0);
  let rangeEnd = actualLineCount;
  for (let i = unreleased + 1; i < actualLineCount; i++) {
    if (lines[i].startsWith('## ')) {
      rangeEnd = i;
      break;
    }
  }
  if (release) {
    if (!RELEASE_VERSION_RE.test(release.version ?? '') || release.version === 'Unreleased') {
      throw new ChangelogError(`${changelogName}: the release version must be 1 to 40 letters, digits, dots, dashes or underscores`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date ?? '') || Number.isNaN(Date.parse(`${release.date}T00:00:00Z`))) {
      throw new ChangelogError(`${changelogName}: the release date must be YYYY-MM-DD`);
    }
    if (lines.some((line) => line.startsWith(`## [${release.version}]`))) {
      throw new ChangelogError(`${changelogName}: release ${release.version} already has a heading`);
    }
  }
  if (!fragments.length && !release) return { text: changelogText, folded: [] };

  /** @type {Map<string, { bullet: string, from: string }[]>} */
  const bySection = new Map(SECTIONS.map((section) => [section, []]));
  const ordered = [...fragments].sort((a, b) => {
    const aName = a.name ?? a.from ?? '';
    const bName = b.name ?? b.from ?? '';
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });
  for (const fragment of ordered) {
    const from = fragment.name ?? fragment.from ?? '(unknown fragment)';
    if (!bySection.has(fragment.section)) throw new ChangelogError(`${from}: unknown changelog section`);
    if (!fragment.bullets.length) throw new ChangelogError(`${from}: fragment must contain at least one bullet`);
    for (const bullet of fragment.bullets) {
      bySection.get(fragment.section)?.push({ bullet: fragment.audience === 'dev' ? `${bullet} ${DEV_MARKER}` : bullet, from });
    }
  }

  /** @type {{ section: string, bullet: string, from: string }[]} */
  const folded = SECTIONS.flatMap((section) => (bySection.get(section) ?? []).map(({ bullet, from }) => ({ section, bullet, from })));

  /** @type {{ at: number, lines: string[] }[]} */
  const insertions = [];
  /** @type {string[]} */
  const newSections = [];
  for (const section of SECTIONS) {
    const entries = bySection.get(section) ?? [];
    if (!entries.length) continue;
    const heading = `### ${section}`;
    let headingIndex = -1;
    for (let i = unreleased + 1; i < rangeEnd; i++) {
      if (lines[i] === heading) {
        headingIndex = i;
        break;
      }
    }
    const bullets = entries.map(({ bullet }) => `- ${bullet}`);
    if (headingIndex === -1) {
      if (newSections.length) newSections.push('');
      newSections.push(heading, ...bullets);
    } else {
      let at = headingIndex + 1;
      if (at < actualLineCount && lines[at] === '') at++;
      insertions.push({ at, lines: bullets });
    }
  }

  if (newSections.length) {
    const contentStart = unreleased + 1 + (unreleased + 1 < actualLineCount && lines[unreleased + 1] === '' ? 1 : 0);
    if (contentStart < rangeEnd) newSections.push('');
    insertions.push({ at: contentStart, lines: newSections });
  }

  insertions.sort((a, b) => b.at - a.at);
  for (const insertion of insertions) lines.splice(insertion.at, 0, ...insertion.lines);
  if (release) lines.splice(unreleased, 1, '## [Unreleased]', '', `## [${release.version}] - ${release.date}`);
  return { text: lines.join('\n'), folded };
}
