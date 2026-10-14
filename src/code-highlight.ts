// Main-thread API of the code highlighter (docs/code-blocks.md). `highlightCode` returns coloured runs for a block's text, or null when the block should be
// drawn plain: plain text, text over MAX_CODE_CHARS, no Worker, a worker failure, or a block that already timed out this session.
// Tokenising runs in a module Web Worker, because a pathological grammar/input pair can backtrack inside one RegExp call that nothing in the tokenizer can
// interrupt. Requests go to the worker one at a time; a 1.5 s watchdog on the one in flight terminates the worker, starts a fresh one and remembers the
// (language, text hash) as unhighlightable for the session.
import { MAX_CODE_CHARS, isCodeLang } from '../shared/code-langs.mjs';
import { codeThemeFor } from './code-themes';
import { plainCodeLines, type CodeLines, type CodeThemeKey } from './code-tokens';
import { sha256Hex } from './sha256';
import type { WorkerReply, WorkerRequest } from './code-highlight.worker';

export const HIGHLIGHT_TIMEOUT_MS = 1500;
export const HIGHLIGHT_CACHE_SIZE = 64;
const UNHIGHLIGHTABLE_MAX = 256;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface HighlightRequest {
  /** A CODE_LANGS id. */
  lang: string;
  /** An app theme id ('default', 'ayu', ...), or the CodeThemeKey of a code theme. */
  theme: string | (CodeThemeKey & { ink?: string });
  text: string;
}

/** The part of a Worker the highlighter uses; tests inject a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((e: { data: WorkerReply }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror?: ((e: unknown) => void) | null;
}

export interface HighlighterOptions {
  /** Creates a worker, or null when there is none (tests, old browsers). */
  makeWorker?: () => WorkerLike | null;
  timeoutMs?: number;
  cacheSize?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface CodeHighlighter {
  highlight(req: HighlightRequest): Promise<CodeLines | null>;
  /** Drops the worker and the caches (tests). */
  dispose(): void;
}

interface Job {
  key: string;
  unKey: string;
  msg: Omit<WorkerRequest, 'id'>;
  resolve: (lines: CodeLines | null) => void;
  promise: Promise<CodeLines | null>;
}

function defaultMakeWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./code-highlight.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function resolveTheme(theme: HighlightRequest['theme']) {
  if (typeof theme === 'string') {
    const t = codeThemeFor(theme);
    return { id: t.id, shiki: t.shiki, surface: t.surface, ink: t.ink };
  }
  const known = codeThemeFor(null);
  return { id: `${theme.shiki}@${theme.surface}`, shiki: theme.shiki, surface: theme.surface, ink: theme.ink ?? known.ink };
}

export function createCodeHighlighter(opts: HighlighterOptions = {}): CodeHighlighter {
  const makeWorker = opts.makeWorker ?? defaultMakeWorker;
  const timeoutMs = opts.timeoutMs ?? HIGHLIGHT_TIMEOUT_MS;
  const cacheSize = opts.cacheSize ?? HIGHLIGHT_CACHE_SIZE;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  const cache = new Map<string, CodeLines>();
  const pending = new Map<string, Job>();
  const queue: Job[] = [];
  const unhighlightable = new Set<string>();
  let worker: WorkerLike | null = null;
  let current: { job: Job; id: number; timer: unknown } | null = null;
  let nextId = 1;
  let failures = 0;
  let disabled = false;

  function startWorker() {
    try {
      worker = makeWorker();
    } catch {
      worker = null;
    }
    if (!worker) return;
    const w = worker;
    w.onmessage = (e) => {
      if (w !== worker || !current || e.data.id !== current.id) return;
      const { job, timer } = current;
      clearTimer(timer);
      current = null;
      failures = 0;
      if (e.data.lines) remember(job.key, e.data.lines);
      job.resolve(e.data.lines);
      pump();
    };
    const crashed = () => {
      if (w !== worker) return;
      fail(false);
    };
    w.onerror = crashed;
    w.onmessageerror = crashed;
  }

  function remember(key: string, lines: CodeLines) {
    cache.delete(key);
    cache.set(key, lines);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value as string);
  }

  /** The job in flight got no answer: end it with null, replace the worker, and (for a timeout) never ask for that text again. */
  function fail(timedOut: boolean) {
    const cur = current;
    current = null;
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    if (cur) {
      clearTimer(cur.timer);
      if (timedOut) {
        if (unhighlightable.size >= UNHIGHLIGHTABLE_MAX) unhighlightable.delete(unhighlightable.values().next().value as string);
        unhighlightable.add(cur.job.unKey);
      }
      cur.job.resolve(null);
    }
    failures += 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES && !timedOut) disabled = true;
    if (!disabled) startWorker();
    pump();
  }

  function pump() {
    if (current) return;
    const job = queue.shift();
    if (!job) return;
    if (disabled || !worker) {
      if (!disabled && !worker) startWorker();
      if (disabled || !worker) {
        job.resolve(null);
        pump();
        return;
      }
    }
    const id = nextId++;
    const timer = setTimer(() => fail(true), timeoutMs);
    current = { job, id, timer };
    try {
      worker!.postMessage({ id, ...job.msg });
    } catch {
      fail(false);
    }
  }

  return {
    highlight(req) {
      const { lang, text } = req;
      if (lang === 'plaintext' || !isCodeLang(lang) || text.length > MAX_CODE_CHARS || disabled) return Promise.resolve(null);
      if (text === '') return Promise.resolve(plainCodeLines(text));
      const theme = resolveTheme(req.theme);
      const hash = sha256Hex(text);
      const unKey = `${lang}\n${hash}`;
      if (unhighlightable.has(unKey)) return Promise.resolve(null);
      const key = `${lang}\n${theme.id}\n${hash}`;
      const hit = cache.get(key);
      if (hit) {
        remember(key, hit);
        return Promise.resolve(hit);
      }
      const inFlight = pending.get(key);
      if (inFlight) return inFlight.promise;
      if (!worker) {
        startWorker();
        if (!worker) return Promise.resolve(null);
      }
      let resolve!: (lines: CodeLines | null) => void;
      const promise = new Promise<CodeLines | null>((r) => { resolve = r; });
      const job: Job = {
        key, unKey, resolve: (lines) => { pending.delete(key); resolve(lines); }, promise,
        msg: { lang, shiki: theme.shiki, surface: theme.surface, ink: theme.ink, text },
      };
      pending.set(key, job);
      queue.push(job);
      pump();
      return promise;
    },
    dispose() {
      if (current) clearTimer(current.timer);
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
      current = null;
      for (const job of queue.splice(0)) job.resolve(null);
      cache.clear();
      pending.clear();
      unhighlightable.clear();
    },
  };
}

let shared: CodeHighlighter | null = null;

/** Highlighted runs for a block, or null to draw it plain. Never rejects. The result is shared with the cache: do not modify it. */
export function highlightCode(req: HighlightRequest): Promise<CodeLines | null> {
  shared ??= createCodeHighlighter();
  return shared.highlight(req).catch(() => null);
}
