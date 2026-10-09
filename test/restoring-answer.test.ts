import { describe, expect, it } from 'vitest';
import { isRestoringAnswer } from '../src/restoring-answer';

describe('the 503 that means a restore', () => {
  it('is a 503 with JSON that says restoring, and nothing else', () => {
    expect(isRestoringAnswer(503, { error: 'restoring', message: 'The workspace is being restored' })).toBe(true);
    expect(isRestoringAnswer(503, { error: 'restoring' })).toBe(true);
  });

  it.each<[string, number, unknown]>([
    ['the AI provider is down', 503, { error: 'ai_unavailable', message: 'AI is not available' }],
    ['a gateway page', 503, null],
    ['a gateway page as text', 503, '<html><body>503 restoring</body></html>'],
    ['another JSON error', 503, { error: 'bad_gateway' }],
    ['JSON that mentions restoring in the message only', 503, { error: 'unavailable', message: 'restoring' }],
    ['the code with other case', 503, { error: 'Restoring' }],
    ['the code inside another field', 503, { code: 'restoring' }],
    ['an array', 503, ['restoring']],
    ['a string', 503, 'restoring'],
    ['no body', 503, undefined],
    ['a 502 that says restoring', 502, { error: 'restoring' }],
    ['a 500 that says restoring', 500, { error: 'restoring' }],
    ['a 200 that says restoring', 200, { error: 'restoring' }],
    ['a 429', 429, { error: 'restoring' }],
  ])('is not one: %s', (_what, status, body) => {
    expect(isRestoringAnswer(status, body)).toBe(false);
  });
});
