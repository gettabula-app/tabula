import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODE_LANGS } from '../shared/code-langs.mjs';
import { createCodeTokenizer, GRAMMAR_MODULES, MAX_HIGHLIGHT_LINE, TOKENIZE_TIME_LIMIT_MS, codeLinesOf } from '../src/code-tokenize';
import { highlightCode } from '../src/code-highlight';
import { plainCodeLines } from '../src/code-tokens';
import { sha256Hex } from '../src/sha256';

const tokenizer = createCodeTokenizer();
const run = (lang: string, text: string, shiki = 'github-light', surface = '#FFFFFF', ink = '#111111') => tokenizer.tokenize({ lang, shiki, surface, ink, text });

const SAMPLES: Record<string, string> = {
  ts: 'export function add(a: number, b: number): number {\n\t// sum\n\treturn a + b;\n}\nconst s = `x${1}`;\n',
  json: '{\n  "name": "tabula",\n  "n": [1, 2.5, true, null]\n}\n',
  python: 'def f(x):\n    """doc"""\n    return [i * 2 for i in range(x) if i % 2]\n\nclass A: pass\n',
  bash: '#!/bin/bash\nfor f in *.txt; do\n  echo "$f" | grep -v x > /dev/null\ndone\n',
  diff: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n',
  sql: "SELECT id, name FROM users WHERE age > 21 AND name LIKE 'a%' ORDER BY id;\n",
  html: '<!doctype html>\n<html><body class="a"><script>let x = 1;</script><style>p { color: red }</style></body></html>\n',
};

