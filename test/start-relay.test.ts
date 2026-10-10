import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelayProcess } from './start-relay';

// The helper behind the relay-starting tests: a stand-in script plays the relay.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-relay-'));
const script = (name: string, body: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};
const live: { proc: { kill: (s?: NodeJS.Signals) => boolean } }[] = [];
afterEach(() => {
  for (const r of live.splice(0)) r.proc.kill('SIGKILL');
});

const env = (port: number) => ({ ...(process.env as Record<string, string>), PORT: String(port) });

describe('startRelayProcess', () => {
  it('resolves when the relay says it is listening, with the port it was given', async () => {
    const ok = script('ok.mjs', "console.log('Tabula relay on http://127.0.0.1:' + process.env.PORT); setInterval(() => {}, 1000);");
    const relay = await startRelayProcess({ envFor: env, entry: ok });
    live.push(relay);
    expect(relay.port).toBeGreaterThan(0);
    expect(relay.output()).toContain(`Tabula relay on http://127.0.0.1:${relay.port}`);
  });

  it('reports a relay that dies on start at once, with its own output, not after the start limit', async () => {
    const dies = script('dies.mjs', "console.error('bad setting: TABULA_X'); process.exit(3);");
    const t0 = Date.now();
    await expect(startRelayProcess({ envFor: env, entry: dies, startMs: 20_000 })).rejects.toThrow(/exited with 3 before it was listening: .*bad setting: TABULA_X/s);
    expect(Date.now() - t0).toBeLessThan(15_000); // a limit far above what a dead process needs; the old helper waited the whole start limit
  });

  it('says what the relay printed when it never listens, and stops it', async () => {
    const silent = script('silent.mjs', "console.log('starting...'); setInterval(() => {}, 1000);");
    await expect(startRelayProcess({ envFor: env, entry: silent, startMs: 600 })).rejects.toThrow(/did not start within 600 ms: starting/);
  });

  it('tries again on a fresh port when the port was taken, and gives up on any other failure', async () => {
    // the first attempt dies the way a relay does when its port is taken, the second one comes up
    const flaky = script('flaky.cjs', `
      const fs = require('node:fs');
      const marker = ${JSON.stringify(path.join(dir, 'tried-once'))};
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, '1');
        console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:' + process.env.PORT);
        process.exit(1);
      }
      console.log('Tabula relay on http://127.0.0.1:' + process.env.PORT);
      setInterval(() => {}, 1000);
    `.replace(/^\s+/gm, ''));
    const ports: number[] = [];
    const relay = await startRelayProcess({ envFor: (port) => { ports.push(port); return env(port); }, entry: flaky });
    live.push(relay);
    expect(ports).toHaveLength(2);
    expect(new Set(ports).size).toBe(2);

    const other = script('other.mjs', "console.error('Error: something else'); process.exit(1);");
    let tries = 0;
    await expect(startRelayProcess({ envFor: (port) => { tries++; return env(port); }, entry: other })).rejects.toThrow(/something else/);
    expect(tries).toBe(1);
  });
});
