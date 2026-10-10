import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, until, type Harness } from './mcp-harness';

// A relay that dies on its own must fail the waiting test at once with the relay's own output, not let each wait run
// out and every later request meet ECONNREFUSED (a Windows run lost 19 tests after one timeout).
let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('the MCP test harness', () => {
  it('fails a wait and a request at once when the relay dies by itself', async () => {
    h = createHarness({ accounts: true, settings: { MCP: 'on' } });
    await h.start();
    process.kill(h.relayPid()!, 'SIGKILL');
    const t0 = Date.now();
    await expect(until(() => false, 20_000)).rejects.toThrow(/relay exited with (SIGKILL|\d+)/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(h.api(undefined, 'GET', '/api/me')).rejects.toThrow(/relay exited with (SIGKILL|\d+)/);
  });

  it('does not treat stop() and a restart as a crash', async () => {
    h = createHarness({ accounts: true, settings: { MCP: 'on' } });
    await h.start();
    await h.stop();
    await h.start();
    let calls = 0;
    await until(() => ++calls > 3);
    expect((await h.api(undefined, 'GET', '/api/health')).status).toBeLessThan(500);
  });
});
