import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify } from '../scripts/ci-changes.mjs';

const script = fileURLToPath(new URL('../scripts/ci-changes.mjs', import.meta.url));
const run = (...paths: string[]) => classify(paths);

describe('ci change classification', () => {
  it('builds only the guide when the change is under docs/guide', () => {
    expect(run('docs/guide/x.md')).toEqual({ code: false, guide: true });
    expect(run('docs/images/boards.png')).toEqual({ code: false, guide: true });
    expect(run('docs/guide/.last-documented', 'CHANGELOG.md')).toEqual({ code: false, guide: true });
  });

  it('skips everything for Markdown, other docs, design mockups, licences and dependabot.yml', () => {
    const none = { code: false, guide: false };
    expect(run('README.md')).toEqual(none);
    expect(run('docs/desktop.md')).toEqual(none);
    expect(run('design/ai-toolbar/index.html', 'design/ai-toolbar/shot.png')).toEqual(none);
    expect(run('desktop/README.md', 'server/notes.md', '.claude/agents/implementer.md')).toEqual(none);
    expect(run('LICENSE', 'LICENSE.txt', 'LICENSE-MIT')).toEqual(none);
    expect(run('.github/dependabot.yml')).toEqual(none);
  });

  it('runs the full pipeline for anything else', () => {
    expect(run('src/app.ts')).toEqual({ code: true, guide: false });
    expect(run('package.json')).toEqual({ code: true, guide: false });
    expect(run('.github/workflows/ci.yml')).toEqual({ code: true, guide: false });
    expect(run('.github/workflows/codeql.yml')).toEqual({ code: true, guide: false });
    expect(run('scripts/ci-changes.mjs')).toEqual({ code: true, guide: false });
    expect(run('scripts/vite-docs.mjs')).toEqual({ code: true, guide: false });
  });

  it('does not mistake code for docs because of its name', () => {
    expect(run('src/docs/docs.ts')).toEqual({ code: true, guide: false });
    expect(run('src/docs/guide/x.ts')).toEqual({ code: true, guide: false });
    expect(run('mydocs/x.md.ts')).toEqual({ code: true, guide: false });
    expect(run('public/icons/LICENSES.txt')).toEqual({ code: true, guide: false });
    expect(run('vendor/LICENSE')).toEqual({ code: true, guide: false });
    expect(run('.github/dependabot.yaml')).toEqual({ code: true, guide: false });
  });

  it('lets one code file outweigh any number of docs', () => {
    expect(run('docs/x.md', 'src/app.ts')).toEqual({ code: true, guide: false });
    expect(run('docs/guide/x.md', 'src/app.ts')).toEqual({ code: true, guide: true });
    expect(run('src/app.ts', 'docs/guide/x.md', 'README.md')).toEqual({ code: true, guide: true });
  });

  it('builds everything when there is nothing to compare', () => {
    expect(classify([])).toEqual({ code: true, guide: true });
    expect(classify(['', '\r'])).toEqual({ code: true, guide: true });
  });

  it('ignores blank lines and carriage returns', () => {
    expect(classify(['docs/guide/x.md\r', '', 'README.md\r'])).toEqual({ code: false, guide: true });
  });

  it('prints the lines the workflow appends to $GITHUB_OUTPUT', () => {
    const cli = (input: string) => execFileSync(process.execPath, [script], { input, encoding: 'utf8' });
    expect(cli('docs/guide/x.md\nCHANGELOG.md\n')).toBe('code=false\nguide=true\n');
    expect(cli('docs/desktop.md\n')).toBe('code=false\nguide=false\n');
    expect(cli('docs/x.md\nsrc/app.ts\n')).toBe('code=true\nguide=false\n');
    expect(cli('\n')).toBe('code=true\nguide=true\n');
  });
});
