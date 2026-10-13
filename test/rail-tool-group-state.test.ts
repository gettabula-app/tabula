import { describe, expect, it } from 'vitest';
import { choiceForToolKind, rememberToolChoice, restoreToolChoice } from '../src/ui/rail-tool-group-state';

const choices = [
  { id: 'text', toolKind: 'text' },
  { id: 'markdown', toolKind: 'markdown' },
  { id: 'link' },
] as const;

describe('rail tool group state', () => {
  it('maps the active tool to its group entry', () => {
    expect(choiceForToolKind('text', choices)).toBe('text');
    expect(choiceForToolKind('markdown', choices)).toBe('markdown');
    expect(choiceForToolKind('link', choices)).toBeNull();
    expect(choiceForToolKind('pen', choices)).toBeNull();
  });

  it('restores a saved choice and falls back to the current grouped tool or default', () => {
    expect(restoreToolChoice('link', 'text', choices, 'text')).toBe('link');
    expect(restoreToolChoice('removed-tool', 'markdown', choices, 'text')).toBe('markdown');
    expect(restoreToolChoice(null, 'select', choices, 'text')).toBe('text');
    expect(restoreToolChoice('link', 'select', choices.slice(0, 2), 'text')).toBe('text');
  });

  it('remembers grouped tools and keeps a saved action choice out of active-tool state', () => {
    expect(rememberToolChoice('text', 'markdown', choices)).toBe('markdown');
    expect(rememberToolChoice('link', 'pen', choices)).toBe('link');
    expect(rememberToolChoice('text', 'link', choices)).toBe('text');
  });
});
