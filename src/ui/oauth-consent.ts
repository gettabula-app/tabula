import './oauth-consent.css';
import { ApiError, api, type Me, type OAuthConsentRequest } from '../api';
import { signOut } from '../auth';
import { renderSignIn } from './signin';
import { h } from './dom';
import {
  boardsCeiling,
  errorSentence,
  hostPresentation,
  isOAuthEnvelope,
  MAX_OAUTH_BOARD_IDS,
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

function scopeRank(scope: OAuthScope): number {
  return scope === 'write' ? 3 : scope === 'comment' ? 2 : 1;
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'editor') return 'Editor';
  if (role === 'commenter') return 'Commenter';
  return 'Viewer';
}

function consentPage(
  root: HTMLElement,
  envelope: string,
  me: Me,
  request: OAuthConsentRequest,
  notice = '',
  selectedBoardIds: string[] = [],
  selectedMode: 'all' | 'boards' = 'all',
): void {
  document.title = 'Connect an app - Tabula';
  const workspace = typeof location !== 'undefined' && typeof location.host === 'string' ? location.host : '';
  const heading = h('h1', { tabindex: '-1' }, titleText(request.clientName, request.clientNameIsClaim, workspace));
  const host = hostPresentation(request.redirectHost, request.redirectUri, request.verified === true);
  const alert = h('p', { class: 'oauth-consent-error', 'aria-live': 'polite' }, notice);
  const boards = Array.isArray(request.boards) ? request.boards : [];
  const pickerAvailable = request.pickerAvailable === true && boards.length > 0;
  const unrestrictedScope = request.scopes?.unrestricted ?? request.maxScope;
  // A missing scopes.boards on a malformed newer response fails closed at the unrestricted ceiling.
  const boardScope = request.scopes?.boards ?? request.maxScope;
  let mode: 'all' | 'boards' = pickerAvailable && selectedMode === 'boards' ? 'boards' : 'all';
  const selected = new Set(boards.filter((board) => selectedBoardIds.includes(board.id)).map((board) => board.id));
  let selectedScope: OAuthScope = 'read';
  let busy = false;
  let scopeRadios: HTMLInputElement[] = [];
  const boardCheckboxes: HTMLInputElement[] = [];
  const scopeFieldset = h('fieldset', { class: 'oauth-consent-level' });
  const boardCount = h('p', { class: 'oauth-consent-board-count', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const boardList = h('div', { class: 'oauth-consent-board-list', role: 'group', 'aria-label': 'Choose boards' });
  const boardSelection = h('div', { class: 'oauth-consent-board-selection' }, boardCount, boardList);
  const disclosure = h('p', { class: 'oauth-consent-disclosure' });
  const accessNote = h('p', { class: 'oauth-consent-note', hidden: true });
  const pickerRadios: HTMLInputElement[] = [];
  let pickerFieldset: HTMLFieldSetElement | null = null;

  function checkedScope(): OAuthScope {
    const value = scopeRadios.find((radio) => radio.checked)?.value;
    return value === 'comment' || value === 'write' ? value : 'read';
  }

  function renderScopeOptions(): void {
    const currentScope = scopeRadios.length > 0 ? checkedScope() : selectedScope;
    const ceiling = mode === 'boards'
      ? boardsCeiling(boardScope, boards.filter((board) => selected.has(board.id)).map((board) => board.role))
      : unrestrictedScope;
    const options = scopeOptions(ceiling);
    selectedScope = options.some((option) => option.value === currentScope) ? currentScope : 'read';
    scopeRadios = [];
    scopeFieldset.replaceChildren(h('legend', null, 'Access level'), ...options.map((option) => {
      const radio = h('input', {
        type: 'radio', name: 'oauth-scope', value: option.value, checked: option.value === selectedScope,
        onchange: () => { selectedScope = option.value; },
      });
      scopeRadios.push(radio);
      return h('label', { class: 'oauth-consent-scope' }, radio,
        h('span', { class: 'oauth-consent-scope-copy' },
          h('span', { class: 'oauth-consent-scope-label' }, option.label),
          h('span', { class: 'oauth-consent-scope-help' }, option.help)));
    }));
  }

  function syncControls(): void {
    const chosenCount = selected.size;
    boardCount.textContent = chosenCount === 0 ? 'Choose at least one board.'
      : chosenCount >= MAX_OAUTH_BOARD_IDS ? `${chosenCount} boards chosen, the most allowed.`
      : `${chosenCount} board${chosenCount === 1 ? '' : 's'} chosen`;
    boardSelection.hidden = mode !== 'boards';
    pickerRadios.forEach((radio) => { radio.disabled = busy; });
    scopeRadios.forEach((radio) => { radio.disabled = busy; });
    boardCheckboxes.forEach((input) => {
      input.disabled = busy || (!input.checked && chosenCount >= MAX_OAUTH_BOARD_IDS);
    });
    deny.disabled = busy;
    allow.disabled = busy || request.readOnly || (pickerAvailable && mode === 'boards' && chosenCount === 0);
    disclosure.textContent = pickerAvailable && mode === 'boards'
      ? 'This app can only access the boards you chose. Boards you get access to later are not included. It acts as you, never as more. You can disconnect it at any time under AI tool access.'
      : 'This app can access all boards you can open, now and later. It acts as you, never as more. You can disconnect it at any time under AI tool access.';
    let note = '';
    if (pickerAvailable && mode === 'all' && scopeRank(boardScope) > scopeRank(unrestrictedScope)) {
      note = 'Reading is all that is allowed on every board at once. Choose boards to allow more.';
    } else if (!pickerAvailable && request.maxScope === 'read') {
      note = 'Your role limits this app to reading.';
    }
    accessNote.textContent = note;
    accessNote.hidden = !note;
  }

  function changeMode(nextMode: 'all' | 'boards'): void {
    selectedScope = scopeRadios.length > 0 ? checkedScope() : selectedScope;
    mode = nextMode;
    renderScopeOptions();
    syncControls();
  }

  renderScopeOptions();
  if (pickerAvailable) {
    const allBoardsRadio = h('input', {
      type: 'radio', name: 'oauth-board-mode', value: 'all', checked: mode === 'all',
      onchange: () => { changeMode('all'); },
    });
    const chosenBoardsRadio = h('input', {
      type: 'radio', name: 'oauth-board-mode', value: 'boards', checked: mode === 'boards',
      onchange: () => { changeMode('boards'); },
    });
    pickerRadios.push(allBoardsRadio, chosenBoardsRadio);
    for (const board of boards) {
      const checkbox = h('input', { type: 'checkbox', name: 'oauth-board', value: board.id, checked: selected.has(board.id) });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(board.id);
        else selected.delete(board.id);
        selectedScope = checkedScope();
        renderScopeOptions();
        syncControls();
      });
      boardCheckboxes.push(checkbox);
      boardList.appendChild(h('label', { class: 'oauth-consent-board' }, checkbox,
        h('span', { class: 'oauth-consent-board-name' }, board.name),
        h('span', { class: 'oauth-consent-board-role' }, roleLabel(board.role))));
    }
    boardCount.textContent = 'Choose at least one board.';
    const picker = h('fieldset', { class: 'oauth-consent-picker' },
      h('legend', null, 'Which boards'),
      h('label', { class: 'oauth-consent-mode' }, allBoardsRadio, 'All boards I can open'),
      h('label', { class: 'oauth-consent-mode' }, chosenBoardsRadio, 'Only boards I choose'),
      boardSelection);
    // Stored separately so the fieldset is inserted only for responses that contain a usable board list.
    pickerFieldset = picker;
  }

  const deny = h('button', { type: 'button', class: 'oauth-consent-button', onclick: () => { void decide('deny'); } }, 'Deny');
  const allow = h('button', {
    type: 'button', class: 'oauth-consent-button primary', disabled: request.readOnly,
    onclick: () => { void decide('allow'); },
  }, 'Allow');

  function setBusy(value: boolean): void {
    busy = value;
    syncControls();
  }

  async function decide(decision: 'allow' | 'deny'): Promise<void> {
    if (deny.disabled || allow.disabled && decision === 'allow') return;
    setBusy(true);
    alert.textContent = '';
    const input = decision === 'deny'
      ? { request: envelope, decision, nonce: request.nonce } as const
      : {
        request: envelope,
        decision,
        scope: checkedScope(),
        nonce: request.nonce,
        ...(pickerAvailable && mode === 'boards' ? { boardIds: boards.filter((board) => selected.has(board.id)).map((board) => board.id) } : {}),
      } as const;
    try {
      const answer = await api.oauthDecision(input);
      location.assign(answer.redirect);
    } catch (error) {
      const details = apiFailure(error);
      if (details.status === 404) {
        plainLine(root, OAUTH_REQUEST_INVALID);
        return;
      }
      if (details.status === 400 && (details.code === 'invalid_scope' || details.code === 'invalid_boards')) {
        const keepBoardMode = pickerAvailable && mode === 'boards';
        const keepSelected = keepBoardMode ? boards.filter((board) => selected.has(board.id)).map((board) => board.id) : [];
        try {
          const refreshed = await api.oauthRequest(envelope);
          consentPage(root, envelope, me, refreshed, errorSentence(details.status, details.code), keepSelected, keepBoardMode ? 'boards' : 'all');
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
    pickerFieldset,
    scopeFieldset,
    accessNote,
    disclosure,
    request.readOnly
      ? h('p', { class: 'oauth-consent-note' }, 'This workspace is read-only. Ask the workspace owner to check billing.')
      : null,
    alert,
    h('div', { class: 'oauth-consent-actions' }, deny, allow),
  ));
  syncControls();
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
