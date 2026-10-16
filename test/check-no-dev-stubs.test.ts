import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDevStubs } from '../scripts/check-no-dev-stubs.mjs';

let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('check-no-dev-stubs', () => {
  it('passes a build without the stub strings and names the file that holds one', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-stubs-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets/main.js'), 'toast("Moved")');
    expect(findDevStubs(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'assets/home.js'), 'toast("Moved (dev stub: not saved on the server yet)")');
    expect(findDevStubs(dir).map((f) => f.file)).toEqual(['assets/home.js', 'assets/home.js']);
  });
});
