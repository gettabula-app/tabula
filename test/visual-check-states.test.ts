import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('visual-check states', () => {
  it('lists guest-cursors as a visual state', () => {
    const help = execFileSync(process.execPath, ['scripts/visual-check.mjs', '--help'], { encoding: 'utf8' });
    expect(help).toContain('guest-cursors');
  });
});
