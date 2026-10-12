import './signin.css';
import { ApiError, api, type InvitePreview, type Me } from '../api';
import { setSignedIn, signOut, type AuthState } from '../auth';
import { cloudErrorMessage } from '../cloud-logic';
import { h } from './dom';
import {
  clearSignInRecovery,
  createVerifyFlow,
  INVALID_INVITE_MESSAGE,
  invalidInviteMessage,
  isInviteTokenShape,
  isInvalidSignInLink,
  joinEmailPlaceholder,
  readSignInRecovery,
  saveSignInRecovery,
  SIGNIN_COPY,
  signInRequest,
  verifyScreen,
} from './signin-logic';

interface SignInOptions {
  notice?: string;
  invite?: { token: string; teamName: string };
  oauthRequest?: string;
  initialEmail?: string;
  failedVerify?: boolean;
}

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const FAILED = 'Could not sign you in. Try again.';
const GENERIC = 'Something went wrong. Try again.';
const EXPIRED_LINK = SIGNIN_COPY.expiredLinkHeading;

function page(...body: (Node | null)[]): HTMLElement {
  return h('main', { class: 'signin' },
    h('header', { class: 'signin-top' }, h('div', { class: 'wordmark' }, 'Tabula')),
    h('div', { class: 'signin-body' }, h('div', { class: 'signin-col' }, ...body)));
}

function describe(err: unknown): string {
  if (!(err instanceof ApiError)) return GENERIC;
  if (err.status === 429) return err.code === 'rate_limited' && err.message !== err.code ? err.message : 'Too many sign-in requests. Try again in a few minutes.';
  if (err.status === 0 || err.code === 'network') return NETWORK;
  return err.code === 'unknown' ? GENERIC : err.message;
}

export function renderSignIn(root: HTMLElement, opts: SignInOptions = {}): void {
  const invite = opts.invite;
  document.title = invite ? `Join ${invite.teamName} - Tabula` : 'Sign in - Tabula';
  const heading = invite ? `Join ${invite.teamName}` : 'Sign in to Tabula';

  function showForm(notice?: string, initialEmail = opts.initialEmail ?? ''): void {
    const recoveryInvite = Boolean(opts.failedVerify && invite);
    const email = h('input', {
      class: recoveryInvite && initialEmail ? 'input' : 'input signin-recovery-email',
      type: recoveryInvite && initialEmail ? 'hidden' : 'email',
      name: 'email',
      autocomplete: 'email',
      required: true,
      'aria-label': 'Email',
      value: initialEmail,
      ...(!initialEmail && invite ? { placeholder: joinEmailPlaceholder(false) } : {}),
    });
    const submitLabel = recoveryInvite ? SIGNIN_COPY.sendNewLink : SIGNIN_COPY.emailButton;
    const submit = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    let error: HTMLElement | null = null;
    const setError = (msg: string | null) => {
      error?.remove();
      error = null;
      email.removeAttribute('aria-invalid');
      email.removeAttribute('aria-describedby');
      if (msg) {
        error = h('p', { class: 'signin-error', id: 'signin-error', role: 'alert' }, msg);
        submit.before(error);
        email.setAttribute('aria-invalid', 'true');
        email.setAttribute('aria-describedby', 'signin-error');
      }
    };

    const onSubmit = async (e: Event) => {
      e.preventDefault();
      const address = email.value.trim();
      setError(null);
      submit.disabled = true;
      submit.textContent = 'Sending…';
      if (invite) saveSignInRecovery({ email: address, inviteToken: invite.token, teamName: invite.teamName });
      try {
        const request = signInRequest(address, invite?.token, opts.oauthRequest);
        await api.requestLogin(request.email, request.invite, request.oauthRequest);
      } catch (err) {
        setError(describe(err) + (invite && err instanceof ApiError && err.status === 429 ? ' Your invitation still works. Open it again after the wait.' : ''));
        submit.disabled = false;
        submit.textContent = submitLabel;
        return;
      }
      if (recoveryInvite) showInviteRecoverySent();
      else showSent(address);
    };

    const recoveryLine = recoveryInvite
      ? initialEmail
        ? h('p', { class: 'signin-lede' }, SIGNIN_COPY.inviteRecoveryLine.replace('{email}', initialEmail))
        : h('p', { class: 'signin-lede' }, SIGNIN_COPY.inviteRecoveryLine.split('{email}')[0], email, '.')
      : null;
    const intro = opts.failedVerify
      ? invite ? recoveryLine : h('p', { class: 'signin-lede' }, SIGNIN_COPY.plainRecoveryLine)
      : invite
        ? h('p', { class: 'signin-lede' }, SIGNIN_COPY.joinEmailPrompt)
        : h('p', { class: 'signin-lede' }, "Enter your work email and we'll send you a link to sign in.");
    const title = opts.failedVerify ? EXPIRED_LINK : heading;
    const emailField = recoveryInvite && initialEmail
      ? email
      : recoveryInvite
        ? null
        : h('label', { class: 'signin-field' }, 'Email', email);

    root.replaceChildren(page(
      h('h1', null, title),
      h('form', { class: 'signin-form', onsubmit: onSubmit },
        intro,
        notice ? h('p', { class: 'signin-notice', role: 'status' }, notice) : null,
        emailField,
        submit),
    ));
    if (!recoveryInvite || !initialEmail) email.focus();
  }

  function showSent(email: string): void {
    root.replaceChildren(page(
      h('h1', null, 'Check your email'),
      h('p', { class: 'signin-lede', role: 'status' },
        'We sent a sign-in link to ', h('b', null, email), '. It works once and expires in 15 minutes.'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => showForm(undefined, '') }, SIGNIN_COPY.useDifferentEmail),
    ));
  }

  function showInviteRecoverySent(): void {
    root.replaceChildren(page(
      h('h1', null, EXPIRED_LINK),
      h('p', { class: 'signin-lede', role: 'status' }, SIGNIN_COPY.inviteRecoverySent),
      h('a', {
        class: 'btn ghost',
        href: '#',
        onclick: (e: Event) => { e.preventDefault(); showForm(undefined, ''); },
      }, SIGNIN_COPY.useDifferentEmail),
    ));
  }

  showForm(opts.notice);
}

