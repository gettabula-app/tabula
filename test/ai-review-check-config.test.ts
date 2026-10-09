import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import { startAnthropicStub } from '../scripts/lib/anthropic-stub.mjs';

// TAB-160: `npm run check:ai-review` (scripts/check-ai-review.mjs) drives headless Chromium and two people against a relay whose
// AI provider is a local stub. It builds the app and takes about a minute, so it must never run in `npm test` or CI, it must
// not depend on the machine it was written on, and it must write only where git ignores. Checked here without a browser.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const SCRIPT = 'scripts/check-ai-review.mjs';
const STUB = 'scripts/lib/anthropic-stub.mjs';
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

describe('the AI review browser check and the normal test run', () => {
  it('is its own npm script, and nothing in `npm test` or the other scripts runs it', () => {
    expect(pkg.scripts['check:ai-review']).toBe('node scripts/check-ai-review.mjs');
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name === 'check:ai-review') continue;
      expect(`${name}: ${command}`).not.toMatch(/check[:-]ai-review/);
    }
    expect(pkg.scripts.pretest).toBeUndefined();
    expect(pkg.scripts.posttest).toBeUndefined();
  });

  it('is not in a CI workflow', () => {
    const dir = path.join(root, '.github', 'workflows');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(`${f}: ${fs.readFileSync(path.join(dir, f), 'utf8')}`).not.toMatch(/check[:-]ai-review|anthropic-stub/);
  });

  it('is collected by no vitest run: neither the script nor the stub is a test file', async () => {
    const vitest = await createVitest('test', { config: path.join(root, 'vite.config.ts'), root, watch: false }, {}, {});
    try {
      const specs = (await vitest.globTestSpecifications()).map((s) => path.relative(root, s.moduleId).split(path.sep).join('/'));
      expect(specs.length).toBeGreaterThan(50);
      expect(specs.filter((f) => f.startsWith('scripts/'))).toEqual([]);
      expect(specs).toContain('test/ai-review-check-config.test.ts');
    } finally {
      await vitest.close();
    }
  });

  it('names no path of the machine it was written on', () => {
    for (const file of [SCRIPT, STUB]) {
      expect(`${file}: ${read(file)}`).not.toMatch(/\/Users\/|\/Volumes\/|\/private\/|\/home\/[a-z]|\/tmp\/|[A-Z]:\\|\.claude\/worktrees|\.nvm/);
    }
  });

  it('writes only where git ignores: the build in dist/, the shots in tabula-review/, the rest in a temporary folder', () => {
    const ignored = read('.gitignore').split('\n').map((l) => l.trim());
    expect(ignored).toContain('dist/');
    expect(ignored).toContain('tabula-review/');
    const src = read(SCRIPT);
    expect(src).toContain("path.join(root, 'tabula-review', 'ai-review')");
    expect(src).toContain("fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-ai-review-'))");
  });

  it('gives each browser context its own client address, so the relay\'s 20 runs an hour per address never stops it', () => {
    const src = read(SCRIPT);
    // only in the check's throwaway relay: it trusts x-forwarded-for there, and every context sends a different one
    expect(src).toContain("TABULA_TRUST_PROXY: '1'");
    expect(src).toMatch(/extraHTTPHeaders: \{ 'x-forwarded-for': freshAddress\(\) \}/);
    const addresses = new Set<string>();
    const fresh = new Function(`${/let nextAddress = 1;\nconst freshAddress = [^\n]+/.exec(src)![0]}\nreturn freshAddress;`)() as () => string;
    for (let i = 0; i < 1000; i++) addresses.add(fresh());
    expect(addresses.size).toBe(1000);
    for (const a of addresses) expect(a).toMatch(/^198\.1[89]\.\d{1,3}\.\d{1,3}$/);
    // the production limits are untouched: the open-mode handler still counts DEFAULT_LIMITS per address
    expect(read('server/ai/run.mjs')).toContain('limits: DEFAULT_LIMITS');
  });

  it('says how to use it, and refuses an unknown option, before starting anything', () => {
    const help = spawnSync(process.execPath, [path.join(root, SCRIPT), '--help'], { encoding: 'utf8', cwd: root, timeout: 20_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('npm run check:ai-review');
    const bad = spawnSync(process.execPath, [path.join(root, SCRIPT), '--nope'], { encoding: 'utf8', cwd: root, timeout: 20_000 });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Usage: npm run check:ai-review');
  });
});

describe('the stub provider', () => {
  const stubs: { server: { close: (cb: () => void) => void } }[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => new Promise<void>((resolve) => s.server.close(resolve))));
  });

  const answers = { generate: { objects: [{ text: 'one' }], frame: { title: 'Summary' } }, cluster: { groups: [{ title: 'G', ids: ['a'] }] } };
  const post = (base: string, body: unknown, key = 'k-1234567') =>
    fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });

  /** The text the stream carries: the deltas of its one text block, joined. */
  function streamed(text: string) {
    const events = text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(b)![1]) }));
    const out = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
    return { names: events.map((e) => e.event), out };
  }

  it('streams the answer of the feature that asked, as the Messages API would, and records each call', async () => {
    const stub = await startAnthropicStub({ apiKey: 'k-1234567', model: 'claude-haiku-5-5', answers });
    stubs.push(stub);
    expect(stub.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const gen = await post(stub.base, { model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema: { properties: { objects: {} } } } } });
    expect(gen.headers.get('content-type')).toContain('text/event-stream');
    const g = streamed(await gen.text());
    expect(g.names[0]).toBe('message_start');
    expect(g.names.at(-1)).toBe('message_stop');
    expect(JSON.parse(g.out)).toEqual(answers.generate);

    const clu = await post(stub.base, { model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema: { properties: { groups: {} } } } } });
    expect(JSON.parse(streamed(await clu.text()).out)).toEqual(answers.cluster);

    expect(stub.calls).toEqual([
      { method: 'POST', path: '/v1/messages', model: 'claude-haiku-5-5', apiKeyMatched: true, feature: 'generate', requestFormat: 'json_schema' },
      { method: 'POST', path: '/v1/messages', model: 'claude-haiku-5-5', apiKeyMatched: true, feature: 'cluster', requestFormat: 'json_schema' },
    ]);
  });

  it('notes a call made with another key, answers other routes with 404 and a bad body with 400', async () => {
    const stub = await startAnthropicStub({ apiKey: 'k-1234567', model: 'claude-haiku-5-5', answers });
    stubs.push(stub);
    await (await post(stub.base, { model: 'claude-haiku-5-5' }, 'someone-elses-key')).text();
    expect(stub.calls.map((c) => c.apiKeyMatched)).toEqual([false]);
    expect((await fetch(`${stub.base}/v1/other`)).status).toBe(404);
    expect((await fetch(`${stub.base}/v1/messages`, { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await (await fetch(`${stub.base}/v1/models`)).json()).data[0].id).toBe('claude-haiku-5-5');
  });
});
