import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelayProcess, type StartedRelay } from './start-relay';

const WARNING = 'open mode (no accounts, no Origin check, unlimited rooms)';
let started: StartedRelay | null = null;
let dir = '';

async function start(host: string) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-openwarn-'));
  started = await startRelayProcess({
    envFor: (port) => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(port), HOST: host, DATA_DIR: path.join(dir, 'data'), DIST_DIR: dir };
      delete env.QUIET;
      delete env.TABULA_AUTH;
      return env;
    },
  });
  // The listen callback logs the warning, so give the output a moment to arrive.
  await new Promise((r) => setTimeout(r, 300));
  return started.output();
}

afterEach(async () => {
  if (started && started.proc.exitCode === null) {
    const exited = new Promise((r) => started!.proc.once('exit', r));
    started.proc.kill();
    await exited;
  }
  started = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('relay: open mode startup warning', () => {
  it('warns once when open mode listens on a non-loopback host', async () => {
    const out = await start('0.0.0.0');
    expect(out.split(WARNING).length - 1).toBe(1);
  });

  it('stays quiet on a loopback host', async () => {
    expect(await start('127.0.0.1')).not.toContain(WARNING);
  });
});
