import type { TrackerApi } from '../../tracker-data';

export function createUnreadPoller(opts: {
  api: TrackerApi;
  intervalMs?: number;
  onChange(n: number): void;
}): { start(): void; stop(): void; refresh(): Promise<void> } {
  return {
    start() {},
    stop() {},
    async refresh() { opts.onChange(0); },
  };
}
