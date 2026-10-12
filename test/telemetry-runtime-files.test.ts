import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Dockerfile's runtime image copies only server/, shared/ and dist/ (plus package.json). A telemetry module that reads or imports
// a file outside those folders works in the repository and fails in the container.

const root = resolve(__dirname, '..');
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const copied: string[] = [...dockerfile.matchAll(/^COPY (?!--from)(?!package)(\S+) \.\/\1\s*$/gmu)].map((m) => m[1]).filter((d) => d === 'server' || d === 'shared');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('telemetry runs from the files the Dockerfile copies', () => {
  it('the Dockerfile copies server and shared', () => {
    expect(copied.sort()).toEqual(['server', 'shared']);
  });

  it('no server runtime file imports or reads a path outside the copied folders', () => {
    const bad: string[] = [];
    for (const file of files(join(root, 'server'))) {
      if (!/\.(mjs|js|json)$/u.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu)].map((m) => m[1]);
      for (const spec of specs) {
        const target = resolve(dirname(file), spec);
        const rel = relative(root, target);
        const top = rel.split(sep)[0];
        if (!copied.includes(top) && top !== 'package.json') bad.push(`${relative(root, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the telemetry modules load from a tree that has only server/, shared/ and package.json', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'tabula-image-'));
    try {
      cpSync(join(root, 'server'), join(tree, 'server'), { recursive: true });
      cpSync(join(root, 'shared'), join(tree, 'shared'), { recursive: true });
      cpSync(join(root, 'package.json'), join(tree, 'package.json'));
      const schema = await import(/* @vite-ignore */ pathToFileURL(join(tree, 'server/telemetry/schema.mjs')).href);
      expect(typeof schema.SCHEMA_HASH).toBe('string');
      await import(/* @vite-ignore */ pathToFileURL(join(tree, 'server/telemetry/scrub.mjs')).href);
      await import(/* @vite-ignore */ pathToFileURL(join(tree, 'server/telemetry/collector.mjs')).href);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
