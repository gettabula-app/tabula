export type VerifyFlowState = 'confirm' | 'verifying' | 'complete';
export type VerifyScreen = 'confirmation' | 'working' | 'complete';

export const SIGNIN_COPY = {
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
} as const;

export const INVALID_INVITE_MESSAGE = 'This invitation is no longer valid. Ask the person who invited you for a new link.';
const INVITE_TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]{43}$/;

export function verifyScreen(state: VerifyFlowState): VerifyScreen {
  if (state === 'confirm') return 'confirmation';
  return state === 'verifying' ? 'working' : 'complete';
}

/** Keeps the verify request behind an explicit click and permits only one in-flight attempt. */
export function createVerifyFlow(verify: () => Promise<void>) {
  let state: VerifyFlowState = 'confirm';
  return {
    get state(): VerifyFlowState { return state; },
    async continue(): Promise<boolean> {
      if (state !== 'confirm') return false;
      state = 'verifying';
      try {
        await verify();
        state = 'complete';
        return true;
      } catch (error) {
        state = 'confirm';
        throw error;
      }
    },
  };
}

export interface SignInRecovery {
  email: string;
  inviteToken?: string;
  teamName?: string;
}

const RECOVERY_KEY = 'tabula:signin-recovery';
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** Storage is a convenience only: the sign-in and resend flows still work when it is unavailable. */
export function saveSignInRecovery(value: SignInRecovery, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    target?.setItem(RECOVERY_KEY, JSON.stringify(value));
  } catch {
    // Keep the flow usable when browser storage is blocked or full.
  }
}

export function readSignInRecovery(storage?: Pick<Storage, 'getItem'>): SignInRecovery | null {
  try {
    const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    const raw = target?.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.email !== 'string') return null;
    return {
      email: value.email,
      ...(typeof value.inviteToken === 'string' && INVITE_TOKEN_RE.test(value.inviteToken) ? { inviteToken: value.inviteToken } : {}),
      ...(typeof value.teamName === 'string' ? { teamName: value.teamName } : {}),
    };
  } catch {
    return null;
  }
}

export function clearSignInRecovery(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    target?.removeItem(RECOVERY_KEY);
  } catch {
    // Storage is optional.
  }
}

export function isInvalidSignInLink(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.code === 'invalid_token' || value.status === 400;
}

export const EXHAUSTED_INVITE_MESSAGE = 'This invitation has been used up. Ask the person who invited you for a new link.';

export function invalidInviteMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { status?: unknown; code?: unknown };
  if (value.code === 'invite_exhausted') return EXHAUSTED_INVITE_MESSAGE;
  return value.status === 400 || value.status === 404
    ? INVALID_INVITE_MESSAGE
    : null;
}

export function isInviteTokenShape(token: string): boolean {
  return INVITE_TOKEN_SHAPE_RE.test(token);
}

export function joinEmailPlaceholder(educationWorkspace: boolean): string {
  return educationWorkspace ? 'you@school.se' : 'you@example.com';
}

export function signInRequest(email: string, inviteToken?: string, oauthRequest?: string) {
  return {
    email,
    ...(inviteToken ? { invite: inviteToken } : {}),
    ...(oauthRequest ? { oauthRequest } : {}),
  };
}
