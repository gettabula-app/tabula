// Connects the code highlighter (src/code-highlight.ts, Shiki on a worker) to the board (docs/code-blocks.md, the seam in src/code-markup.ts).
//   - The token source answers synchronously from a per-board cache, and only when the cached tokens were made for the block's current language, the current
//     app theme and exactly its current text (key `${lang}|${theme}|${sha256(text)}`). Anything else is null: the block is drawn as plain ink.
//   - Tokens are requested for blocks in or near the viewport (one viewport of margin each way), never while a block is being typed in, 250 ms after the text
//     last changed, one request at a time, when the browser is idle. A result for a key that is no longer current is dropped. Then `requestRepaint()`.
//   - Plain text and blocks over MAX_CODE_CHARS never ask. A null answer (no Worker, worker failure, watchdog) is remembered for that key: no retry loop.
import { MAX_CODE_CHARS, isCodeLang } from '../shared/code-langs.mjs';
import type { BoardApp } from './app';
import { highlightCode, type HighlightRequest } from './code-highlight';
import { requestRepaint, setCodeTokenSource } from './code-markup';
import type { CodeLines } from './code-tokens';
import { sha256Hex } from './sha256';
import { getStoredTheme, onThemeChange } from './themes';
import type { BaseObj, Rect } from './types';

export const GLUE_CACHE_SIZE = 200;
export const GLUE_SCAN_THROTTLE_MS = 100;
export const GLUE_TEXT_DEBOUNCE_MS = 250;

export interface GlueDeps {
  /** Every object of the board (the glue picks the code blocks). */
  objects(): Iterable<BaseObj>;
  viewport(): Rect;
  themeId(): string;
  /** The block being typed in, if any. */
  editingId(): string | null;
  highlight(req: HighlightRequest): Promise<CodeLines | null>;
  repaint(): void;
  setTokenSource(fn: ((o: BaseObj) => CodeLines | null) | null): void;
  /** Each subscribe returns its unsubscribe. */
  onCamera(fn: () => void): () => void;
  onTheme(fn: () => void): () => void;
  onObjects(fn: (ids: ReadonlySet<string>) => void): () => void;
  onEditing(fn: () => void): () => void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** Runs fn when the browser is idle; returns a cancel function. */
  idle(fn: () => void): () => void;
}

interface Entry { key: string; lines: CodeLines }

/** Keeps at most `max` entries, dropping the least recently set. */
function setBounded<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

