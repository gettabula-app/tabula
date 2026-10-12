import { describe, expect, it, vi } from 'vitest';
import {
  clearSignInRecovery,
  createVerifyFlow,
  invalidInviteMessage,
  isInvalidSignInLink,
  isInviteTokenShape,
  joinEmailPlaceholder,
  INVALID_INVITE_MESSAGE,
  readSignInRecovery,
  saveSignInRecovery,
  SIGNIN_COPY,
  signInRequest,
  verifyScreen,
} from '../src/ui/signin-logic';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    setItem: (key: string, value: string) => values.set(key, value),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
  };
}

describe('verify flow logic', () => {
  it('does not invoke the verify request until Continue is clicked', async () => {
    const verify = vi.fn<() => Promise<void>>(async () => undefined);
    const flow = createVerifyFlow(verify);

    expect(flow.state).toBe('confirm');
    expect(verifyScreen(flow.state)).toBe('confirmation');
    expect(verify).not.toHaveBeenCalled();
    expect(await flow.continue()).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(flow.state).toBe('complete');
    expect(verifyScreen(flow.state)).toBe('complete');
    expect(await flow.continue()).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('ignores a second click while the first verify request is pending', async () => {
    let finish!: () => void;
    const verify = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => { finish = resolve; }));
    const flow = createVerifyFlow(verify);
    const first = flow.continue();

    expect(flow.state).toBe('verifying');
    expect(verifyScreen(flow.state)).toBe('working');
    expect(await flow.continue()).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
  });

  it('returns to confirmation after a failed attempt so a network error can be retried', async () => {
    const flow = createVerifyFlow(async () => { throw new Error('offline'); });
    await expect(flow.continue()).rejects.toThrow('offline');
    expect(flow.state).toBe('confirm');
  });
});

describe('sign-in recovery state', () => {
  it('stores the typed email and invite context when storage is available', () => {
    const storage = memoryStorage();
    saveSignInRecovery({ email: 'pupil@example.com', inviteToken: 'invite-token', teamName: 'Class' }, storage);
    expect(readSignInRecovery(storage)).toEqual({ email: 'pupil@example.com', inviteToken: 'invite-token', teamName: 'Class' });
    clearSignInRecovery(storage);
    expect(readSignInRecovery(storage)).toBeNull();
  });

  it('keeps rendering usable if session storage throws', () => {
    const storage = {
      setItem: () => { throw new Error('blocked'); },
      getItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(() => saveSignInRecovery({ email: 'pupil@example.com' }, storage)).not.toThrow();
    expect(readSignInRecovery(storage)).toBeNull();
    expect(() => clearSignInRecovery(storage)).not.toThrow();
  });

  it('uses the invalid-link and invalid-invite branches only for matching status codes', () => {
    expect(isInvalidSignInLink({ status: 400, code: 'invalid_token' })).toBe(true);
    expect(isInvalidSignInLink({ status: 503, code: 'mail_unavailable' })).toBe(false);
    expect(invalidInviteMessage({ status: 404 })).toBe(INVALID_INVITE_MESSAGE);
    expect(invalidInviteMessage({ status: 400 })).toBe(INVALID_INVITE_MESSAGE);
    expect(invalidInviteMessage({ status: 503 })).toBeNull();
    expect(isInviteTokenShape('A'.repeat(43))).toBe(true);
    expect(isInviteTokenShape('short')).toBe(false);
  });

  it('uses the school example only when the workspace is marked as education', () => {
    expect(joinEmailPlaceholder(true)).toBe('you@school.se');
    expect(joinEmailPlaceholder(false)).toBe('you@example.com');
  });

  it('keeps the invite and entered email together for a resend request', () => {
    expect(signInRequest('pupil@example.com', 'class-invite')).toEqual({
      email: 'pupil@example.com',
      invite: 'class-invite',
    });
    expect(signInRequest('person@example.com')).toEqual({ email: 'person@example.com' });
  });

  it('keeps the classroom sign-in, recovery, and join copy exact', () => {
    expect(SIGNIN_COPY).toMatchObject({
      expiredLinkHeading: 'This sign-in link has expired or was already used.',
      inviteRecoveryLine: 'Your invitation still works. We can send you a new sign-in link to {email}.',
      inviteRecoverySent: 'Sent. Open the newest email from Tabula; older links will not work.',
      sendNewLink: 'Send me a new link',
      useDifferentEmail: 'Use a different email',
      plainRecoveryLine: 'Request a new one below.',
      joinEmailPrompt: 'Enter your email and we send you a link to join.',
      continueButton: 'Continue to Tabula',
      joiningAs: 'Joining as {email}',
      anotherEmail: 'Not you? Sign in with another email',
      emailButton: 'Email me a link',
    });
    expect(INVALID_INVITE_MESSAGE).toBe('This invitation is no longer valid. Ask the person who invited you for a new link.');
  });
});