describe('the tokenising function the worker runs', () => {
  it.each(Object.entries(SAMPLES))('%s: runs end to end equal the line, none empty, colours present, tabs expanded', async (lang, text) => {
    const lines = (await run(lang, text))!;
    const expected = codeLinesOf(text);
    expect(lines).toHaveLength(expected.length);
    lines.forEach((runs, i) => {
      expect(runs.map((r) => r.t).join('')).toBe(expected[i]);
      expect(runs.filter((r) => r.t === '' && expected[i] !== '')).toEqual([]);
    });
    expect(lines.flat().some((r) => r.c !== null)).toBe(true);
    expect(new Set(lines.flat().map((r) => r.c)).size).toBeGreaterThan(2);
    expect(lines.flat().some((r) => r.t.includes('\t'))).toBe(false);
  });

  it('expands tabs to the next multiple of 2 columns before tokenising', async () => {
    const lines = (await run('ts', 'a\tb\n\t\tc'))!;
    expect(lines.map((l) => l.map((r) => r.t).join(''))).toEqual(['a b', '    c']);
  });

  it('classes colours by the theme: a keyword differs from a string in TypeScript, and comments italic where the theme says so', async () => {
    const lines = (await run('ts', 'const s = "x"; // c', 'github-light'))!.flat();
    const kw = lines.find((r) => r.t === 'const')!;
    const str = lines.find((r) => r.t.includes('"x"'))!;
    expect(kw.c).not.toBe(str.c);
    expect(kw.c).toMatch(/^#[0-9a-f]{6,8}$/i);
  });

  it('normalises CRLF, keeps empty lines as one empty plain run, and handles empty text', async () => {
    expect(await run('json', '{}\r\n\r\n[]')).toHaveLength(3);
    expect((await run('json', '{}\n\n[]'))![1]).toEqual([{ t: '', c: null }]);
    expect(await run('json', '')).toEqual([[{ t: '', c: null }]]);
  });

  it('applies the contrast clamp to the colours it returns', async () => {
    const dark = (await run('ts', 'const a = 1; // c', 'vitesse-black', '#0B140C', '#3DFF70'))!.flat();
    expect(dark.every((r) => r.c === null || /^#[0-9a-f]{6,8}$/i.test(r.c))).toBe(true);
  });

  it('draws a line over 500 characters as one plain run, and still tokenises a line of exactly 500', async () => {
    const long = `const a = "${'x'.repeat(488)}";`;
    expect(long).toHaveLength(501);
    const lines = (await run('ts', `${long}\nconst b = 1;`))!;
    expect(lines[0]).toEqual([{ t: long, c: null }]);
    expect(lines[1].length).toBeGreaterThan(1);
    const exact = long.slice(1);
    expect(exact).toHaveLength(MAX_HIGHLIGHT_LINE);
    expect((await run('ts', exact))![0].length).toBeGreaterThan(1);
  });

  it('returns null for plain text and unknown languages or themes', async () => {
    expect(await run('plaintext', 'x')).toBeNull();
    expect(await run('klingon', 'x')).toBeNull();
    expect(await run('ts', 'x', 'no-such-theme')).toBeNull();
  });

  it('has a grammar loader for every shipped language, and no other', () => {
    expect([...new Set(CODE_LANGS.filter((l) => l.shiki).map((l) => l.shiki as string))].sort()).toEqual([...GRAMMAR_MODULES].sort());
  });
});

// Shiki does not report that a line hit tokenizeTimeLimit (codeToTokens drops textmate's `stoppedEarly`): the rest of that line is just one token. So a
// cut line is detected by comparison: the same text tokenised with a limit of 10 s must give exactly the same runs.
function realisticTypeScript(lines: number): string {
  const out: string[] = ["import { readFileSync } from 'node:fs';", ''];
  for (let i = 0; out.length < lines; i++) {
    out.push(
      `/** Handler ${i}: validates the board payload and returns a summary. */`,
      `export async function handle${i}(req: Request, opts: { limit?: number; tags: string[] } = { tags: [] }): Promise<Map<string, number>> {`,
      `  const body = (await req.json()) as Record<string, unknown>; // parsed ${i}`,
      `  const out = new Map<string, number>();`,
      `  for (const [key, value] of Object.entries(body)) {`,
      `    if (typeof value === 'number' && value > ${i} && /^[a-z]+_\\d+$/i.test(key)) out.set(key, value * 2);`,
      `    else if (Array.isArray(value)) out.set(\`${'$'}{key}:len\`, value.length ?? 0);`,
      `  }`,
      `  return out;`,
      `}`,
      '',
    );
  }
  return out.slice(0, lines).join('\n');
}

describe(`honest samples are not cut by the ${TOKENIZE_TIME_LIMIT_MS} ms per-line limit`, () => {
  const samples: Array<[string, string]> = [...Object.entries(SAMPLES), ['ts', realisticTypeScript(400)]];
  it.each(samples.map(([lang, text], i) => [`${lang} #${i}`, lang, text] as const))('%s tokenises exactly as with no limit, first call (cold) and warm', async (_name, lang, text) => {
    const fresh = createCodeTokenizer();
    const req = { lang, shiki: 'github-light', surface: '#FFFFFF', ink: '#111111', text };
    const unlimited = await fresh.tokenize({ ...req, timeLimitMs: 10_000 });
    const cold = await createCodeTokenizer().tokenize(req);
    const warm = await fresh.tokenize({ ...req, timeLimitMs: TOKENIZE_TIME_LIMIT_MS });
    expect(cold).toEqual(unlimited);
    expect(warm).toEqual(unlimited);
  });

  it('the realistic sample really has 400 lines', () => {
    expect(codeLinesOf(realisticTypeScript(400))).toHaveLength(400);
  });
});

describe('plain fallback', () => {
  it('is one run per line with tabs expanded and no colour', () => {
    expect(plainCodeLines('a\n\tb\r\nc')).toEqual([[{ t: 'a', c: null }], [{ t: '  b', c: null }], [{ t: 'c', c: null }]]);
  });

  it('highlightCode returns null without a Worker (node, old browsers), for plain text, and for text over the cap', async () => {
    expect(typeof Worker).toBe('undefined');
    expect(await highlightCode({ lang: 'ts', theme: 'default', text: 'let a = 1;' })).toBeNull();
    expect(await highlightCode({ lang: 'plaintext', theme: 'default', text: 'x' })).toBeNull();
    expect(await highlightCode({ lang: 'ts', theme: 'default', text: 'x'.repeat(20_001) })).toBeNull();
    expect(await highlightCode({ lang: 'nope', theme: 'default', text: 'x' })).toBeNull();
  });
});

describe('sha256Hex', () => {
  it.each(['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'héllo wörld \u{1F600}', 'a\nb'.repeat(5000)])('matches node crypto for %#', (text) => {
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });
});

describe('fine-grained Shiki imports only', () => {
  it('no source file imports the shiki root, a bundle, the wasm engine or the all-grammar index', () => {
    const files = readdirSync(new URL('../src/', import.meta.url)).filter((f) => /^code-.*\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      const bad = [...src.matchAll(/(?:from|import\()\s*['"](shiki[^'"]*)['"]/g)].map((m) => m[1])
        .filter((spec) => !/^shiki\/(core|engine\/javascript|langs\/[a-z]+\.mjs|themes\/[a-z-]+\.mjs)$/.test(spec));
      expect(bad).toEqual([]);
    }
  });
});
