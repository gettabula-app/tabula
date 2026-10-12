import { describe, expect, it } from 'vitest';
import { INVITE_DIALOG_NOTE, inviteSummary, inviteUsageText } from '../src/ui/teams-logic';

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 24 * 60 * 60 * 1000;

describe('invite summary copy', () => {
  it('keeps the classroom invite dialog note exact', () => {
    expect(INVITE_DIALOG_NOTE).toBe('Anyone with this link can join as a member until it expires, so send it only to the people you want in. One link is enough for a whole class.');
  });

  it('uses the expired form and a plural use count', () => {
    expect(inviteSummary(NOW - 1, 3, NOW)).toBe('Expired · Used 3 times');
  });

  it('uses the zero and singular use forms', () => {
    expect(inviteUsageText(0)).toBe('Not used yet');
    expect(inviteUsageText(1)).toBe('Used once');
  });

  it('uses the singular expiry form and the zero-use phrase together', () => {
    expect(inviteSummary(NOW + DAY, 0, NOW)).toBe('Expires in 1 day · Not used yet');
    expect(inviteSummary(NOW + 1, 1, NOW)).toBe('Expires in 1 day · Used once');
  });

  it('rounds any positive remaining time up to a day', () => {
    expect(inviteSummary(NOW + DAY + 1, 2, NOW)).toBe('Expires in 2 days · Used 2 times');
  });
});
