import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// The chat dock, its bubble and the comments panel ease in when they are shown (dock-in, dock-rise, dock-sheet-in, bubble-in, tray-in).
// The motion is CSS, which a unit test cannot run, so this pins the rules it is made of: the keyframes, the shared easing tokens, no scale
// from zero, and a reduced-motion block per file that names every animated selector and holds no translate or scale.

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const DOCK = 'src/ui/chat-dock.css';
const TRAY = 'src/ui/comments.css';
const FILES = [DOCK, TRAY];
const REDUCE = /prefers-reduced-motion:\s*reduce/;

type Rule = { selector: string; body: string; media: string };

/** The style rules of a stylesheet, descending into @media blocks; other at-rules (keyframes) are skipped whole. */
function rules(css: string, media = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) out.push(...rules(body, prelude));
    else if (!prelude.startsWith('@')) out.push({ selector: prelude, body, media });
    i = j;
  }
  return out;
}

/** The rules that animate outside the reduced-motion block (a rule that only turns an animation off does not count). */
const animated = (css: string) => rules(css).filter((r) => !REDUCE.test(r.media) && /(^|[;\s])animation\s*:(?!\s*none\b)/.test(r.body));

const selectorsOf = (r: Rule) => r.selector.split(',').map((s) => s.trim());

describe('dock and tray motion (src/ui/chat-dock.css, src/ui/comments.css)', () => {
  it('defines the entrance keyframes the dock, bubble and tray use', () => {
    expect(read(DOCK)).toMatch(/@keyframes dock-in \{/);
    expect(read(DOCK)).toMatch(/@keyframes bubble-in \{/);
    expect(read(TRAY)).toMatch(/@keyframes tray-in \{/);
  });

  it('turns the entrance off for a keyboard opening (the M key) of the dock and bubble', () => {
    expect(read(DOCK)).toMatch(/\.chat-dock-host \.chat-dock\[data-instant\][^{]*\{\s*animation: none;/);
  });

  it('eases every animated selector with the ease-out or ease-drawer token', () => {
    expect(FILES.filter((file) => animated(read(file)).length === 0)).toEqual([]);
    const unlisted = FILES.flatMap((file) =>
      animated(read(file))
        .filter((r) => !/var\(--ease-(out|drawer)\)/.test(r.body.match(/(?:^|[;\s])animation\s*:\s*([^;]+)/)?.[1] ?? ''))
        .map((r) => `${file}: ${r.selector}`),
    );
    expect(unlisted).toEqual([]);
  });

  it('never scales from zero and never transitions every property', () => {
    const offenders = FILES.filter((file) => /scale\(\s*0\s*[),]/.test(read(file)) || /transition:\s*all\b/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('names every animated selector in a reduced-motion block that holds no translate or scale', () => {
    const problems = FILES.flatMap((file) => {
      const css = read(file);
      const reduced = rules(css).filter((r) => REDUCE.test(r.media));
      if (reduced.length === 0) return [`${file}: no reduced-motion block`];
      const named = reduced.flatMap(selectorsOf);
      const moving = reduced.filter((r) => /translate|scale/.test(r.body)).map((r) => `${file}: ${r.selector}`);
      const unnamed = animated(css).flatMap((r) => selectorsOf(r).filter((sel) => !named.includes(sel)).map((sel) => `${file}: ${sel}`));
      return [...moving, ...unnamed];
    });
    expect(problems).toEqual([]);
  });

  it('uses easing tokens that styles.css defines', () => {
    const styles = read('src/styles.css');
    expect(styles).toMatch(/--ease-out:/);
    expect(styles).toMatch(/--ease-drawer:/);
  });
});
