import { describe, expect, it } from 'vitest';
import { mailRefusalBanner } from '../src/ui/admin-mail-logic';

describe('admin mail status copy', () => {
  it('shows the exact banner only while there is a recent refusal', () => {
    expect(mailRefusalBanner({ refusedRecently: 1, reason: 'relay_rate_limited' })).toBe(
      'Sign-in emails were refused recently (relay_rate_limited). People may not receive their links.',
    );
    expect(mailRefusalBanner({ refusedRecently: 0, reason: null })).toBeNull();
    expect(mailRefusalBanner(undefined)).toBeNull();
  });
});
