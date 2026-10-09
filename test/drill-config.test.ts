import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import config, { DRILL_PATTERN } from '../vite.config';
import drill from '../vitest.drill.config';

// TAB-94: the local restore drill (test/drill/*.drill.test.ts, `npm run drill:local`) starts and stops a dozen relays and
// takes a minute or more. It must never run in `npm test` or CI, and a drill file still matches vitest's default
// include (`**/*.test.ts`), so only the explicit exclude in vite.config.ts keeps it out. Checked with vitest's own listing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drillFiles = fs.readdirSync(path.join(root, 'test', 'drill')).filter((f) => f.endsWith('.drill.test.ts')).map((f) => `test/drill/${f}`).sort();

async function listed(configFile: string) {
  const vitest = await createVitest('test', { config: path.join(root, configFile), root, watch: false }, {}, {});
  try {
    const specs = await vitest.globTestSpecifications();
    return specs.map((s) => path.relative(root, s.moduleId).split(path.sep).join('/')).sort();
  } finally {
    await vitest.close();
  }
}

describe('the restore drill and the normal test run', () => {
  it('has drill files, and the normal config excludes their pattern', () => {
    expect(drillFiles.length).toBeGreaterThan(0);
    expect(DRILL_PATTERN).toBe('**/*.drill.test.ts');
    expect(config.test?.exclude).toContain(DRILL_PATTERN);
    expect(drill.test?.exclude).not.toContain(DRILL_PATTERN);
  });

  it('collects none of them in `npm test`, and the drill config collects exactly them', async () => {
    const [normal, drilled] = await Promise.all([listed('vite.config.ts'), listed('vitest.drill.config.ts')]);
    expect(normal.length).toBeGreaterThan(50);
    expect(normal).toContain('test/drill-config.test.ts');
    expect(normal.filter((f) => f.includes('.drill.') || f.startsWith('test/drill/'))).toEqual([]);
    expect(drilled).toEqual(drillFiles);
  });
});
