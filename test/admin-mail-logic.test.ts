import { describe, expect, it } from 'vitest';
import { mailRefusalBanner } from '../src/ui/admin-mail-logic';

const tail = 'People who did not get their link can ask for a new one once this is fixed.';

describe('admin mail status copy', () => {
  it('shows the banner only while there is a recent failure, with the reason in words', () => {
    expect(mailRefusalBanner({ refusedRecently: 1, reason: 'relay_rate_limited' })).toBe(`Some sign-in emails could not be sent recently: too many were sent from this workspace. ${tail}`);
    expect(mailRefusalBanner({ refusedRecently: 2, reason: 'relay_error' })).toBe(`Some sign-in emails could not be sent recently: the mail service refused them. ${tail}`);
    expect(mailRefusalBanner({ refusedRecently: 1, reason: 'network' })).toBe(`Some sign-in emails could not be sent recently: the mail service was unreachable. ${tail}`);
    expect(mailRefusalBanner({ refusedRecently: 1, reason: 'something_new' })).toContain('the mail service refused them');
    expect(mailRefusalBanner({ refusedRecently: 0, reason: null })).toBeNull();
    expect(mailRefusalBanner(undefined)).toBeNull();
  });
});
