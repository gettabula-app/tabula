import { describe, expect, it } from 'vitest';
import { parseBoardResourceUri } from '../server/mcp-resource-uri.mjs';

describe('parseBoardResourceUri', () => {
  it('extracts board ids that use the tool board id pattern', () => {
    expect(parseBoardResourceUri('board://a')).toBe('a');
    expect(parseBoardResourceUri(`board://${'a'.repeat(64)}`)).toBe('a'.repeat(64));
    expect(parseBoardResourceUri('board://a_B-9')).toBe('a_B-9');
  });

  it('rejects anything outside the exact board URI form', () => {
    for (const uri of [undefined, null, '', 'board://', 'board://a/b', 'board://a?x', 'board://../a', `board://${'a'.repeat(65)}`, 'https://board/a']) {
      expect(parseBoardResourceUri(uri)).toBeNull();
    }
  });
});