export function createCodeHighlightGlue(deps: GlueDeps): () => void {
  const cache = new Map<string, Entry>();
  const hashes = new Map<string, { text: string; hash: string }>();
  const lastText = new Map<string, string>();
  const dueAt = new Map<string, number>();
  const failed = new Map<string, string>();
  let inFlight: string | null = null;
  let cancelIdle: (() => void) | null = null;
  let scanTimer: unknown = null;
  let scanAt = 0;
  let lastScan = -Infinity;
  let queue: string[] = [];
  let stopped = false;

  const eligible = (o: BaseObj): boolean => {
    const { lang, text } = o as { lang?: unknown; text?: unknown };
    return typeof lang === 'string' && lang !== 'plaintext' && isCodeLang(lang) && typeof text === 'string' && text !== '' && text.length <= MAX_CODE_CHARS;
  };

  /** The cache key of the block as it is now, or null when it is never highlighted. The hash is kept per object, by text identity. */
  function keyOf(o: BaseObj): string | null {
    if (!eligible(o)) return null;
    const text = (o as { text: string }).text;
    let h = hashes.get(o.id);
    if (!h || h.text !== text) {
      h = { text, hash: sha256Hex(text) };
      setBounded(hashes, o.id, h, GLUE_CACHE_SIZE);
    }
    return `${(o as { lang: string }).lang}|${deps.themeId()}|${h.hash}`;
  }

  deps.setTokenSource((o) => {
    const e = cache.get(o.id);
    if (!e) return null;
    return keyOf(o) === e.key ? e.lines : null;
  });

  function near(o: BaseObj, vp: Rect): boolean {
    return o.x < vp.x + vp.w * 2 && o.x + o.w > vp.x - vp.w && o.y < vp.y + vp.h * 2 && o.y + o.h > vp.y - vp.h;
  }

  function scheduleScan(delay: number): void {
    if (stopped) return;
    const at = deps.now() + delay;
    if (scanTimer !== null) {
      if (scanAt <= at) return;
      deps.clearTimer(scanTimer);
    }
    scanAt = at;
    scanTimer = deps.setTimer(() => { scanTimer = null; scan(); }, delay);
  }

  /** Throttled trigger: at most one scan per GLUE_SCAN_THROTTLE_MS. */
  const poke = () => scheduleScan(Math.max(0, lastScan + GLUE_SCAN_THROTTLE_MS - deps.now()));

  function scan(): void {
    if (stopped) return;
    lastScan = deps.now();
    const vp = deps.viewport();
    const editing = deps.editingId();
    const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
    const want: { id: string; d: number }[] = [];
    let soonest = Infinity;
    for (const o of deps.objects()) {
      if (o.type !== 'code') continue;
      if (o.id === editing || !near(o, vp)) continue;
      const key = keyOf(o);
      if (key === null || cache.get(o.id)?.key === key || failed.get(o.id) === key) continue;
      const due = dueAt.get(o.id) ?? 0;
      if (due > lastScan) { soonest = Math.min(soonest, due); continue; }
      want.push({ id: o.id, d: Math.hypot(o.x + o.w / 2 - cx, o.y + o.h / 2 - cy) });
    }
    want.sort((a, b) => a.d - b.d);
    queue = want.map((w) => w.id);
    if (soonest < Infinity) scheduleScan(soonest - lastScan);
    pump();
  }

  function pump(): void {
    if (stopped || inFlight !== null || cancelIdle || queue.length === 0) return;
    cancelIdle = deps.idle(() => {
      cancelIdle = null;
      run();
    });
  }

  function run(): void {
    if (stopped || inFlight !== null) return;
    const store = new Map<string, BaseObj>();
    for (const o of deps.objects()) if (o.type === 'code') store.set(o.id, o);
    while (queue.length) {
      const id = queue.shift() as string;
      const o = store.get(id);
      if (!o || id === deps.editingId() || !near(o, deps.viewport())) continue;
      const key = keyOf(o);
      if (key === null || cache.get(id)?.key === key || failed.get(id) === key) continue;
      inFlight = id;
      let p: Promise<CodeLines | null>;
      try {
        p = deps.highlight({ lang: (o as { lang: string }).lang, theme: deps.themeId(), text: (o as { text: string }).text });
      } catch {
        p = Promise.resolve(null);
      }
      void p.then((lines) => lines, () => null).then((lines) => {
        if (stopped) return;
        inFlight = null;
        let cur: BaseObj | undefined;
        for (const x of deps.objects()) if (x.id === id) { cur = x; break; }
        if (cur && keyOf(cur) === key) {
          if (lines) { setBounded(cache, id, { key, lines }, GLUE_CACHE_SIZE); deps.repaint(); }
          else setBounded(failed, id, key, GLUE_CACHE_SIZE);
        }
        // the block changed under the request: a new scan decides what is wanted now
        if (queue.length) pump();
        else poke();
      });
      return;
    }
  }

  const unsubs = [
    deps.onCamera(poke),
    deps.onTheme(() => {
      // tokens made for the old theme stop matching at once; draw those blocks plain until the new ones arrive
      deps.repaint();
      poke();
    }),
    deps.onEditing(poke),
    deps.onObjects((ids) => {
      const live = new Map<string, BaseObj>();
      for (const o of deps.objects()) if (ids.has(o.id) && o.type === 'code') live.set(o.id, o);
      for (const id of ids) {
        const o = live.get(id);
        if (!o) {
          cache.delete(id); hashes.delete(id); lastText.delete(id); dueAt.delete(id); failed.delete(id);
          continue;
        }
        const text = (o as { text?: unknown }).text;
        const prev = lastText.get(id);
        if (typeof text === 'string' && prev !== undefined && prev !== text) dueAt.set(id, deps.now() + GLUE_TEXT_DEBOUNCE_MS);
        if (typeof text === 'string') setBounded(lastText, id, text, GLUE_CACHE_SIZE);
      }
      poke();
    }),
  ];
  for (const o of deps.objects()) {
    const text = (o as { text?: unknown }).text;
    if (o.type === 'code' && typeof text === 'string') setBounded(lastText, o.id, text, GLUE_CACHE_SIZE);
  }
  scheduleScan(0);

  return () => {
    stopped = true;
    for (const u of unsubs) u();
    if (scanTimer !== null) deps.clearTimer(scanTimer);
    scanTimer = null;
    cancelIdle?.();
    cancelIdle = null;
    queue = [];
    cache.clear(); hashes.clear(); lastText.clear(); dueAt.clear(); failed.clear();
    deps.setTokenSource(null);
  };
}

type IdleWindow = { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

function idleIn(fn: () => void): () => void {
  const w = globalThis as IdleWindow;
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout: 500 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

/** Starts the highlighter glue for this board; the returned function stops it (timers, listeners, the token source). */
export function initCodeHighlight(app: BoardApp): () => void {
  return createCodeHighlightGlue({
    objects: () => app.store.cache.values() as Iterable<BaseObj>,
    viewport: () => app.r.viewport(),
    themeId: () => (typeof document !== 'undefined' && document.documentElement.dataset.theme) || getStoredTheme(),
    editingId: () => app.editor.editingId,
    highlight: highlightCode,
    repaint: requestRepaint,
    setTokenSource: setCodeTokenSource,
    onCamera: (fn) => app.r.onCamera(fn) as () => void,
    onTheme: (fn) => onThemeChange(fn),
    onObjects: (fn) => app.store.onChange((ids) => fn(ids)),
    onEditing: (fn) => app.on('editing', fn),
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    idle: idleIn,
  });
}
