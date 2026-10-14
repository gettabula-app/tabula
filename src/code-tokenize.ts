// Code text to coloured runs, with Shiki (docs/code-blocks.md). This module has no worker or DOM code: the Web Worker (code-highlight.worker.ts) runs it
// off the main thread, and the tests and the ReDoS probe run the very same function in node.
// Only fine-grained Shiki entry points are imported (shiki/core, the JavaScript regex engine without WebAssembly, one module per grammar and per
// theme), each behind a dynamic import so the bundler emits one chunk each and a worker loads only what a block uses.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { CODE_LANGS } from '../shared/code-langs.mjs';
import { clampCodeColour } from './code-contrast';
import { expandTabs, type CodeLines, type CodeToken } from './code-tokens';

/** A line longer than this many characters is not tokenised: it is drawn plain (colour null). Grammars can cost quadratic time in one uninterruptible regex call on long lines. */
export const MAX_HIGHLIGHT_LINE = 500;
/** Shiki's own time limit per line, in milliseconds; honest lines take a few ms. A line that hits it is cut: the rest of it comes back as one token. */
export const TOKENIZE_TIME_LIMIT_MS = 50;
/**
 * The first block of a language in a fresh worker compiles its regular expressions while it tokenises, and its first lines would hit the 50 ms limit
 * (measured: the first 6 lines of a TypeScript block were cut). That first call gets this limit instead. A hostile first block is still bounded: the
 * main thread's 1.5 s watchdog ends the worker.
 */
export const TOKENIZE_COLD_TIME_LIMIT_MS = 1000;

type Module = { default: unknown };
// Literal specifiers, because the bundler can only split what it can read. Keep in step with shared/code-langs.mjs (test/code-highlight.test.ts checks).
const GRAMMARS: Readonly<Record<string, () => Promise<Module>>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
};

export const THEME_LOADERS: Readonly<Record<string, () => Promise<Module>>> = {
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'ayu-dark': () => import('shiki/themes/ayu-dark.mjs'),
  'kanagawa-wave': () => import('shiki/themes/kanagawa-wave.mjs'),
  'vitesse-black': () => import('shiki/themes/vitesse-black.mjs'),
};

export const GRAMMAR_MODULES: readonly string[] = Object.keys(GRAMMARS);

export interface TokenizeRequest {
  /** A CODE_LANGS id. */
  lang: string;
  /** A Shiki theme id from THEME_LOADERS. */
  shiki: string;
  /** The block's surface and the app's ink: the clamp's inputs. */
  surface: string;
  ink: string;
  text: string;
  /** Per-line time limit, replacing the default (50 ms, or 1 s on a language's first call); the tests use it to tell a cut line from an uncut one. */
  timeLimitMs?: number;
}

export interface CodeTokenizer {
  tokenize(req: TokenizeRequest): Promise<CodeLines | null>;
}

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

/** Normalise line ends and expand tabs: the text Shiki sees, so that runs equal the lines drawn. */
export function codeLinesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => expandTabs(line));
}

/** A tokenizer with its own lazily loaded highlighter. Each grammar and theme is imported on first use. */
export function createCodeTokenizer(): CodeTokenizer {
  let core: Promise<HighlighterCore> | null = null;
  const langs = new Map<string, Promise<void>>();
  const themes = new Map<string, Promise<void>>();
  const warm = new Set<string>();
  const highlighter = () => (core ??= createHighlighterCore({ engine: createJavaScriptRegexEngine({ forgiving: true }), themes: [], langs: [] }));
  const once = (map: Map<string, Promise<void>>, key: string, load: (h: HighlighterCore) => Promise<void>) => {
    let p = map.get(key);
    if (!p) {
      p = highlighter().then(load);
      p.catch(() => map.delete(key));
      map.set(key, p);
    }
    return p;
  };

  return {
    async tokenize({ lang, shiki, surface, ink, text, timeLimitMs }) {
      const entry = CODE_LANGS.find((l) => l.id === lang);
      const grammar = entry?.shiki ? GRAMMARS[entry.shiki] : undefined;
      const theme = THEME_LOADERS[shiki];
      if (!entry?.shiki || !grammar || !theme) return null;
      const h = await highlighter();
      await Promise.all([
        once(langs, entry.shiki, async (hl) => { await hl.loadLanguage((await grammar()).default as never); }),
        once(themes, shiki, async (hl) => { await hl.loadTheme((await theme()).default as never); }),
      ]);
      const limit = timeLimitMs ?? (warm.has(lang) ? TOKENIZE_TIME_LIMIT_MS : TOKENIZE_COLD_TIME_LIMIT_MS);
      warm.add(lang);
      const lines = codeLinesOf(text);
      const result = h.codeToTokens(lines.join('\n'), {
        lang: entry.shiki,
        theme: shiki,
        // Shiki skips lines of this length or more, so +1 keeps a line of exactly MAX_HIGHLIGHT_LINE highlighted
        tokenizeMaxLineLength: MAX_HIGHLIGHT_LINE + 1,
        tokenizeTimeLimit: limit,
      });
      const clamped = new Map<string, string | null>();
      const colour = (c: string | undefined) => {
        if (!c) return null;
        if (!clamped.has(c)) clamped.set(c, clampCodeColour(c, surface, ink));
        return clamped.get(c)!;
      };
      return lines.map((line, i): CodeToken[] => {
        const runs: CodeToken[] = [];
        for (const tok of result.tokens[i] ?? []) {
          if (!tok.content) continue;
          const run: CodeToken = { t: tok.content, c: colour(tok.color) };
          const fs = tok.fontStyle && tok.fontStyle > 0 ? tok.fontStyle : 0;
          if (fs & FONT_BOLD) run.b = 1;
          if (fs & FONT_ITALIC) run.i = 1;
          const last = runs[runs.length - 1];
          if (last && last.c === run.c && last.b === run.b && last.i === run.i) last.t += run.t;
          else runs.push(run);
        }
        if (line.length > MAX_HIGHLIGHT_LINE) return [{ t: line, c: null }];
        // The contract: runs end to end are the line. If Shiki ever disagrees, that line is drawn plain.
        if (runs.map((r) => r.t).join('') !== line) return [{ t: line, c: null }];
        return runs.length ? runs : [{ t: '', c: null }];
      });
    },
  };
}
