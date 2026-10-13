import { describe, expect, it } from 'vitest';
import { inlineText, linkKind, markdownTitle, MD_MAX_SOURCE, parseInlineText, parseMarkdown, toggleTask, type Block, type Inline } from '../src/markdown';

// The Markdown block's parser (TAB-140): what it understands, and, as important, what it refuses.

const HASH = 'a'.repeat(64);
const para = (src: string): Inline[] => {
  const [b] = parseMarkdown(src);
  if (!b || b.t !== 'para') throw new Error(`not a paragraph: ${JSON.stringify(b)}`);
  return b.c;
};

describe('blocks', () => {
  it('reads headings 1 to 6, a heading with trailing hashes, and an empty heading; seven hashes are text', () => {
    const blocks = parseMarkdown('# One\n## Two ##\n###### Six\n#\n####### Seven');
    expect(blocks.map((b) => (b.t === 'heading' ? b.level : b.t))).toEqual([1, 2, 6, 1, 'para']);
    expect((blocks[1] as Extract<Block, { t: 'heading' }>).c).toEqual([{ t: 'text', s: 'Two' }]);
  });

  it('reads paragraphs, joining lines with a space and breaking on two trailing spaces or a backslash', () => {
    expect(para('one\ntwo')).toEqual([{ t: 'text', s: 'one two' }]);
    expect(para('one  \ntwo')).toEqual([{ t: 'text', s: 'one' }, { t: 'br' }, { t: 'text', s: 'two' }]);
    expect(para('one\\\ntwo')).toEqual([{ t: 'text', s: 'one' }, { t: 'br' }, { t: 'text', s: 'two' }]);
    expect(parseMarkdown('a\n\nb').map((b) => b.t)).toEqual(['para', 'para']);
  });

  it('reads bullet, numbered and task lists, nested, with the source line of each item', () => {
    const [list, ordered] = parseMarkdown('- [ ] open\n- [x] done\n  - child\n- plain\n\n3. three\n4. four') as [Extract<Block, { t: 'list' }>, Extract<Block, { t: 'list' }>];
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => [i.task, i.line])).toEqual([['open', 0], ['done', 1], [null, 3]]);
    const child = list.items[1].blocks[1] as Extract<Block, { t: 'list' }>;
    expect(child.items[0]).toMatchObject({ task: null, line: 2 });
    expect([ordered.ordered, ordered.start, ordered.items.length]).toEqual([true, 3, 2]);
  });

  it('reads quotes (nested, with a lazy line), fenced code (also unclosed), rules and tables', () => {
    expect(parseMarkdown('> a\n> > b\nlazy')[0]).toMatchObject({ t: 'quote' });
    expect(parseMarkdown('```ts\nlet a = 1;\n\nlet b = 2;\n```')[0]).toEqual({ t: 'code', lang: 'ts', s: 'let a = 1;\n\nlet b = 2;' });
    expect(parseMarkdown('```\nnever closed\n- not a list')[0]).toEqual({ t: 'code', lang: '', s: 'never closed\n- not a list' });
    expect(parseMarkdown('---\n***\n___').map((b) => b.t)).toEqual(['hr', 'hr', 'hr']);
    const [table] = parseMarkdown('| a | b |\n|:-:|--:|\n| 1 | 2 \\| x |\n| 3 |') as [Extract<Block, { t: 'table' }>];
    expect(table.align).toEqual(['center', 'right']);
    expect(table.head.map(inlineText)).toEqual(['a', 'b']);
    expect(table.rows.map((r) => r.map(inlineText))).toEqual([['1', '2 | x'], ['3', '']]);
  });

  it('does not read indented code, setext headings or HTML blocks: they stay text', () => {
    expect(parseMarkdown('    indented').map((b) => b.t)).toEqual(['para']);
    expect(parseMarkdown('Title\n=====')[0].t).toBe('para');
    expect(inlineText(para('<div onclick="x()">hi</div>'))).toBe('<div onclick="x()">hi</div>');
  });
});

