import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// Starts a relay a test talks to, on a port nobody holds, and says what happened when it does not come up: a relay that dies on
// start (a port that was taken between the probe and the bind, a bad setting) is reported at once with its own output, not as a
// 30 second "relay did not start" (docs/testing.md; run 38044216287 lost 30 s that way). A taken port is retried on a fresh one.

export type StartedRelay = { proc: ChildProcess; port: number; output: () => string };

export async function startRelayProcess({
  envFor,
  entry = 'server/relay.mjs',
  attempts = 3,
  startMs = RELAY_START_MS,
  spawnArgs = [],
  cwd,
  stdio = ['ignore', 'pipe', 'pipe'],
}: {
  /** The whole environment of the relay for this port. */
  envFor: (port: number) => Record<string, string>;
  /** The script to run (a test of this helper passes a stand-in). */
  entry?: string;
  attempts?: number;
  startMs?: number;
  spawnArgs?: string[];
  /** Preserve a test's working directory when the relay intentionally runs outside the repository. */
  cwd?: string;
  /** Preserve extra child channels such as the IPC channel used by shutdown tests. */
  stdio?: StdioOptions;
}): Promise<StartedRelay> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await freePort();
    const outcome = await new Promise<{ started: StartedRelay } | { error: Error; portTaken: boolean }>((resolve) => {
      const proc = spawn(process.execPath, [...spawnArgs, entry], { cwd, env: envFor(port), stdio });
      let output = '';
      let settled = false;
      const settle = (value: { started: StartedRelay } | { error: Error; portTaken: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        settle({ error: new Error(`relay did not start within ${startMs} ms: ${output.slice(-1500)}`), portTaken: false });
      }, startMs);
      const onData = (d: Buffer) => {
        output += String(d);
        if (/Tabula relay/.test(output)) settle({ started: { proc, port, output: () => output } });
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.on('error', (error) => settle({ error, portTaken: false }));
      proc.on('exit', (code, signal) => {
        settle({ error: new Error(`relay exited with ${code ?? signal} before it was listening: ${output.slice(-1500)}`), portTaken: /EADDRINUSE/.test(output) });
      });
    });
    if ('started' in outcome) return outcome.started;
    lastError = outcome.error;
    if (!outcome.portTaken) break; // only a taken port is worth another try
  }
  throw lastError ?? new Error('relay did not start');
}
