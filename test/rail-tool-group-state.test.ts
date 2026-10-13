import { describe, expect, it } from 'vitest';
import { choiceForToolKind, rememberToolChoice, restoreToolChoice } from '../src/ui/rail-tool-group-state';

const choices = [
  { id: 'text', kind: 'text' },
  { id: 'connector', kind: 'connector' },
] as const;

describe('rail tool group state', () => {
  it('maps the active tool to its group entry', () => {
    expect(choiceForToolKind('connector', choices)).toBe('connector');
    expect(choiceForToolKind('pen', choices)).toBeNull();
  });

  it('restores a saved choice and falls back to the current grouped tool or default', () => {
    expect(restoreToolChoice('connector', 'text', choices, 'text')).toBe('connector');
    expect(restoreToolChoice('removed-tool', 'connector', choices, 'text')).toBe('connector');
    expect(restoreToolChoice(null, 'select', choices, 'text')).toBe('text');
  });

  it('remembers grouped tools and leaves unrelated tools unchanged', () => {
    expect(rememberToolChoice('text', 'connector', choices)).toBe('connector');
    expect(rememberToolChoice('connector', 'pen', choices)).toBe('connector');
  });
});
