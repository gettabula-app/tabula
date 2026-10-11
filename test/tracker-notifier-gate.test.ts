import { describe, expect, it } from 'vitest';
import { createTrackerNotifier } from '../server/tracker/outbox.mjs';

describe('tracker restore pauses notification delivery', () => {
  it('skips both due-soon scans and email delivery while the gate is closed', async () => {
    let sends = 0;
    const notifier = createTrackerNotifier({
      directory: {} as never,
      mailer: { async send() { sends++; } },
      baseUrl: 'https://tabula.test',
      paused: () => true,
      timers: false,
    });

    await expect(notifier.tick()).resolves.toEqual({ created: 0, sent: 0, failed: 0, skipped: 1 });
    expect(sends).toBe(0);
  });
});
