import { describe, expect, it } from 'vitest';
import { answeredLabel, countPeople } from '../src/polls';

describe('countPeople', () => {
  it('counts one person once, however many tabs they have open', () => {
    expect(countPeople([{ user: { id: 'ana' } }, { user: { id: 'ana' } }, { user: { id: 'ben' } }])).toBe(2);
  });

  it('ignores presences without a user', () => {
    expect(countPeople([{ user: { id: 'ana' } }, {}, { user: undefined }])).toBe(1);
  });

  it('ignores a user without an id', () => {
    expect(countPeople([{ user: { id: '' } }, { user: { id: 'ana' } }])).toBe(1);
  });

  it('is zero with nobody on the board', () => {
    expect(countPeople([])).toBe(0);
  });
});

describe('answeredLabel', () => {
  it('reads responses of people on the board', () => {
    expect(answeredLabel(2, 3)).toBe('2 of 3 answered');
  });

  it('shows zero of the people when nobody has answered', () => {
    expect(answeredLabel(0, 3)).toBe('0 of 3 answered');
  });

  it('never shows fewer people than responses, for someone who answered and then left', () => {
    expect(answeredLabel(3, 2)).toBe('3 of 3 answered');
  });
});
