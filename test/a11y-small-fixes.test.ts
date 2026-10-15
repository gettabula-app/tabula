import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return cssFiles(path);
  return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
});
const allCss = () => cssFiles(join(ROOT, 'src')).map((file) => readFileSync(file, 'utf8')).join('\n');

describe('accessibility audit follow-ups', () => {
  it('keeps shared modal chrome light and quiet', () => {
    const styles = read('src/styles.css');
    const modalHead = styles.match(/\.modal-head\s*\{([^}]*)\}/)?.[1] ?? '';
    const modalHeading = styles.match(/\.modal-head h2\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(modalHead).not.toMatch(/border-bottom\s*:/);
    expect(modalHead).toMatch(/flex:\s*none/);
    expect(modalHead).toMatch(/padding:\s*24px 16px 8px 24px/);
    const headingSize = Number(modalHeading.match(/font:\s*\d+\s+([\d.]+)px\/[\d.]+\s+var\(--font-serif\)/)?.[1] ?? 0);
    expect(headingSize).toBeGreaterThanOrEqual(20);
    const modalButton = styles.match(/\.modal \.btn\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(modalButton).toMatch(/background:\s*transparent/);
    expect(modalButton).toMatch(/border:\s*1px solid var\(--tray-line\)/);
    expect(modalButton).toMatch(/font-weight:\s*500/);
    expect(modalButton).not.toMatch(/box-shadow\s*:/);
    expect(styles).toMatch(/\.modal \.btn:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--tray-hover\)/);

    const modalDanger = styles.match(/\.modal \.btn\.armed,\s*\.modal \.btn\.danger\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(modalDanger).toMatch(/background:\s*var\(--danger\)/);
    expect(modalDanger).toMatch(/color:\s*var\(--on-danger\)/);
    expect(styles).toMatch(/\.modal \.btn\.armed\s*\{[^}]*outline:\s*2px solid var\(--danger\);[^}]*outline-offset:\s*2px/);
    for (const file of ['src/ui/tokens.ts', 'src/ui/ai.ts']) {
      expect(read(file)).toMatch(/button\.textContent = armedLabel;\s*button\.classList\.add\('armed'\)/);
    }
  });

  it('keeps the visible poll question and its accessible name aligned', () => {
    const source = read('src/ui/polls.ts');
    expect(source).toMatch(/'aria-label': 'Question'/);
    expect(source).not.toMatch(/placeholder: 'Ask a question'/);
  });

  it('includes a screen-reader-only action label alongside the visible step text', () => {
    const source = read('src/ui/flowbar.ts');
    expect(source).toMatch(/h\('span', \{ class: 'sr-only' \}, 'All steps'\)/);
    expect(source).not.toMatch(/class: 'flow-step',[\s\S]{0,180}'aria-label':/);
  });

  it('includes the visible +1 label in the timer button name', () => {
    expect(read('src/ui/flowbar.ts')).toMatch(/'aria-label': '\+1\. Add one minute'/);
  });

  it('includes the visible vote count in the dot-limit button name', () => {
    expect(read('src/ui/flowbar.ts')).toMatch(/const countLabel = unlimited \? \(mine \? `\$\{mine\} \$\{mine === 1 \? 'dot' : 'dots'\} placed, no limit` : 'No limit'\)/);
    expect(read('src/ui/flowbar.ts')).toMatch(/const accessibleCount = unlimited \? countLabel : left \? `\$\{countLabel\} \(\$\{left\} of \$\{limit\} \$\{limit === 1 \? 'dot' : 'dots'\} left\)` : countLabel/);
    expect(read('src/ui/flowbar.ts')).toMatch(/'aria-label': `\$\{accessibleCount\}\. Change dots per person`/);
  });

  it('includes the visible Info label in the voting-instructions button name', () => {
    expect(read('src/ui/flowbar.ts')).toMatch(/aria-label': voteInstructionOpen \? 'Info: Hide voting instructions' : 'Info: Show voting instructions'/);
  });

  it('announces a correctly worded dot count after voting', () => {
    expect(read('src/ui/flowbar.ts')).toMatch(/const said = unlimited \? `\$\{mine\} \$\{mine === 1 \? 'dot' : 'dots'\} placed` : `\$\{left\} of \$\{limit\} \$\{limit === 1 \? 'dot' : 'dots'\} left`/);
  });

  it('uses a second-level heading for the vote-scope popover', () => {
    expect(read('src/ui/flowbar.ts')).toMatch(/h\('h2', null, 'What can be voted on\?'\)/);
    expect(read('src/styles.css')).toMatch(/\.pop-head h2/);
  });

  it('keeps keyboard focus visible on modal buttons and modal fields flat', () => {
    const styles = read('src/styles.css');
    const boardName = styles.match(/\.board-name\s*\{([^}]*)\}/)?.[1] ?? '';
    const fieldFocus = styles.match(/\.input:focus,\s*select:focus,\s*textarea:not\(\.text-editor\):focus\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(boardName).not.toMatch(/outline\s*:\s*none/);
    // TAB-374 (B2): a focused field gets a 2px ring all round
    expect(fieldFocus).toMatch(/outline:\s*2px solid var\(--tray-text\)/);
    const focusRingReplacesOutline = /box-shadow:\s*[^;]*inset 0 0 0 1px var\(--field-edge-strong\)[^;]*0 0 0 3px/.test(fieldFocus);
    const outlineRemoved = /outline:\s*(?:0|none)\s*;/.test(fieldFocus);
    const outlineDeclared = /outline:\s*[^;]+;/.test(fieldFocus);
    expect(!outlineRemoved || focusRingReplacesOutline).toBe(true);
    expect(outlineRemoved || outlineDeclared).toBe(true);
    const cssRules = [...allCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selectors: match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')).filter(Boolean),
      body: match[2].replace(/\/\*[\s\S]*?\*\//g, ''),
    }));
    const sharedFocus = cssRules.find((rule) => rule.selectors.includes(':focus-visible'));
    expect(sharedFocus).toBeDefined();
    const sharedOutline = sharedFocus?.body.match(/(?:^|;)\s*outline\s*:\s*([\d.]+)px\s+solid\s+[^;]+;/i);
    const sharedOffset = sharedFocus?.body.match(/(?:^|;)\s*outline-offset\s*:\s*(-?[\d.]+)px\s*;/i);
    expect(Number(sharedOutline?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    expect(Number(sharedOffset?.[1] ?? 0)).not.toBe(0);
    const targetsModalControl = (selector: string) => {
      const tail = selector.match(/(?:^|[\s>+~])\.modal\b(.*)$/)?.[1] ?? '';
      return /(?:^|[\s>+~])(?:\.btn|\.icon-btn|a)(?=$|[\s.#:[>+~])/.test(tail);
    };
    const removedModalOutlines = cssRules.flatMap((rule) => rule.selectors
      .filter(targetsModalControl)
      .filter(() => /(?:^|;)\s*outline\s*:\s*(?:none|0(?:px)?)(?:\s*!important)?\s*;/i.test(rule.body)));
    expect(removedModalOutlines).toEqual([]);
    // Forced-colors Highlight outlines for shared fields and controls are asserted in test/forced-colors-focus.test.ts.
    expect(read('src/ui/admin.css')).not.toMatch(/\.admin \.input:focus-visible\s*\{[^}]*outline\s*:\s*none/);
    expect(read('src/ui/tokens.css')).not.toMatch(/\.tokens-dialog \.input:focus-visible\s*\{[^}]*outline\s*:\s*none/);
    expect(read('src/ui/comments.css')).toMatch(/\.comment-card :focus-visible(?::not\([^)]*\))*\s*\{[^}]*outline:\s*2px solid var\(--tray-text\)/);
  });

  it('keeps the token-name example in the accessible input name', () => {
    expect(read('src/ui/tokens.ts')).toMatch(/'aria-label': 'Token name, for example Claude Code on my laptop'/);
  });

  it('uses the visible join-code expiry label as the select name', () => {
    expect(read('src/ui/join-codes.ts')).toMatch(/'aria-label': 'Expires after'/);
  });

  it('marks avatar initials as decorative because the control is already named with the person’s name', () => {
    const source = read('src/ui/board.ts');
    expect(source).toMatch(/const avatarText = initials\(p\.user\.name\)/);
    expect(source).toMatch(/'aria-label': `\$\{tip\}, initials \$\{avatarText\}`/);
    expect(source).toMatch(/h\('span', \{ 'aria-hidden': 'true' \}, avatarText\)/);
  });
});
