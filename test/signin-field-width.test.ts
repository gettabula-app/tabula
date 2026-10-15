import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sign-in page field', () => {
  it('fills the form like the button below it (the page does not load the app stylesheet that sets .input to 100%)', () => {
    const css = readFileSync('src/ui/signin.css', 'utf8');
    const rule = /\.signin \.input \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width: 100%');
    expect(rule).toContain('box-sizing: border-box');
  });

  it('narrows only the field that sits inside the invite-recovery sentence (TAB-376): the form\'s own field fills the column', () => {
    const source = readFileSync('src/ui/signin.ts', 'utf8');
    expect(source).toContain("class: recoveryInvite && !initialEmail ? 'input signin-recovery-email' : 'input',");
    expect(source).not.toMatch(/: 'input signin-recovery-email'/);
  });
});
