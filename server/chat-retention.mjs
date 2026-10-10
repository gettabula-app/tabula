// The retention job (docs/chat.md, Retention): once a day it deletes chat messages older than the workspace's "Keep chat
// messages" setting, with their mentions and reactions, in batches with a pause between them so it never holds the
// database for long. It writes one `chat.retention` audit row with counts only, never text.

import { readChatSettings } from './chat.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 1000;
/** The first run is a minute after the server starts, so a start never waits for a long delete. */
const FIRST_RUN_MS = 60_000;
/** Pause between batches, as a timer so other requests run in between. */
const PAUSE_MS = 20;

/**
 * @param {object} deps
 * @param {{ getSetting(key: string): string | null, audit(userId: string | null, action: string, detail?: object): unknown }} deps.directory
 * @param {() => ReturnType<typeof import('./chat.mjs').openChat>} deps.store the chat database, opened on first use
 * @param {() => boolean} [deps.paused] true while the workspace is being restored (the database must not be touched)
 * @param {(fn: () => unknown) => unknown} [deps.runWriter] holds a lease while a batch mutates the chat database
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.timers] false in tests: nothing is scheduled; call run() yourself
 * @param {number} [deps.batch]
 */
export function createChatRetention({ directory, store, paused = () => false, runWriter = (fn) => fn(), log = () => {}, now = Date.now, timers = true, batch = BATCH }) {
  let running = null;
  let first = null;
  let daily = null;

  /** One pass: deletes what the setting says is too old. Resolves to the number of messages removed (0 for "forever"). */
  async function run() {
    if (running) return running;
    running = (async () => {
      const days = readChatSettings(directory).retentionDays;
      if (days === null || paused()) return 0;
      const cutoff = now() - days * DAY_MS;
      let total = 0;
      try {
        for (;;) {
          if (paused()) break;
          const result = runWriter(() => store().purgeBefore(cutoff, batch));
          const n = result && typeof result.then === 'function' ? await result : result;
          total += n;
          if (n < batch) break;
          await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
        }
        if (total > 0) directory.audit(null, 'chat.retention', { days, removed: total });
      } catch (err) {
        log('chat: the retention job failed:', err?.message ?? 'error');
      }
      return total;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (!timers || first || daily) return;
    first = setTimeout(() => {
      first = null;
      void run();
      daily = setInterval(() => void run(), DAY_MS);
      daily.unref();
    }, FIRST_RUN_MS);
    first.unref();
  }

  function stop() {
    if (first) clearTimeout(first);
    if (daily) clearInterval(daily);
    first = null;
    daily = null;
  }

  return { run, start, stop };
}
