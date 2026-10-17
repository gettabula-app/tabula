import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// A board id sits in a hash link: every one the Boards home builds encodes it (a board id is not trusted to be URL safe).
describe('Boards home hash links', () => {
  it('encode the board id in every #/b/ and #/new/ link', () => {
    const offenders: string[] = [];
    for (const file of ['src/ui/home.ts', 'src/ui/board-card.ts', 'src/ui/boards-cards-view.ts', 'src/ui/boards-home-data.ts']) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/#\/(?:b|new)\/\$\{([^}]*)\}/g)) {
          if (!m[1].startsWith('encodeURIComponent(')) offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
