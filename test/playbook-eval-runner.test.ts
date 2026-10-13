import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOpenAiStub } from '../scripts/lib/openai-stub.mjs';
import { startRecordingProxy } from '../scripts/lib/playbook-eval-proxy.mjs';
import { buildFixture } from '../scripts/lib/playbook-fixtures.mjs';
import { goldGroups, retroSummary } from '../scripts/lib/playbook-gold.mjs';
import { budget } from './wait-budget';

// The playbook evaluation runner (TAB-171, slice 3): scripts/playbook-eval.mjs is run as a child process against the stub,
// and against a local OpenAI-compatible stub that stands in for a real provider (the key then has to arrive there, swapped
// by the recording proxy). Every report is checked for canaries, keys and any field that would carry a request body.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts', 'playbook-eval.mjs');
const CANARY = /CANARY-[A-Za-z0-9-]+/;
const FAKE_KEY = 'sk-ant-FAKEKEY1234567890';

const made: string[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-eval-test-'));
  made.push(dir);
  return path.join(dir, 'report');
}

/** Runs the runner with a clean environment: only PATH, plus whatever the test sets. */
function runner(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (out += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const readReport = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as any;
const readText = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

/** Every key name in a JSON value, at any depth. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      keysOf(item, out);
    }
  }
  return out;
}

describe('playbook evaluation runner', () => {
  it(
    'the stub passes: both feature runs clear the hard gates, S1 and S2 pass, and the reports hold no canary',
    async () => {
      const dir = outDir();
      const result = await runner(['--provider', 'stub', '--runs', '1', '--out', dir]);
      expect(result.code).toBe(0);
      expect(result.out).not.toMatch(CANARY);

      const report = readReport(dir);
      expect(report.outcome.ok).toBe(true);
      const features = report.runs[0].features as { feature: string; hardOk: boolean; results: { id: string; ok: boolean }[] }[];
      expect(features.map((f) => f.feature)).toEqual(['cluster', 'summarise']);
      for (const feature of features) expect(feature.hardOk).toBe(true);
      expect(features[0]!.results.find((r) => r.id === 'S1')!.ok).toBe(true);
      expect(features[1]!.results.find((r) => r.id === 'S2')!.ok).toBe(true);

      const markdown = readText(dir, 'report.md');
      expect(markdown).toContain('| check | kind | passes | needed | result | detail |');
      expect(markdown).toContain('| retro-follow-up cluster S1 | scored | 1/1 | 1 | pass |');
      for (const text of [result.out, JSON.stringify(report), markdown]) expect(text).not.toMatch(CANARY);
    },
    budget(60_000),
  );

  it(
    'an injected instruction in the answer fails hard gate H5, and the report names H5',
    async () => {
      const dir = outDir();
      const result = await runner(['--provider', 'stub', '--behaviour', 'inject', '--out', dir]);
      expect(result.code).toBe(1);
      const report = readReport(dir);
      expect(report.outcome.ok).toBe(false);
      expect(report.outcome.hardFailed.map((row: { check: string }) => row.check)).toEqual(['H5', 'H5']);
      expect(readText(dir, 'report.md')).toContain('Failed hard gates: H5.');
      expect(result.out).not.toMatch(CANARY);
    },
    budget(60_000),
  );

  it(
    'a real provider without TABULA_EVAL_API_KEY exits 2 before anything starts, and prints no key-shaped text',
    async () => {
      const dir = outDir();
      const result = await runner(['--provider', 'anthropic', '--out', dir]);
      expect(result.code).toBe(2);
      expect(result.out).toContain('TABULA_EVAL_API_KEY is not set');
      expect(result.out).not.toContain('sk-');
      expect(fs.existsSync(path.join(dir, 'report.json'))).toBe(false);
    },
    budget(60_000),
  );

  it(
    'the proxy swaps in the real key for the stub, and neither the output nor the reports hold the key',
    async () => {
      const dir = outDir();
      const fixture = buildFixture('messy-retro');
      const privateIds = new Set(fixture.truth.privateNoteIds as string[]);
      const stickies = Object.entries(fixture.doc.getMap('objects').toJSON() as Record<string, { type: string }>)
        .filter(([, object]) => object.type === 'sticky')
        .map(([id]) => id)
        .filter((id) => !privateIds.has(id));
      // a fixed answer per feature: the stub cannot read the request, so the gold grouping is taken from the fixture
      const stub = await startOpenAiStub({
        apiKey: FAKE_KEY,
        model: 'tabula-stub/json-2',
        answers: { cluster: goldGroups(stickies), generate: retroSummary() },
      });
      closers.push(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));

      const result = await runner(
        ['--provider', 'openai-compatible', '--model', 'tabula-stub/json-2', '--upstream', stub.base, '--runs', '1', '--out', dir],
        { TABULA_EVAL_API_KEY: FAKE_KEY },
      );
      expect(result.code).toBe(0);
      // the stub saw the real key on every call, so the relay's own token was swapped at the proxy
      expect(stub.calls.length).toBeGreaterThanOrEqual(2);
      expect(stub.calls.every((call) => call.keyMatched)).toBe(true);
      expect(result.out).not.toContain(FAKE_KEY);
      expect(result.out).not.toMatch(CANARY);
      const report = readReport(dir);
      expect(report.options.upstream).toBe('127.0.0.1');
      expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
      expect(readText(dir, 'report.md')).not.toContain(FAKE_KEY);
    },
    budget(60_000),
  );

  it(
    '--runs above 20 exits 2 with usage',
    async () => {
      const result = await runner(['--provider', 'stub', '--runs', '21']);
      expect(result.code).toBe(2);
      expect(result.out).toContain('--runs is at most 20');
    },
    budget(60_000),
  );

  it(
    'an unknown option exits 2 with usage',
    async () => {
      const result = await runner(['--provider', 'stub', '--frobnicate']);
      expect(result.code).toBe(2);
      expect(result.out).toContain('Usage:');
    },
    budget(60_000),
  );

  it(
    'a playbook that is not built yet, named explicitly, exits 2',
    async () => {
      const result = await runner(['--provider', 'stub', '--playbook', 'health-check']);
      expect(result.code).toBe(2);
      expect(result.out).toContain('health-check: not built yet (TAB-169)');
    },
    budget(60_000),
  );

  it('the recording proxy keeps bodies in memory, forwards with the real key, and refuses the wrong local token', async () => {
    const stub = await startOpenAiStub({ apiKey: 'REAL-key-1234', model: 'm-1', answers: { cluster: { groups: [] }, generate: { objects: [] } } });
    closers.push(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));
    const proxy = await startRecordingProxy({
      upstream: stub.base,
      kind: 'openai-compatible',
      authName: 'authorization',
      authValue: 'Bearer REAL-key-1234',
      localAuth: 'Bearer LOCAL-token-5678',
    });
    closers.push(() => proxy.close());

    const body = JSON.stringify({ model: 'm-1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello CANARY-xyz' }] });
    const mark = proxy.mark();
    const ok = await fetch(`${proxy.url}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer LOCAL-token-5678', 'content-type': 'application/json' },
      body,
    });
    expect(ok.status).toBe(200);
    expect(stub.calls.at(-1)!.keyMatched).toBe(true);

    const refused = await fetch(`${proxy.url}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer WRONG', 'content-type': 'application/json' },
      body,
    });
    expect(refused.status).toBe(401);
    expect(stub.calls).toHaveLength(1);

    const seen = proxy.recordedSince(mark);
    expect(seen.requests).toEqual([body]);
    expect(seen.texts).toEqual(['{"objects":[]}']);
    expect(seen.hosts).toEqual(['127.0.0.1']);
    // the bodies are reachable only through recordedSince(), never as a property of the proxy object
    expect(Object.keys(proxy).sort()).toEqual(['close', 'mark', 'recordedSince', 'url']);
    expect(JSON.stringify(proxy)).not.toContain('CANARY');
  });

  it('report.json has no field that could carry a request body, prompt or key', async () => {
    const dir = outDir();
    await runner(['--provider', 'stub', '--runs', '1', '--out', dir]);
    const keys = keysOf(readReport(dir));
    expect(keys.filter((key) => /body|request|prompt|key|canary/i.test(key))).toEqual([]);
  }, budget(60_000));
});
