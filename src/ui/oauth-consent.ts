import './oauth-consent.css';
import { ApiError, api, type Me, type OAuthConsentRequest } from '../api';
import { signOut } from '../auth';
import { renderSignIn } from './signin';
import { h } from './dom';
import {
  errorSentence,
  hostPresentation,
  isOAuthEnvelope,
  OAUTH_FRAMED_PAGE,
  OAUTH_REQUEST_INVALID,
  scopeOptions,
  titleText,
  type OAuthScope,
} from './oauth-consent-logic';

function page(...children: (Node | null)[]): HTMLElement {
  return h('main', { class: 'oauth-consent' },
    h('header', { class: 'oauth-consent-top' }, h('div', { class: 'wordmark' }, 'Tabula')),
    h('div', { class: 'oauth-consent-body' }, h('div', { class: 'oauth-consent-col' }, ...children)));
}

function plainLine(root: HTMLElement, message: string): void {
  root.replaceChildren(h('p', { class: 'oauth-consent-plain', 'aria-live': 'polite' }, message));
}

function apiFailure(error: unknown): { status: number; code: string; retryAfter?: number } {
  if (!(error instanceof ApiError)) return { status: 0, code: 'unknown' };
  const retryAfter = error.facts.retryAfter;
  return {
    status: error.status,
    code: error.code,
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
  };
}

function requestFailure(root: HTMLElement, error: unknown, retry: () => void): void {
  const details = apiFailure(error);
  const sentence = errorSentence(details.status, details.code, details.retryAfter);
  if (details.status === 404) {
    plainLine(root, OAUTH_REQUEST_INVALID);
    return;
  }
  const heading = h('h1', { tabindex: '-1' }, 'Connect an app to Tabula');
  root.replaceChildren(page(
    heading,
    h('p', { class: 'oauth-consent-error', 'aria-live': 'polite' }, sentence),
    h('button', { type: 'button', class: 'oauth-consent-button', onclick: retry }, 'Try again'),
  ));
  heading.focus();
}

