import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A restore keeps the old data for 7 days only while the disk has room, so a test that let it read the runner's real
// disk passed on a roomy laptop and failed on a full Windows runner (CI on 9b9ea55). Tests give the restore engine a
// stub: `statfs` when they build it, TABULA_TEST_RESTORE_DISK_USED when they start a relay.

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = fs.readdirSync(here)
  .filter((f) => f.endsWith('.ts') && f !== 'no-real-disk.test.ts')
  .map((f) => ({ f, text: fs.readFileSync(path.join(here, f), 'utf8') }));

describe('tests never depend on the real disk', () => {
  it('give every restore engine they build a statfs stub', () => {
    const builders = sources.filter((s) => s.text.includes('createRestore('));
    expect(builders.length).toBeGreaterThan(0);
    for (const { f, text } of builders) {
      const calls = text.split('createRestore(').length - 1;
      const stubbed = (text.match(/createRestore\(\{[^]*?\bstatfs\b/g) ?? []).length;
      expect({ f, unstubbed: calls - stubbed }).toEqual({ f, unstubbed: 0 });
    }
  });

  it('stub the disk for every relay they start that can restore', () => {
    // built from parts so this file does not count as one that starts a relay (test/relay-timing.test.ts)
    const relays = sources.filter((s) => s.text.includes(['relay', 'mjs'].join('.')) && /api\/admin\/backups\/(restore|preview)/.test(s.text));
    expect(relays.filter((s) => !s.text.includes('TABULA_TEST_RESTORE_DISK_USED')).map((s) => s.f)).toEqual([]);
  });

  it('never read the disk or memory size of the machine they run on', () => {
    const real = /\bfs(?:\.promises)?\.statfs(?:Sync)?\s*\(|\bstatfsSync\s*\(|\bos\.(?:freemem|totalmem)\s*\(/;
    expect(sources.filter((s) => real.test(s.text)).map((s) => s.f)).toEqual([]);
  });
});
