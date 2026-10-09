// Parses changelog fragments and folds them into the Unreleased section without changing existing lines.
import fs from 'node:fs';

export const SECTIONS = Object.freeze(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

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
 * @returns {{ section: string, bullets: string[] }}
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
  if (lines[1] !== '') fail('the section line must be followed by one blank line');

  /** @type {string[]} */
  const bullets = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- ')) {
      const bullet = line.slice(2).trim();
      if (!bullet) fail(`line ${i + 1}: bullet text must not be empty`);
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
  return { section, bullets };
}

/** Sorted fragment file names in a directory; the README and non-Markdown files are not fragments. @param {string} dir */
export function fragmentFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'README.md' && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Fold parsed fragments into the first Unreleased section. Existing lines retain their content and relative order.
 * @param {string} changelogText
 * @param {{ name?: string, from?: string, section: string, bullets: string[] }[]} fragments
 * @returns {{ text: string, folded: { section: string, bullet: string, from: string }[] }}
 */
export function foldFragments(changelogText, fragments) {
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
  if (!fragments.length) return { text: changelogText, folded: [] };

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
      bySection.get(fragment.section)?.push({ bullet, from });
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
  return { text: lines.join('\n'), folded };
}
