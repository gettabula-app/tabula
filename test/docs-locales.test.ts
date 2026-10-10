import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildDocsFiles, languageName, listLocales, loadLocalePages, loadUi } from '../scripts/vite-docs.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
write('index.md', '# Guide\n\n- [Boards](boards.md)\n- [Polls](polls.md)\n');
write('boards.md', '# Boards\n\nSee [polls](polls.md) and ![shot](images/a.png).\n');
write('polls.md', '# Polls\n\nA poll.\n');
write('sv/index.md', '# Guide på svenska\n\n- [Tavlor](boards.md)\n- [Omröstningar](polls.md)\n');
write('sv/boards.md', '# Tavlor\n\nSe [omröstningar](polls.md) och ![bild](images/a.png).\n');
write('sv/_ui.json', JSON.stringify({ menu: 'Meny', overview: 'Översikt', notTranslated: 'Sidan är inte översatt till {language} än.' }));
write('sv/_glossary.md', '# Ordlista\n');
write('xx-notes/readme.txt', 'not a locale');
write('de/index.md', '# Anleitung\n');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('guide locales', () => {
  it('a language is a folder of markdown named by its code; other folders are not languages', () => {
    expect(listLocales(dir)).toEqual(['de', 'sv']);
  });

  it('names a language in itself and reads its template strings with English as the fallback', () => {
    expect(languageName('sv')).toBe('Svenska');
    expect(languageName('de')).toBe('Deutsch');
    expect(loadUi('sv', dir).menu).toBe('Meny');
    expect(loadUi('sv', dir).docs).toBe('Docs');
    expect(loadUi('de', dir).menu).toBe('Menu');
  });

  it('lists every English page for a language, the untranslated ones as English fallbacks inside the language', () => {
    const pages = loadLocalePages('sv', dir);
    expect(pages.map((p) => [p.slug, p.fallback])).toEqual([['index', false], ['boards', false], ['polls', true]]);
    const polls = pages.find((p) => p.slug === 'polls')!;
    expect(polls.url).toBe('/docs/sv/polls');
    expect(polls.title).toBe('Polls');
    const boards = pages.find((p) => p.slug === 'boards')!;
    expect(boards.html).toContain('href="/docs/sv/polls"');
    expect(boards.html).toContain('src="/docs/images/a.png"');
  });

  it('builds each language under its own folder with a search index, and one English 404', () => {
    const files = new Map(buildDocsFiles(dir));
    for (const f of ['docs/index.html', 'docs/boards/index.html', 'docs/search.json', 'docs/404.html', 'docs/sv/index.html', 'docs/sv/boards/index.html', 'docs/sv/polls/index.html', 'docs/sv/search.json', 'docs/de/polls/index.html']) {
      expect(`${f} ${files.has(f)}`).toBe(`${f} true`);
    }
    expect(files.has('docs/sv/404.html')).toBe(false);
    const sv = JSON.parse(String(files.get('docs/sv/search.json'))) as { url: string; title: string }[];
    expect(sv.map((e) => e.url)).toContain('/docs/sv/boards');
    expect(sv.find((e) => e.url === '/docs/sv/boards')!.title).toBe('Tavlor');
  });

  it('marks the language, offers the switcher and the translated alternates, and says when a page is not translated', () => {
    const files = new Map(buildDocsFiles(dir));
    const boards = String(files.get('docs/sv/boards/index.html'));
    expect(boards).toContain('<html lang="sv">');
    expect(boards).toContain('<nav class="docs-lang" aria-label="Language">');
    expect(boards).toContain('hreflang="en" lang="en">English');
    expect(boards).toContain('href="/docs/sv/boards" hreflang="sv" lang="sv" aria-current="true">Svenska');
    expect(boards).toContain('<link rel="alternate" hreflang="en" href="/docs/boards">');
    expect(boards).toContain('<link rel="alternate" hreflang="sv" href="/docs/sv/boards">');
    expect(boards).toContain('<link rel="alternate" hreflang="x-default" href="/docs/boards">');
    expect(boards).not.toContain('docs-fallback');
    expect(boards).toContain('>Meny</button>');
    const polls = String(files.get('docs/sv/polls/index.html'));
    expect(polls).toContain('<p class="docs-fallback" role="note">Sidan är inte översatt till Svenska än.</p>');
    expect(polls).toContain('<div lang="en">');
    expect(polls).toContain('<link rel="canonical" href="/docs/polls">');
    expect(polls).not.toContain('hreflang="sv" href');
    const en = String(files.get('docs/boards/index.html'));
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('<link rel="alternate" hreflang="sv" href="/docs/sv/boards">');
  });

  it('shows no switcher while there is only one language', () => {
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'guide1-'));
    fs.writeFileSync(path.join(only, 'index.md'), '# Guide\n');
    const files = new Map(buildDocsFiles(only));
    fs.rmSync(only, { recursive: true, force: true });
    expect(String(files.get('docs/index.html'))).not.toContain('docs-lang');
  });
});
