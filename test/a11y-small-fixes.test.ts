import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('accessibility audit follow-ups', () => {
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

  it('keeps visible focus indicators on the board name, admin fields and dialog fields', () => {
    const styles = read('src/styles.css');
    const boardName = styles.match(/\.board-name\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(boardName).not.toMatch(/outline\s*:\s*none/);
    expect(styles).not.toMatch(/\.modal \.input:focus-visible, \.popover \.input:focus-visible\s*\{[^}]*outline\s*:\s*none/);
    expect(read('src/ui/admin.css')).not.toMatch(/\.admin \.input:focus-visible\s*\{[^}]*outline\s*:\s*none/);
    expect(read('src/ui/tokens.css')).not.toMatch(/\.tokens-dialog \.input:focus-visible\s*\{[^}]*outline\s*:\s*none/);
    expect(read('src/ui/comments.css')).toMatch(/\.comment-card :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--tray-text\)/);
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