describe('inline', () => {
  it('reads strong, emphasis, strikethrough, code and escapes, and leaves unmatched markers as text', () => {
    expect(para('**b** *i* _u_ __s__ ~~d~~')).toEqual([
      { t: 'strong', c: [{ t: 'text', s: 'b' }] }, { t: 'text', s: ' ' }, { t: 'em', c: [{ t: 'text', s: 'i' }] }, { t: 'text', s: ' ' },
      { t: 'em', c: [{ t: 'text', s: 'u' }] }, { t: 'text', s: ' ' }, { t: 'strong', c: [{ t: 'text', s: 's' }] }, { t: 'text', s: ' ' },
      { t: 'del', c: [{ t: 'text', s: 'd' }] },
    ]);
    expect(para('a * b and 2 * 3 and snake_case_name')).toEqual([{ t: 'text', s: 'a * b and 2 * 3 and snake_case_name' }]);
    expect(para('\\*not em\\* \\[x\\]')).toEqual([{ t: 'text', s: '*not em* [x]' }]);
    expect(para('use `a*b` and ``x`y``')).toEqual([{ t: 'text', s: 'use ' }, { t: 'code', s: 'a*b' }, { t: 'text', s: ' and ' }, { t: 'code', s: 'x`y' }]);
    expect(para('**bold *both* bold**')[0]).toEqual({ t: 'strong', c: [{ t: 'text', s: 'bold ' }, { t: 'em', c: [{ t: 'text', s: 'both' }] }, { t: 'text', s: ' bold' }] });
    expect(para('**unclosed')).toEqual([{ t: 'text', s: '**unclosed' }]);
  });

  it.each([
    ['https://example.com/a', 'web'], ['http://example.com', 'web'], ['HTTPS://EXAMPLE.COM/x?y=1#z', 'web'], ['mailto:me@example.com', 'mail'], ['#obj:abc_DEF-12', 'obj'],
  ] as const)('keeps %s as a %s link', (href, kind) => {
    expect(linkKind(href)).toBe(kind);
    expect(para(`[t](${href})`)).toEqual([{ t: 'link', href, kind, c: [{ t: 'text', s: 't' }] }]);
  });

  it.each([
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd',
    'ftp://example.com', '//example.com', '/relative', 'relative', '#', '#top', '#obj:', '#obj:' + 'a'.repeat(65), 'https://user:pass@example.com', 'https:///nohost',
    'mailto:', 'mailto:a b@c', 'https://example.com/\u0000', 'blob:https://example.com/x', 'about:blank',
  ])('drops the link for %j and keeps its text', (href) => {
    expect(linkKind(href)).toBeNull();
    const inline = para(`[click me](${href})`);
    expect(inline.some((n) => n.t === 'link')).toBe(false);
    expect(inlineText(inline)).toContain('click me');
  });

  it('does not take an address with a space in it: linkKind refuses it (the text after the space is a title)', () => {
    expect(linkKind('#obj:a b')).toBeNull();
    expect(linkKind('https://exa mple.com')).toBeNull();
  });

  it('never nests a link in a link, and keeps balanced parentheses in an address', () => {
    const nested = para('[a [b](https://x.test/b) c](https://x.test/a)');
    expect(JSON.stringify(nested)).not.toMatch(/"link".*"link"/s);
    expect(para('[w](https://en.wikipedia.org/wiki/A_(b))')[0]).toMatchObject({ t: 'link', href: 'https://en.wikipedia.org/wiki/A_(b)' });
  });

  it('reads a picture only from the board\'s own asset store; a picture on the internet becomes its alt text', () => {
    expect(para(`![a cat](asset:${HASH})`)).toEqual([{ t: 'image', alt: 'a cat', asset: HASH }]);
    for (const bad of ['https://evil.example/x.png', 'http://evil.example/x.png', 'data:image/png;base64,AAAA', 'asset:short', `asset:${HASH.toUpperCase()}`, '//evil.example/x.png', 'file:///x.png']) {
      const inline = para(`![alt text](${bad})`);
      expect(inline.some((n) => n.t === 'image')).toBe(false);
      expect(inlineText(inline)).toBe('[image: alt text]');
    }
  });

  it('never produces an element other than the ones in the type: a script, an iframe, a style and an event handler are only text', () => {
    const hostile = '<script>alert(1)</script><iframe src="https://evil.example"></iframe><style>*{display:none}</style><img src=x onerror=alert(1)><svg onload=alert(1)>&lt;b&gt;';
    const tree = parseMarkdown(hostile);
    const kinds = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.t === 'string') kinds.add(o.t);
        Object.values(o).forEach(walk);
      }
    };
    walk(tree);
    expect([...kinds].sort()).toEqual(['para', 'text']);
    expect(inlineText((tree[0] as Extract<Block, { t: 'para' }>).c)).toBe(hostile);
  });
});

