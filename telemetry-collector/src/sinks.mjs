/**
 * The two network sinks. The durable record is the lake spool (written first); VictoriaMetrics and Loki are best effort
 * behind a bounded in-memory retry queue: a failing sink never fails a post, a queue entry older than an hour is dropped
 * and counted. A 4xx answer (other than 408 and 429) means the sink rejected the data itself, so it is dropped, not retried.
 */
export function createSinks({ vmUrl, lokiUrl, fetchImpl = fetch, log, now = Date.now, retryMs = 30_000, maxAgeMs = 3_600_000, maxQueue = 2000, timeoutMs = 5000 }) {
  const stats = { delivered: { vm: 0, loki: 0 }, queued: { vm: 0, loki: 0 }, dropped: { vm: 0, loki: 0 }, failures: { vm: 0, loki: 0 } };
  /** @type {{ sink: 'vm' | 'loki', body: string, at: number }[]} */
  let queue = [];
  const targets = {
    vm: { url: () => `${vmUrl}/api/v1/import`, type: 'application/x-ndjson' },
    loki: { url: () => `${lokiUrl}/loki/api/v1/push`, type: 'application/json' },
  };

  async function attempt(item) {
    const target = targets[item.sink];
    try {
      const response = await fetchImpl(target.url(), {
        method: 'POST',
        headers: { 'content-type': target.type },
        body: item.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) return 'ok';
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        log?.warn('sink_rejected', { sink: item.sink, status: response.status });
        return 'drop';
      }
      log?.warn('sink_failed', { sink: item.sink, status: response.status });
      return 'retry';
    } catch (error) {
      log?.warn('sink_failed', { sink: item.sink, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network' });
      return 'retry';
    }
  }

  async function deliver(sink, body) {
    const item = { sink, body, at: now() };
    const result = await attempt(item);
    if (result === 'ok') { stats.delivered[sink] += 1; return 'ok'; }
    if (result === 'drop') { stats.dropped[sink] += 1; return 'dropped'; }
    stats.failures[sink] += 1;
    if (queue.length >= maxQueue) { queue.shift(); stats.dropped[sink] += 1; }
    queue.push(item);
    stats.queued[sink] += 1;
    return 'queued';
  }

  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      for (const item of queue.slice()) {
        let result = 'retry';
        if (now() - item.at > maxAgeMs) {
          result = 'old';
          log?.warn('sink_dropped_old', { sink: item.sink });
        } else {
          result = await attempt(item);
        }
        if (result === 'retry') continue;
        queue = queue.filter((other) => other !== item);
        if (result === 'ok') stats.delivered[item.sink] += 1;
        else stats.dropped[item.sink] += 1;
      }
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => { void drain(); }, retryMs);
  timer.unref?.();

  return {
    /** @returns {Promise<{ vm: string, loki: string }>} */
    async push({ vm, loki }) {
      const [vmResult, lokiResult] = await Promise.all([
        vm.length ? deliver('vm', vm.map((line) => JSON.stringify(line)).join('\n')) : 'skipped',
        loki.streams.length ? deliver('loki', JSON.stringify(loki)) : 'skipped',
      ]);
      return { vm: vmResult, loki: lokiResult };
    },
    drain,
    stats,
    get queueLength() { return queue.length; },
    close() { clearInterval(timer); },
  };
}
