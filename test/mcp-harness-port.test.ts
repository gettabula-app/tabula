import net from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The first port the harness asks for is held by this test, as another test process would hold it between the probe and the bind.
const held: { server: net.Server | null; port: number } = { server: null, port: 0 };
const queue: number[] = [];

vi.mock('./free-port', async () => {
  const real = await vi.importActual<typeof import('./free-port')>('./free-port');
  return { freePort: async () => (queue.length ? queue.shift()! : real.freePort()) };
});

const { createHarness } = await import('./mcp-harness');

describe('mcp harness port', () => {
  afterAll(async () => { await new Promise<void>((resolve) => (held.server ? held.server.close(() => resolve()) : resolve())); });

  it('retries the first start on a fresh port when the chosen one is taken', async () => {
    held.server = net.createServer();
    await new Promise<void>((resolve) => held.server!.listen(0, '127.0.0.1', resolve));
    held.port = (held.server.address() as net.AddressInfo).port;
    queue.push(held.port);
    const h = createHarness();
    try {
      await h.start();
      expect(h.port).not.toBe(held.port);
      const res = await fetch(`${h.base}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it('does not replace a port the test chose itself', async () => {
    const h = createHarness({ port: held.port });
    try {
      await expect(h.start()).rejects.toThrow(/relay exited/);
      expect(h.port).toBe(held.port);
    } finally {
      await h.cleanup();
    }
  });
});