export async function renderVerify(root: HTMLElement, token: string, done: (me: Me, oauthRequest?: string) => void, oauthRequest?: string, inviteToken?: string): Promise<void> {
  document.title = 'Sign in - Tabula';
  const flow = createVerifyFlow(async () => { await api.verifyLogin(token); });
  const button = h('button', { type: 'button', class: 'btn primary' }, SIGNIN_COPY.continueButton);
  button.addEventListener('click', async () => {
    const attempt = flow.continue();
    const screen = verifyScreen(flow.state);
    button.disabled = screen !== 'confirmation';
    button.textContent = screen === 'working' ? 'Signing in…' : SIGNIN_COPY.continueButton;
    try {
      if (!await attempt) return;
    } catch (err) {
      if (isInvalidSignInLink(err)) {
        const recovery = readSignInRecovery();
        if (inviteToken) {
          const recoveryMatches = recovery?.inviteToken === inviteToken;
          renderSignIn(root, {
            failedVerify: true,
            initialEmail: recoveryMatches ? recovery?.email ?? '' : '',
            invite: { token: inviteToken, teamName: recoveryMatches ? recovery?.teamName ?? 'your team' : 'your team' },
            oauthRequest,
          });
        } else {
          renderSignIn(root, { failedVerify: true, oauthRequest });
        }
      } else {
        renderSignIn(root, { notice: (inviteToken ? invalidInviteMessage(err) : null) ?? cloudErrorMessage(err) ?? FAILED, oauthRequest });
      }
      return;
    }

    let me: Me;
    try {
      me = await api.me();
    } catch {
      renderSignIn(root, { notice: FAILED, oauthRequest });
      return;
    }
    clearSignInRecovery();
    await setSignedIn(me);
    if (oauthRequest) done(me, oauthRequest);
    else done(me);
  });

  root.replaceChildren(page(
    h('h1', null, 'Sign in to Tabula'),
    h('p', { class: 'signin-lede' }, `Select ${SIGNIN_COPY.continueButton} to use this sign-in link.`),
    button,
  ));
}

export async function renderInvite(root: HTMLElement, token: string, auth: AuthState, done: (me: Me) => void): Promise<void> {
  document.title = 'Join team - Tabula';
  if (!isInviteTokenShape(token)) {
    root.replaceChildren(page(
      h('h1', null, 'Invite link'),
      h('p', { class: 'signin-lede' }, INVALID_INVITE_MESSAGE),
      h('a', { class: 'btn', href: '#/signin' }, 'Sign in'),
    ));
    return;
  }
  root.replaceChildren(page(h('p', { class: 'signin-lede', role: 'status' }, 'Checking your invite…')));

  let preview: InvitePreview;
  try {
    preview = await api.invitePreview(token);
  } catch (err) {
    const invalid = invalidInviteMessage(err);
    if (invalid) {
      root.replaceChildren(page(
        h('h1', null, 'Invite link'),
        h('p', { class: 'signin-lede' }, invalid),
        h('a', { class: 'btn', href: '#/signin' }, 'Sign in'),
      ));
    } else {
      root.replaceChildren(page(
        h('h1', null, 'Could not load this invite'),
        h('p', { class: 'signin-lede' }, 'Check your connection and try again.'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => renderInvite(root, token, auth, done) }, 'Try again'),
      ));
    }
    return;
  }

  const { team, role } = preview;
  if (auth.mode !== 'signed-in') {
    renderSignIn(root, { invite: { token, teamName: team.name } });
    return;
  }

  const joinBtn = h('button', { type: 'button', class: 'btn primary' }, 'Join team');
  let error: HTMLElement | null = null;
  const join = async () => {
    error?.remove();
    error = null;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    let me: Me;
    try {
      await api.acceptInvite(token);
      me = await api.me();
    } catch (err) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join team';
      error = h('p', { class: 'signin-error', role: 'alert' }, invalidInviteMessage(err) ?? describe(err));
      joinBtn.before(error);
      return;
    }
    await setSignedIn(me);
    done(me);
  };
  joinBtn.addEventListener('click', join);

  const anotherEmail = h('a', {
    href: '#',
    onclick: async (e: Event) => {
      e.preventDefault();
      await signOut().catch(() => undefined);
      renderSignIn(root, { invite: { token, teamName: team.name }, initialEmail: '' });
    },
  }, SIGNIN_COPY.anotherEmail);

  root.replaceChildren(page(
    h('h1', null, `Join ${team.name}`),
    h('p', { class: 'signin-lede' }, `You've been invited to join as ${role === 'admin' ? 'an admin' : 'a member'}.`),
    h('p', { class: 'signin-lede' }, SIGNIN_COPY.joiningAs.replace('{email}', auth.me.user.email)),
    anotherEmail,
    joinBtn,
  ));
}
