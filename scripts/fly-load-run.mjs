#!/usr/bin/env node
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  defaultFlyLoadSlug,
  hasFlyLoadGoPhrase,
  makeFlyLoadPlan,
} from './lib/fly-load-plan.mjs';
import {
  parseManualMetric,
  redactFlyLoadText,
  runFlyLoad,
} from './lib/fly-load-runner.mjs';

function envPlan(env, now = Date.now()) {
  return makeFlyLoadPlan({
    now,
    slug: env.FLY_LOAD_SLUG || defaultFlyLoadSlug(now),
    domain: env.FLY_LOAD_DOMAIN || 'gettabula.app',
    region: env.FLY_LOAD_REGION || 'eu',
  });
}

async function askMetric(rl, label, signal) {
  while (true) {
    const value = await rl.question(`${label} (blank if unavailable): `, { signal });
    try { return parseManualMetric(value.trim()); } catch {
      process.stdout.write('Enter a non-negative number or leave it blank.\n');
    }
  }
}

function readHiddenSession(label, signal, onInterrupt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('This run needs an interactive terminal to enter the owner session after workspace creation; provide TARGET_COOKIES or TARGET_LOGIN_TOKENS in the environment instead.'));
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';
    let finished = false;
    const restore = () => {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      input.setRawMode(wasRaw ?? false);
      process.stdout.write('\n');
    };
    const onAbort = () => {
      restore();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Fly load run aborted'));
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') {
          const error = new Error('Fly load run interrupted by Ctrl-C; tearing down the comp workspace.');
          onInterrupt(error);
          restore();
          reject(error);
          return;
        }
        if (char === '\r' || char === '\n') {
          restore();
          resolve(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    process.stdout.write(label);
    input.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function main() {
  const env = process.env;
  const plan = envPlan(env);
  const runAuthorized = hasFlyLoadGoPhrase(env.FLY_LOAD_GO, plan.slug);
  const abortController = new AbortController();
  let signalCode = null;
  const onSigint = () => {
    signalCode = 130;
    abortController.abort(new Error('Fly load run interrupted by Ctrl-C; tearing down the comp workspace.'));
  };
  const onSigterm = () => {
    signalCode = 143;
    abortController.abort(new Error('Fly load run interrupted by SIGTERM; tearing down the comp workspace.'));
  };
  let rl = null;

  if (runAuthorized) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  try {
    await runFlyLoad({
      plan,
      env,
      output: (line) => process.stdout.write(`${line}\n`),
      ...(runAuthorized ? {
        signal: abortController.signal,
        getTargetSession: async ({ env: runEnv, signal }) => {
          if (runEnv.TARGET_COOKIES || runEnv.TARGET_LOGIN_TOKENS) return {};
          rl.close();
          process.stdout.write(`Workspace is active at ${plan.targetUrl}. Sign in as its owner, then provide the session. The entry is hidden and will not be printed.\n`);
          const credential = await readHiddenSession(
            'Paste TARGET_COOKIES or TARGET_LOGIN_TOKENS, then press Enter: ',
            signal,
            (error) => {
              signalCode = 130;
              if (!abortController.signal.aborted) abortController.abort(error);
            },
          );
          if (!credential) throw new Error('An owner session is required');
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          return credential.includes('=')
            ? { TARGET_COOKIES: credential }
            : { TARGET_LOGIN_TOKENS: credential };
        },
        manualCheckpoint: async ({ size, index, previousSize, signal }) => {
          if (index === 0) {
            process.stdout.write(`Verify in the Fly dashboard that the new workspace machine is ${size.machineSize} / ${size.memoryMb} MB.\n`);
          } else {
            process.stdout.write(`Change the machine manually to ${size.machineSize} / ${size.memoryMb} MB, then verify it in the Fly dashboard.\n`);
            process.stdout.write(`Previous size: ${previousSize.machineSize}. No machine resize route is documented in the cloud admin API.\n`);
          }
          await rl.question('Press Enter after the machine size is verified: ', { signal });
        },
        collectMetrics: async ({ size, users, signal }) => {
          process.stdout.write(`Record metrics captured while ${size.machineSize} was running (${size.memoryMb} MB).\n`);
          process.stdout.write('Record machine CPU and memory from Fly metrics, then relay process CPU and peak RSS from the machine process view. The cloud admin API has no documented metrics or exec route.\n');
          const metrics = {};
          for (const userCount of users) {
            const flyCpuSustainedPct = await askMetric(rl, `${userCount} users: Fly machine CPU sustained percent`, signal);
            const flyMemoryUsedMb = await askMetric(rl, `${userCount} users: Fly machine memory used MB`, signal);
            const relayCpuSustainedPct = await askMetric(rl, `${userCount} users: relay process CPU sustained percent`, signal);
            const relayRssMb = await askMetric(rl, `${userCount} users: relay RSS peak MB`, signal);
            metrics[userCount] = { flyCpuSustainedPct, flyMemoryUsedMb, relayCpuSustainedPct, relayRssMb };
          }
          return metrics;
        },
      } : {}),
    });
  } catch (error) {
    const secrets = [env.ADMIN_TOKEN, env.TARGET_COOKIES, env.TARGET_LOGIN_TOKENS]
      .filter(Boolean)
      .flatMap((value) => [value, ...String(value).split(',')]);
    process.stderr.write(`${redactFlyLoadText(error instanceof Error ? error.message : 'Fly load run failed', secrets)}\n`);
    if (signalCode !== null) process.exitCode = signalCode;
    else process.exitCode = 1;
  } finally {
    rl?.close();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Fly load run failed'}\n`);
    process.exitCode = 1;
  });
}
