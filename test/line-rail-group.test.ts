import { describe, expect, it } from 'vitest';
import { choiceForToolKind, rememberToolChoice, restoreToolChoice } from '../src/ui/rail-tool-group-state';

// The Connectors and lines rail group: Connector and Line are its two choices (src/ui/board.ts).
const choices = [
  { id: 'connector', toolKind: 'connector' },
  { id: 'line', toolKind: 'line' },
] as const;

describe('the Connectors and lines rail group', () => {
  it('shows Line while the line tool is active, and Connector for the connector tool', () => {
    expect(choiceForToolKind('line', choices)).toBe('line');
    expect(choiceForToolKind('connector', choices)).toBe('connector');
    expect(choiceForToolKind('pen', choices)).toBeNull();
  });

  it('restores the remembered choice, and falls back to Connector, the default', () => {
    expect(restoreToolChoice('line', 'select', choices, 'connector')).toBe('line');
    expect(restoreToolChoice(null, 'select', choices, 'connector')).toBe('connector');
    expect(restoreToolChoice(null, 'line', choices, 'connector')).toBe('line');
  });

  it('remembers Line when the line tool is picked and leaves the choice alone for other tools', () => {
    expect(rememberToolChoice('connector', 'line', choices)).toBe('line');
    expect(rememberToolChoice('line', 'pen', choices)).toBe('line');
  });
});
