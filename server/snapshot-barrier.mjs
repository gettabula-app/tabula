// A short write barrier around the local-copy phase of an off-site backup. Readers never consult the gate. Async writer
// handlers hold a lease for their full operation; synchronous database writes that cannot wait at their call site are
// queued and replayed after release.

import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_MAX_HOLD_MS = 5_000;
const TEST_CAPTURE_DELAY_MAX_MS = 60_000;

/** Test-only pause inside the capture window, so a relay test can send a websocket update during the hold. Throws unless NODE_ENV=test. */
export function testCaptureDelayMs(env = process.env) {
  const raw = env.TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS?.trim();
  if (!raw) return 0;
  if (env.NODE_ENV !== 'test') throw new Error('TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS is only available when NODE_ENV=test');
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > TEST_CAPTURE_DELAY_MAX_MS) {
    throw new Error(`TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS must be an integer between 1 and ${TEST_CAPTURE_DELAY_MAX_MS}`);
  }
  return ms;
}

export class SnapshotBarrierError extends Error {
  constructor(code = 'snapshot_timeout') {
    super(code === 'snapshot_timeout' ? 'The coherent snapshot exceeded its hold limit' : 'The snapshot barrier is already active');
    this.name = 'SnapshotBarrierError';
    this.code = code;
  }
}

/**
 * @param {{ maxHoldMs?: number, now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [options]
 */
export function createSnapshotBarrier({
  maxHoldMs = DEFAULT_MAX_HOLD_MS,
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
} = {}) {
  if (!Number.isSafeInteger(maxHoldMs) || maxHoldMs < 1) throw new RangeError('maxHoldMs must be a positive safe integer');

  /** @type {'open' | 'draining' | 'held'} */
  let phase = 'open';
  let activeWriters = 0;
  let privilegedDepth = 0;
  const writerContext = new AsyncLocalStorage();
  /** @type {Array<{ run: () => unknown, resolve: (value: unknown) => void, reject: (error: unknown) => void }>} */
  let deferred = [];
  /** @type {Array<() => void>} */
  let openWaiters = [];
  /** @type {Array<() => void>} */
  let drainedWaiters = [];
  /** @type {Set<() => void>} */
  const releaseListeners = new Set();

  const isBlocked = () => phase !== 'open';

  function waitForRelease() {
    if (!isBlocked()) return Promise.resolve();
    return new Promise((resolve) => openWaiters.push(resolve));
  }

  function writerFinished() {
    activeWriters--;
    if (activeWriters === 0) {
      const waiters = drainedWaiters;
      drainedWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  function runWriter(fn) {
    const parentLease = writerContext.getStore();
    if (parentLease?.active || phase === 'open') {
      // A handler that began before the barrier may finish its own awaited writes while the barrier drains. The async
      // context is per lease so unrelated requests still wait; a child lease is counted if the handler starts one.
      activeWriters++;
      const lease = { active: true };
      try {
        const result = writerContext.run(lease, fn);
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).finally(() => {
            lease.active = false;
            writerFinished();
          });
        }
        lease.active = false;
        writerFinished();
        return result;
      } catch (error) {
        lease.active = false;
        writerFinished();
        throw error;
      }
    }
    return (async () => {
      for (;;) {
        await waitForRelease();
        if (phase !== 'open') continue;
        return runWriter(fn);
      }
    })();
  }

  /** Run a synchronous flush that belongs before the snapshot point (notably Room.save and its directory touch). */
  function allowWrites(fn) {
    privilegedDepth++;
    try {
      return fn();
    } finally {
      privilegedDepth--;
    }
  }

  /** Defer a synchronous write at a call site whose API cannot await the gate. */
  function deferWrite(fn) {
    if (!isBlocked() || privilegedDepth > 0) return fn();
    const promise = new Promise((resolve, reject) => deferred.push({ run: fn, resolve, reject }));
    // Some synchronous directory methods have no way to return the delayed result; keep the queued write from creating
    // an unhandled rejection while preserving the rejection for callers that do await the transaction.
    promise.catch(() => {});
    return promise;
  }

  async function drainDeferred() {
    while (deferred.length) {
      const item = deferred.shift();
      try {
        const result = allowWrites(item.run);
        // Directory writes are synchronous. Avoid yielding between them so a newly released request cannot overtake
        // an earlier write that was deferred at a synchronous call site.
        if (result && typeof result.then === 'function') item.resolve(await result);
        else item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
    }
  }

  async function release() {
    // The local snapshot is already complete. Open the gate before replaying queued socket updates so this release
    // work cannot extend the bounded hold. JavaScript runs these synchronous listeners before another request callback.
    phase = 'open';
    const waiters = openWaiters;
    openWaiters = [];
    waiters.forEach((resolve) => resolve());
    // Relay rooms replay queued socket updates at the release edge, after the local files are complete.
    for (const listener of releaseListeners) {
      try {
        allowWrites(listener);
      } catch {
        /* a broken listener must never keep writers behind the barrier */
      }
    }
    await drainDeferred();
  }

  /**
   * Pauses writers, waits for existing async writes to finish, runs a synchronous flush, then captures all local files.
   * The hold timer includes draining existing writers and the complete local copy, and is always cleared in `finally`.
   * @param {{ prepare?: () => unknown, capture: (context: { signal: AbortSignal, startedAt: number }) => unknown }} options
   */
  async function withSnapshot({ prepare = () => {}, capture }) {
    while (phase !== 'open') await waitForRelease();
    phase = 'draining';
    const startedAt = now();
    const controller = new AbortController();
    let timer = null;
    let timeoutReject;
    const timeout = new Promise((_, reject) => { timeoutReject = reject; });
    timer = setTimer(() => {
      const error = new SnapshotBarrierError('snapshot_timeout');
      controller.abort(error);
      timeoutReject(error);
    }, maxHoldMs);

    const operation = (async () => {
      if (activeWriters > 0) await new Promise((resolve) => drainedWaiters.push(resolve));
      if (controller.signal.aborted) throw controller.signal.reason;
      phase = 'held';
      const prepared = allowWrites(prepare);
      if (prepared && typeof prepared.then === 'function') await prepared;
      if (controller.signal.aborted || now() - startedAt >= maxHoldMs) throw new SnapshotBarrierError('snapshot_timeout');
      const value = await capture({ signal: controller.signal, startedAt });
      if (controller.signal.aborted || now() - startedAt >= maxHoldMs) throw new SnapshotBarrierError('snapshot_timeout');
      return { value, startedAt, endedAt: Math.max(startedAt, now()) };
    })();
    // If timeout wins, the capture is still required to observe its AbortSignal and unwind its local worker/file reads.
    operation.catch(() => {});
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (controller.signal.reason?.code === 'snapshot_timeout') throw controller.signal.reason;
      throw error;
    } finally {
      if (timer !== null) clearTimer(timer);
      if (!controller.signal.aborted && operation) controller.abort();
      await release();
    }
  }

  return {
    maxHoldMs,
    get active() { return isBlocked(); },
    get holding() { return phase === 'held'; },
    get writesAllowed() { return privilegedDepth > 0 || writerContext.getStore()?.active === true; },
    waitForRelease,
    runWriter,
    allowWrites,
    deferWrite,
    withSnapshot,
    onRelease(listener) {
      releaseListeners.add(listener);
      return () => releaseListeners.delete(listener);
    },
  };
}
