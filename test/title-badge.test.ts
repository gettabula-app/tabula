import { describe, expect, it } from 'vitest';
import { prefixFor, titleFor } from '../src/ui/title-badge';

// docs/chat.md, Unread: the page title carries the unread count while the tab is in the background.

describe('prefixFor', () => {
  it('is the count in brackets while the tab is hidden and something is unread', () => {
    expect(prefixFor(3, true)).toBe('(3) ');
    expect(prefixFor(99, true)).toBe('(99) ');
    expect(prefixFor(100, true)).toBe('(99+) ');
  });

  it('is nothing when the tab is shown or nothing is unread', () => {
    expect(prefixFor(3, false)).toBe('');
    expect(prefixFor(0, true)).toBe('');
  });
});

describe('titleFor', () => {
  it('puts the prefix in front of the title', () => {
    expect(titleFor('Roadmap - Tabula', '', 3, true)).toBe('(3) Roadmap - Tabula');
  });

  it('swaps the prefix it put there for the new one, and takes it off when it is not wanted', () => {
    expect(titleFor('(3) Roadmap - Tabula', '(3) ', 5, true)).toBe('(5) Roadmap - Tabula');
    expect(titleFor('(3) Roadmap - Tabula', '(3) ', 0, true)).toBe('Roadmap - Tabula');
    expect(titleFor('(3) Roadmap - Tabula', '(3) ', 3, false)).toBe('Roadmap - Tabula');
  });

  it('keeps a title a page set itself, which does not carry the prefix', () => {
    expect(titleFor('Other page - Tabula', '(3) ', 3, true)).toBe('(3) Other page - Tabula');
  });

  it('never takes brackets that belong to a board’s own name', () => {
    expect(titleFor('(2024) Plan - Tabula', '', 0, false)).toBe('(2024) Plan - Tabula');
    expect(titleFor('(2024) Plan - Tabula', '', 2, true)).toBe('(2) (2024) Plan - Tabula');
    expect(titleFor('(2) (2024) Plan - Tabula', '(2) ', 0, false)).toBe('(2024) Plan - Tabula');
  });
});