function consentPage(root: HTMLElement, envelope: string, me: Me, request: OAuthConsentRequest, notice = ''): void {
  document.title = 'Connect an app - Tabula';
  const workspace = typeof location !== 'undefined' && typeof location.host === 'string' ? location.host : '';
  const heading = h('h1', { tabindex: '-1' }, titleText(request.clientName, request.clientNameIsClaim, workspace));
  const host = hostPresentation(request.redirectHost, request.redirectUri, request.verified === true);
  const alert = h('p', { class: 'oauth-consent-error', 'aria-live': 'polite' }, notice);
  const deny = h('button', { type: 'button', class: 'oauth-consent-button', onclick: () => { void decide('deny'); } }, 'Deny');
  const allow = h('button', {
    type: 'button', class: 'oauth-consent-button primary', disabled: request.readOnly,
    onclick: () => { void decide('allow'); },
  }, 'Allow');
  const radioInputs: HTMLInputElement[] = [];

  function setBusy(busy: boolean): void {
    deny.disabled = busy;
    allow.disabled = busy || request.readOnly;
  }

  async function decide(decision: 'allow' | 'deny'): Promise<void> {
    if (deny.disabled || allow.disabled && decision === 'allow') return;
    setBusy(true);
    alert.textContent = '';
    const scope = radioInputs.find((radio) => radio.checked)?.value as OAuthScope | undefined;
    const input = decision === 'deny'
      ? { request: envelope, decision, nonce: request.nonce } as const
      : { request: envelope, decision, scope: scope ?? 'read', nonce: request.nonce } as const;
    try {
      const answer = await api.oauthDecision(input);
      location.assign(answer.redirect);
    } catch (error) {
      const details = apiFailure(error);
      if (details.status === 404) {
        plainLine(root, OAUTH_REQUEST_INVALID);
        return;
      }
      if (details.status === 400 && details.code === 'invalid_scope') {
        try {
          const refreshed = await api.oauthRequest(envelope);
          consentPage(root, envelope, me, refreshed, errorSentence(details.status, details.code));
          return;
        } catch (refreshError) {
          const refreshedDetails = apiFailure(refreshError);
          if (refreshedDetails.status === 404) {
            plainLine(root, OAUTH_REQUEST_INVALID);
            return;
          }
          setBusy(false);
          alert.textContent = errorSentence(refreshedDetails.status, refreshedDetails.code, refreshedDetails.retryAfter);
          return;
        }
      }
      setBusy(false);
      alert.textContent = errorSentence(details.status, details.code, details.retryAfter);
    }
  }

  const options = scopeOptions(request.maxScope).map((option) => {
    const radio = h('input', {
      type: 'radio', name: 'oauth-scope', value: option.value, checked: option.value === 'read',
    });
    radioInputs.push(radio);
    return h('label', { class: 'oauth-consent-scope' }, radio,
      h('span', { class: 'oauth-consent-scope-copy' },
        h('span', { class: 'oauth-consent-scope-label' }, option.label),
        h('span', { class: 'oauth-consent-scope-help' }, option.help)));
  });

  const account = h('div', { class: 'oauth-consent-account' },
    h('p', null, `Signed in as ${me.user.name} (${me.user.email})`),
    h('button', {
      type: 'button', class: 'oauth-consent-signout',
      onclick: async () => {
        await signOut().catch(() => undefined);
        renderSignIn(root, { notice: 'Sign in to connect an app to Tabula.', oauthRequest: envelope });
      },
    }, 'Not you? Sign out'));

  root.replaceChildren(page(
    heading,
    account,
    h('section', { class: 'oauth-consent-destination' },
      h('h2', null, 'You will be sent back to'),
      h('code', { class: 'oauth-consent-host' }, host.label),
      host.verified ? h('span', { class: 'oauth-consent-badge' }, 'Verified host') : null,
      host.warning ? h('p', { class: 'oauth-consent-warning' }, host.warning) : null,
      h('details', null,
        h('summary', null, 'Show full redirect URI'),
        h('code', { class: 'oauth-consent-uri' }, request.redirectUri))),
    h('fieldset', { class: 'oauth-consent-level' },
      h('legend', null, 'Access level'),
      options),
    request.maxScope === 'read'
      ? h('p', { class: 'oauth-consent-note' }, 'Your role limits this app to reading until board selection is available.')
      : null,
    h('p', { class: 'oauth-consent-disclosure' },
      'This app can access all boards you can open, now and later. It acts as you, never as more. You can disconnect it at any time under AI tool access.'),
    request.readOnly
      ? h('p', { class: 'oauth-consent-note' }, 'This workspace is read-only. Ask the workspace owner to check billing.')
      : null,
    alert,
    h('div', { class: 'oauth-consent-actions' }, deny, allow),
  ));
  heading.focus();
}

/** Render only after the opaque envelope passes its local shape check. */
export function renderOAuthConsent(root: HTMLElement, envelope: string): void {
  if (typeof window !== 'undefined' && window.top !== window.self) {
    plainLine(root, OAUTH_FRAMED_PAGE);
    return;
  }
  if (!isOAuthEnvelope(envelope)) {
    plainLine(root, OAUTH_REQUEST_INVALID);
    return;
  }

  document.title = 'Connect an app - Tabula';
  root.replaceChildren(page(h('p', { class: 'oauth-consent-loading', role: 'status' }, 'Loading connection request…')));

  const load = async () => {
    let me: Me;
    try {
      me = await api.me();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        renderSignIn(root, { notice: 'Sign in to connect an app to Tabula.', oauthRequest: envelope });
      } else {
        requestFailure(root, error, () => { void load(); });
      }
      return;
    }
    if (me.user.role === 'guest') {
      plainLine(root, OAUTH_REQUEST_INVALID);
      return;
    }
    try {
      const request = await api.oauthRequest(envelope);
      consentPage(root, envelope, me, request);
    } catch (error) {
      requestFailure(root, error, () => { void load(); });
    }
  };
  void load();
}
