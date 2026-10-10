import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLocale, hashSource, main, stamp } from '../scripts/docs-translations.mjs';

let dir = '';
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const EN_BOARDS = '# Boards\n\n## Open a board\n\n- Click it.\n- Press Enter.\n\nSee [polls](polls.md#results) and ![shot](images/a.png).\n\n## Share\n\nSend the link.\n';
const SV_BOARDS = '# Tavlor\n\n## Öppna en tavla\n\n- Klicka.\n- Tryck Enter.\n\nSe [omröstningar](polls.md#resultat) och ![bild](images/a.png).\n\n## Dela\n\nSkicka länken.\n';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  write('index.md', '# Guide\n\n- [Boards](boards.md)\n- [Polls](polls.md)\n- [Extra](extra.md)\n');
  write('boards.md', EN_BOARDS);
  write('polls.md', '# Polls\n\n## Results\n\nText.\n');
  write('extra.md', '# Extra\n');
  write('sv/index.md', '# Guide\n\n- [Tavlor](boards.md)\n- [Omröstningar](polls.md)\n- [Extra](extra.md)\n');
  write('sv/boards.md', SV_BOARDS);
  write('sv/polls.md', '# Omröstningar\n\n## Resultat\n\nText.\n');
  write('sv/old.md', '# Gammal\n');
  stamp('sv', ['index.md', 'boards.md', 'polls.md', 'extra.md'].filter((f) => fs.existsSync(path.join(dir, 'sv', f))), dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('docs translations check', () => {
  it('reports missing and orphan pages and passes a faithful translation', () => {
    const r = checkLocale('sv', dir);
    expect(r.total).toBe(4);
    expect(r.translated).toBe(3);
    expect(r.missing).toEqual(['extra.md']);
    expect(r.orphan).toEqual(['old.md']);
    expect(r.stale).toEqual([]);
    expect(r.drift).toEqual([]);
  });

  it('flags a page as stale when its English source changed after it was translated', () => {
    write('boards.md', `${EN_BOARDS}\nA new sentence.\n`);
    expect(checkLocale('sv', dir).stale).toEqual(['boards.md']);
    stamp('sv', ['boards.md'], dir);
    expect(checkLocale('sv', dir).stale).toEqual([]);
  });

  it('a translated page nobody stamped is listed, not silently trusted', () => {
    write('sv/polls.md', '# Omröstningar\n\n## Resultat\n\nNy.\n');
    fs.writeFileSync(path.join(dir, 'sv', '.sources.json'), '{}');
    expect(checkLocale('sv', dir).unstamped).toContain('polls.md');
  });

  it('flags a changed structure: headings, list items, links, images and broken #links', () => {
    write('sv/boards.md', '# Tavlor\n\n### Öppna\n\n- Klicka.\n\nSe [omröstningar](extra.md#finns-inte) och ![bild](images/b.png). Se [här](#saknas).\n\n## Dela\n\nSkicka länken.\n');
    const problems = checkLocale('sv', dir).drift.find((d) => d.file === 'boards.md')!.problems.join(' | ');
    expect(problems).toContain('headings differ');
    expect(problems).toContain('1 list items, English has 2');
    expect(problems).toContain('images differ');
    expect(problems).toContain('links to other pages differ');
    expect(problems).toContain('#saknas points at no heading of this page');
  });

  it('checks that a link into another translated page hits one of that page’s headings', () => {
    write('sv/boards.md', SV_BOARDS.replace('polls.md#resultat', 'polls.md#results'));
    const problems = checkLocale('sv', dir).drift.find((d) => d.file === 'boards.md')!.problems.join(' | ');
    expect(problems).toContain('link polls#results points at no heading of that page');
  });

  it('--strict fails on stale pages, a plain run only reports; stamping makes it pass', () => {
    const log = vi.fn<(m: string) => void>();
    const out = { log } as unknown as Console;
    write('boards.md', `${EN_BOARDS}\nMore.\n`);
    expect(main(['--locale', 'sv'], dir, out)).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('STALE     boards.md');
    expect(main(['--locale', 'sv', '--strict'], dir, out)).toBe(1);
    expect(main(['--stamp', 'boards.md', '--locale', 'sv'], dir, out)).toBe(0);
    fs.rmSync(path.join(dir, 'sv', 'old.md'));
    expect(main(['--locale', 'sv', '--strict'], dir, out)).toBe(0);
  });

  it('hashes the English text with normalised line ends', () => {
    expect(hashSource('a\r\nb')).toBe(hashSource('a\nb'));
    expect(hashSource('a')).not.toBe(hashSource('b'));
  });
});
