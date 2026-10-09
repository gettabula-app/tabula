import { describe, expect, it } from 'vitest';
import { dotsButtonTip, voteInstructionText } from '../src/ui/flowbar-logic';

describe('dot vote instructions on touch', () => {
  const desktop = 'Click any note or shape to add a dot. Click again to add more; shift-click removes one of yours.';

  it('uses touch wording without mentioning Shift and leaves desktop wording alone', () => {
    const touch = voteInstructionText(desktop, true);
    expect(touch).toContain('Tap an item to add a dot');
    expect(touch).toContain('switch on Remove dots to take one back');
    expect(touch.toLowerCase()).not.toContain('shift');
    expect(voteInstructionText(desktop, false)).toBe(desktop);
  });

  it('keeps the dot-count help aligned with the pointer type', () => {
    expect(dotsButtonTip(true).toLowerCase()).not.toContain('shift');
    expect(dotsButtonTip(true)).toContain('switch on Remove dots to take one back');
    expect(dotsButtonTip(false)).toContain('shift-click');
  });
});