describe('limits: nothing a person can type makes it slow or deep', () => {
  const time = (src: string) => {
    const t = performance.now();
    parseMarkdown(src);
    return performance.now() - t;
  };

  it.each([
    ['unmatched emphasis markers', '*a '.repeat(6000)],
    ['unmatched brackets and parentheses', '[a](b '.repeat(3000)],
    ['a thousand nested quotes', '> '.repeat(1000) + 'x'],
    ['deep list nesting', Array.from({ length: 300 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')],
    ['backticks', '`'.repeat(MD_MAX_SOURCE)],
    ['a long table', '| a | b |\n| - | - |\n' + '| 1 | 2 |\n'.repeat(3000)],
    ['many columns', `|${' a |'.repeat(500)}\n|${' - |'.repeat(500)}\n|${' 1 |'.repeat(500)}`],
    ['nested emphasis', '*_*_'.repeat(4000)],
  ])('reads %s in well under a second', (_name, src) => {
    expect(time(src)).toBeLessThan(1500);
  });

  it('cuts the source at MD_MAX_SOURCE characters, caps table size and list items, and stops nesting at a depth', () => {
    const long = parseMarkdown('x'.repeat(MD_MAX_SOURCE * 2))[0] as Extract<Block, { t: 'para' }>;
    expect(inlineText(long.c).length).toBe(MD_MAX_SOURCE);
    const [t] = parseMarkdown('| a | b |\n| - | - |\n' + '| 1 | 2 |\n'.repeat(400)) as [Extract<Block, { t: 'table' }>];
    expect(t.rows.length).toBeLessThanOrEqual(200);
    const wide = parseMarkdown(`|${' a |'.repeat(30)}\n|${' - |'.repeat(30)}`);
    expect(wide[0].t).toBe('para'); // more than 20 columns is not a table
    const depth = (b: Block, d = 0): number => (b.t === 'quote' ? Math.max(d, ...b.blocks.map((x) => depth(x, d + 1))) : b.t === 'list' ? Math.max(d, ...b.items.flatMap((i) => i.blocks.map((x) => depth(x, d + 1)))) : d);
    expect(Math.max(...parseMarkdown('> '.repeat(500) + 'x').map((b) => depth(b)))).toBeLessThanOrEqual(8);
  });

  it('never throws, whatever it is given', () => {
    for (const src of ['', '\u0000', '‮', '\ud800', '[', '](', '![](', '```', '|', '| - |', '- [', '\n\n\n', '\r\n\r\n', '\t- x', '1.', '1) ', '#'.repeat(5000), 'a'.repeat(10) + '\\']) {
      expect(() => parseMarkdown(src)).not.toThrow();
    }
    expect(() => parseMarkdown(undefined as unknown as string)).not.toThrow();
    expect(parseInlineText('')).toEqual([]);
  });
});

describe('helpers', () => {
  it('toggles the task box on the line the item says, and changes nothing else', () => {
    const src = '# T\n- [ ] one\n- [x] two\n* [X] three\n1. [ ] four\n- not a task [ ]\n  - [ ] child';
    expect(toggleTask(src, 1)).toBe('# T\n- [x] one\n- [x] two\n* [X] three\n1. [ ] four\n- not a task [ ]\n  - [ ] child');
    expect(toggleTask(src, 2).split('\n')[2]).toBe('- [ ] two');
    expect(toggleTask(src, 3).split('\n')[3]).toBe('* [ ] three');
    expect(toggleTask(src, 4).split('\n')[4]).toBe('1. [x] four');
    expect(toggleTask(src, 6).split('\n')[6]).toBe('  - [x] child');
    for (const line of [0, 5, 99, -1]) expect(toggleTask(src, line)).toBe(src);
    expect(toggleTask(toggleTask(src, 1), 1)).toBe(src);
  });

  it('finds the line of every task item the parser reports', () => {
    const src = 'text\n\n- [ ] a\n  - [x] b\n- [ ] c';
    const [, list] = parseMarkdown(src) as [Block, Extract<Block, { t: 'list' }>];
    expect(list.items.map((i) => i.line)).toEqual([2, 4]);
    expect((list.items[0].blocks[1] as Extract<Block, { t: 'list' }>).items[0].line).toBe(3);
    for (const line of [2, 3, 4]) expect(toggleTask(src, line)).not.toBe(src);
  });

  it('titles a block with its first heading or line, cut to a length', () => {
    expect(markdownTitle('# Plan for **May**\ntext')).toBe('Plan for May');
    expect(markdownTitle('\n\n- a\n- b')).toBe('a');
    expect(markdownTitle('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(markdownTitle('')).toBe('');
  });
});
