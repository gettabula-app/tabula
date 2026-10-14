import { describe, expect, it, vi } from 'vitest';
import { createCodeHighlighter, type WorkerLike } from '../src/code-highlight';
import type { WorkerReply, WorkerRequest } from '../src/code-highlight.worker';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  terminated = false;
  received: WorkerRequest[] = [];
  postMessage(m: WorkerRequest) { this.received.push(m); }
  terminate() { this.terminated = true; }
  reply(id: number, lines: WorkerReply['lines']) { this.onmessage?.({ data: { id, lines } }); }
}

function setup() {
  const workers: FakeWorker[] = [];
  const hl = createCodeHighlighter({ makeWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, timeoutMs: 1500 });
  return { hl, workers };
}
const lines = (t: string) => [[{ t, c: '#000000' }]];
const ask = (hl: ReturnType<typeof setup>['hl'], text: string, lang = 'ts', theme = 'default') => hl.highlight({ lang, theme, text });

describe('code highlighter watchdog and cache', () => {
  it('sends the app theme as Shiki theme, surface and ink, and caches the answer by (lang, theme, text)', async () => {
    const { hl, workers } = setup();
    const p = ask(hl, 'let a', 'ts', 'ayu');
    expect(workers[0].received[0]).toMatchObject({ lang: 'ts', shiki: 'ayu-dark', surface: '#272D38', ink: '#CCCAC2', text: 'let a' });
    workers[0].reply(workers[0].received[0].id, lines('let a'));
    expect(await p).toEqual(lines('let a'));
    expect(await ask(hl, 'let a', 'ts', 'ayu')).toEqual(lines('let a'));
    expect(workers[0].received).toHaveLength(1);
    const other = ask(hl, 'let a', 'ts', 'matrix');
    expect(workers[0].received).toHaveLength(2);
    workers[0].reply(workers[0].received[1].id, lines('x'));
    await other;
  });

  it('keeps one request in flight per key and sends only one request at a time', async () => {
    const { hl, workers } = setup();
    const a = ask(hl, 'one');
    const b = ask(hl, 'one');
    const c = ask(hl, 'two');
    expect(a).toBe(b);
    expect(workers[0].received).toHaveLength(1);
    workers[0].reply(workers[0].received[0].id, lines('one'));
    await a;
    expect(workers[0].received).toHaveLength(2);
    workers[0].reply(workers[0].received[1].id, lines('two'));
    expect(await c).toEqual(lines('two'));
  });

  it('on timeout terminates the worker, starts a fresh one, answers null and remembers the (lang, text) as unhighlightable', async () => {
    vi.useFakeTimers();
    try {
      const { hl, workers } = setup();
      const hostile = ask(hl, 'evil input');
      const queued = ask(hl, 'fine input');
      vi.advanceTimersByTime(1499);
      expect(workers[0].terminated).toBe(false);
      vi.advanceTimersByTime(2);
      expect(await hostile).toBeNull();
      expect(workers[0].terminated).toBe(true);
      expect(workers).toHaveLength(2);
      // the queued request moved to the fresh worker and is answered normally
      expect(workers[1].received[0].text).toBe('fine input');
      workers[1].reply(workers[1].received[0].id, lines('fine input'));
      expect(await queued).toEqual(lines('fine input'));
      expect(workers[1].terminated).toBe(false);
      // the hostile text is null at once, without a worker round trip; the same text in another language is still tried
      expect(await ask(hl, 'evil input')).toBeNull();
      expect(await ask(hl, 'evil input', 'ts', 'ayu')).toBeNull();
      expect(workers[1].received).toHaveLength(1);
      void ask(hl, 'evil input', 'js');
      expect(workers[1].received).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale answers from a terminated worker and keeps the worker alive on success', async () => {
    vi.useFakeTimers();
    try {
      const { hl, workers } = setup();
      const p = ask(hl, 'slow');
      const staleId = workers[0].received[0].id;
      vi.advanceTimersByTime(1600);
      expect(await p).toBeNull();
      workers[0].reply(staleId, lines('late'));
      const q = ask(hl, 'next');
      workers[1].reply(workers[1].received[0].id, lines('next'));
      expect(await q).toEqual(lines('next'));
      vi.advanceTimersByTime(10_000);
      expect(workers[1].terminated).toBe(false);
      expect(workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers null when the worker errors, and gives up after repeated crashes', async () => {
    const { hl, workers } = setup();
    for (let i = 0; i < 3; i++) {
      const p = ask(hl, `crash ${i}`);
      workers[i].onerror?.(new Error('boom'));
      expect(await p).toBeNull();
    }
    expect(await ask(hl, 'after')).toBeNull();
  });

  it('answers null when there is no worker to make', async () => {
    const hl = createCodeHighlighter({ makeWorker: () => null });
    expect(await hl.highlight({ lang: 'ts', theme: 'default', text: 'x' })).toBeNull();
  });

  it('bounds the cache at 64 entries (least recently used goes first)', async () => {
    const { hl, workers } = setup();
    const w = () => workers[0];
    for (let i = 0; i < 65; i++) {
      const p = ask(hl, `t${i}`);
      w().reply(w().received[i].id, lines(`t${i}`));
      await p;
    }
    expect(w().received).toHaveLength(65);
    await ask(hl, 't64');
    expect(w().received).toHaveLength(65);
    void ask(hl, 't0');
    expect(w().received).toHaveLength(66);
  });
});
