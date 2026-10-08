import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../scripts/docs-markdown.mjs';

const render = (src: string) => renderMarkdown(src, { linkBase: '/docs/' }) as {
  title: string;
  html: string;
  headings: { level: number; text: string; id: string }[];
  text: string;
};

describe('docs markdown', () => {
  it('renders the title, paragraphs and inline formatting', () => {
    const r = render('# Boards\n\nA **bold**, *italic* and `code` line\nacross two lines.\n\nSecond paragraph.');
    expect(r.title).toBe('Boards');
    expect(r.html).toContain('<h1>Boards</h1>');
    expect(r.html).toContain('<p>A <strong>bold</strong>, <em>italic</em> and <code>code</code> line across two lines.</p>');
    expect(r.html).toContain('<p>Second paragraph.</p>');
    expect(r.text).toContain('A bold, italic and code line across two lines.');
  });

  it('gives headings slug ids, dedupes them and adds an anchor link', () => {
    const r = render('# T\n\n## Labels\n\n### Labels\n\n## Labels\n\n## Wow, a (heading)!');
    expect(r.headings.map((h) => h.id)).toEqual(['labels', 'labels-2', 'labels-3', 'wow-a-heading']);
    expect(r.headings.map((h) => h.level)).toEqual([2, 3, 2, 2]);
    expect(r.html).toContain('<h2 id="labels">Labels <a class="anchor" href="#labels"');
  });

  it('renders lists with one nested level', () => {
    const r = render('# T\n\n- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second');
    expect(r.html).toContain('<ul><li>one</li><li>two<ul><li>nested a</li><li>nested b</li></ul></li><li>three</li></ul>');
    expect(r.html).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders tables with a header row', () => {
    const r = render('# T\n\n| Key | Action |\n|---|---|\n| `Ctrl+Z` | Undo |\n| `C` | Comment |');
    expect(r.html).toContain('<table><thead><tr><th>Key</th><th>Action</th></tr></thead>');
    expect(r.html).toContain('<tr><td><code>Ctrl+Z</code></td><td>Undo</td></tr>');
    expect(r.html).toContain('class="table-wrap"');
  });

  it('renders blockquotes and fenced code', () => {
    const r = render('# T\n\n> Tip: save often.\n\n```json\n{ "a": "<b>" }\n```');
    expect(r.html).toContain('<blockquote><p>Tip: save often.</p></blockquote>');
    expect(r.html).toContain('<pre><code class="language-json">{ &quot;a&quot;: &quot;&lt;b&gt;&quot; }</code></pre>');
  });

  it('rewrites relative .md links and leaves others alone', () => {
    const r = render('# T\n\n[a](comments.md) [b](connectors.md#labels) [c](index.md) [d](https://example.com/x.md) [e](#top)');
    expect(r.html).toContain('<a href="/docs/comments">a</a>');
    expect(r.html).toContain('<a href="/docs/connectors#labels">b</a>');
    expect(r.html).toContain('<a href="/docs/">c</a>');
    expect(r.html).toContain('<a href="https://example.com/x.md" rel="noopener noreferrer">d</a>');
    expect(r.html).toContain('<a href="#top">e</a>');
  });

  it('renders images relative to the docs base', () => {
    const r = render('# T\n\n![Board](images/board.png)');
    expect(r.html).toContain('<img src="/docs/images/board.png" alt="Board" loading="lazy">');
  });

  it('escapes text', () => {
    const r = render('# A & B <i>\n\nx < y && "q" \'s\' > z');
    expect(r.title).toBe('A & B <i>');
    expect(r.html).toContain('<h1>A &amp; B &lt;i&gt;</h1>');
    expect(r.html).toContain('<p>x &lt; y &amp;&amp; &quot;q&quot; &#39;s&#39; &gt; z</p>');
  });

  it('escapes attribute values', () => {
    const r = render('# T\n\n[x](https://e.com/a"onmouseover="alert(1)) ![a"><script>](b"c.png)');
    expect(r.html).not.toContain('"onmouseover');
    expect(r.html).toContain('href="https://e.com/a&quot;onmouseover=&quot;alert(1"');
    expect(r.html).toContain('alt="a&quot;&gt;&lt;script&gt;"');
    expect(r.html).toContain('src="/docs/b&quot;c.png"');
    expect(r.html).not.toMatch(/<script/);
  });

  it('drops unsafe link and image URLs but keeps the text', () => {
    const r = render('# T\n\n[a](javascript:alert(1)) [b](JaVaScRiPt:x) [c](data:text/html,x) [d](vbscript:x) [e](//evil.com/x) [f](/\\evil.com) ![g](data:image/png;base64,AA)');
    expect(r.html).not.toContain('<a ');
    expect(r.html).not.toContain('<img');
    expect(r.html).not.toMatch(/javascript:|vbscript:|data:/);
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(r.text).toContain(t);
  });

  it('shows raw HTML as text', () => {
    const r = render('# T\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('strips HTML comments, including screenshot notes and multi-line ones', () => {
    const r = render('# T\n\nBefore.\n\n<!-- screenshot: the board menu -->\n\nMiddle <!-- inline --> text.\n\n<!--\nhidden\nlines\n-->\n\nAfter.');
    expect(r.html).not.toContain('screenshot');
    expect(r.html).not.toContain('hidden');
    expect(r.html).not.toContain('inline');
    expect(r.html).toContain('Middle  text.');
    expect(r.text).not.toContain('screenshot');
  });

  it('keeps comments that sit inside fenced code', () => {
    expect(render('# T\n\n```\n<!-- keep -->\n```').html).toContain('&lt;!-- keep --&gt;');
  });

  it('lists headings and text for search', () => {
    const r = render('# Polls\n\nRun a poll.\n\n## Results\n\nHidden until reveal.');
    expect(r.text).toContain('Run a poll.');
    expect(r.text).toContain('Hidden until reveal.');
    expect(r.headings).toEqual([{ level: 2, text: 'Results', id: 'results' }]);
  });
});
