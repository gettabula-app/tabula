import './tokens.css';
import { rovingRadios } from './focus-scope';
import { ApiError, api, type AccessScope, type AccessToken, type AdminAccessToken, type AdminGrant, type ConnectedGrant, type CreatedAccessToken, type Me, type ServerBoard } from '../api';
import { cloudErrorMessage } from '../cloud-logic';
import { revokeVerdict } from './admin-logic';
import { dialog, fmtAgo, toast } from './common';
import { h } from './dom';
import {
  CONNECTED_APP_TEXT, EXPIRY_DAYS, MAX_BOARDS, SCOPE_OPTIONS, boardsLabel, boardsSummary, clientSnippets, draftProblem, emptyDraft, expiryLabel,
  grantBoardsText, grantExpiryText, grantScopeLabel, lastUsedLabel, mergeAdminAccessRows, scopeLabel, toRequest, type AdminAccessRow, type Draft,
} from './tokens-logic';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

function describe(e: unknown): string {
  const hosted = cloudErrorMessage(e);
  if (hosted) return hosted;
  if (e instanceof ApiError) {
    if (e.status === 0 || e.code === 'network') return NETWORK;
    if (e.code !== 'unknown' && e.message !== e.code) return e.message;
  }
  return GENERIC;
}

/** A destructive control: the first click arms it, the second runs it. */
function armed(label: string, armedLabel: string, run: () => Promise<unknown>, opts: { disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  let on = false;
  const button = h('button', { class: 'btn', disabled: opts.disabled, title: opts.title }, label);
  const reset = () => {
    on = false;
    button.textContent = label;
    button.classList.remove('armed');
  };
  button.addEventListener('click', async () => {
    if (!on) {
      on = true;
      button.textContent = armedLabel;
      button.classList.add('armed');
      return;
    }
    button.disabled = true;
    try {
      await run();
    } finally {
      button.disabled = Boolean(opts.disabled);
      reset();
    }
  });
  button.addEventListener('blur', reset);
  return button;
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('Could not copy. Select the text and copy it by hand.');
  }
}

/** A block of text that is meant to be copied: monospace, wraps, one Copy button. */
function codeBlock(label: string, text: string, what: string): HTMLElement {
  return h('div', { class: 'tokens-code-wrap' },
    h('div', { class: 'tokens-label' }, label),
    h('pre', { class: 'tokens-code', tabindex: 0 }, text),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => void copy(text, what) }, 'Copy')));
}

/** The "AI tool access" dialog: the person's own tokens, a form for a new one, and the one-time view of its secret. */
export function openTokensDialog(me: Me, onCreated?: () => void): void {
  const body = h('div', { class: 'tokens' });
  const { box, close } = dialog('AI tool access', body);
  box.classList.add('tokens-dialog');
  // Leaving the page takes the dialog, and with it a token that was just shown, away.
  const onLeave = () => {
    window.removeEventListener('hashchange', onLeave);
    close();
  };
  window.addEventListener('hashchange', onLeave);
  const toTop = () => box.querySelector('.modal-body')?.scrollTo(0, 0);

  let tokens: AccessToken[] = [];
  let grants: ConnectedGrant[] = [];
  let boards: ServerBoard[] = [];
  const titles = new Map<string, string>();
  const alive = () => body.isConnected;

  const intro = h('p', { class: 'tokens-intro' },
    'A token lets an AI tool such as Claude Code open your boards with your access, never more. Pick the lowest level it needs.');

  const showError = (e: unknown, retry: () => void) => {
    body.replaceChildren(intro, h('div', { class: 'tokens-error', role: 'alert' }, h('span', null, describe(e)), h('button', { class: 'btn', onclick: retry }, 'Retry')));
  };

  const load = () => {
    body.replaceChildren(intro, h('p', { class: 'tokens-state', role: 'status' }, 'Loading…'));
    void Promise.all([
      api.accessTokens(),
      api.boards().catch(() => [] as ServerBoard[]),
      me.mcpOauth ? api.myGrants() : Promise.resolve([] as ConnectedGrant[]),
    ]).then(
      ([list, mine, connected]) => {
        if (!alive()) return;
        tokens = list;
        grants = connected;
        boards = mine;
        titles.clear();
        for (const b of mine) titles.set(b.id, b.title || 'Untitled board');
        showList();
        toTop();
      },
      (e: unknown) => {
        if (alive()) showError(e, load);
      },
    );
  };

  const revoke = async (t: AccessToken) => {
    try {
      await api.revokeAccessToken(t.id);
      toast('Token revoked');
      load();
    } catch (e) {
      toast(describe(e));
    }
  };

  const revokeAll = async () => {
    try {
      const { revoked, grants: disconnected = 0 } = await api.revokeAllAccessTokens();
      const tokenResult = revoked === 1 ? '1 token revoked' : `${revoked} tokens revoked`;
      toast(disconnected > 0 ? CONNECTED_APP_TEXT.revokeAllDone(tokenResult, disconnected) : tokenResult);
      load();
    } catch (e) {
      toast(describe(e));
    }
  };

  const disconnect = async (grant: ConnectedGrant) => {
    try {
      await api.disconnectGrant(grant.id);
      toast(CONNECTED_APP_TEXT.doneOne);
      load();
    } catch (e) {
      toast(describe(e));
    }
  };

  const row = (t: AccessToken): HTMLElement => h('div', { class: 'tokens-row' },
    h('div', { class: 'tokens-who' },
      h('div', null, h('span', { class: 'tokens-name' }, t.name), h('span', { class: 'tokens-badge' }, scopeLabel(t.scope))),
      h('div', { class: 'tokens-meta' }, [
        boardsLabel(t.boardIds, titles),
        expiryLabel(t.expiresAt, Date.now()),
        lastUsedLabel(t, fmtAgo),
        `…${t.hint}`,
      ].join(' · '))),
    armed('Revoke', 'Click again to revoke', () => revoke(t)));

  function showList() {
    const actions = [h('button', { class: 'btn primary', onclick: showForm }, 'New token')];
    if (tokens.length || (me.mcpOauth && grants.length)) {
      actions.push(armed('Revoke all', grants.length ? CONNECTED_APP_TEXT.revokeAllWithApps : 'Click again to revoke all', revokeAll));
    }
    const sections: HTMLElement[] = [
      intro,
      h('div', { class: 'btn-row' }, actions),
      tokens.length
        ? h('div', { class: 'tokens-list' }, tokens.map(row))
        : h('p', { class: 'tokens-state' }, 'No tokens yet.'),
    ];
    if (me.mcpOauth) sections.push(connectedApps());
    body.replaceChildren(...sections);
  }

  function connectedApps(): HTMLElement {
    return h('section', { class: 'tokens-connected' },
      h('h3', { class: 'tokens-section-title' }, CONNECTED_APP_TEXT.section),
      grants.length
        ? h('div', { class: 'tokens-list' }, grants.map((grant) => h('div', { class: 'tokens-row tokens-grant-row' },
            h('div', { class: 'tokens-who' },
              h('div', null, h('span', { class: 'tokens-name' }, grant.clientName), h('span', { class: 'tokens-badge' }, grantScopeLabel(grant.scope))),
              h('div', { class: 'tokens-meta' }, [
                grant.redirectHost,
                grantBoardsText(grant.boardCount),
                `${CONNECTED_APP_TEXT.created} ${fmtAgo(grant.createdAt)}`,
                lastUsedLabel(grant, fmtAgo),
                grantExpiryText(grant.expiresAt, Date.now()),
              ].join(' · '))),
            armed(CONNECTED_APP_TEXT.disconnect, CONNECTED_APP_TEXT.confirmDisconnect, () => disconnect(grant)))))
        : h('p', { class: 'tokens-state' }, CONNECTED_APP_TEXT.empty));
  }

  function showForm() {
    const draft: Draft = emptyDraft();
    const problem = h('p', { class: 'tokens-problem', role: 'status' });
    const create = h('button', { class: 'btn primary' }, 'Create token');
    const scopeHint = h('p', { class: 'tokens-hint' });
    const boardsBody = h('div', null);

    const refresh = () => {
      const why = draftProblem(me.user.role, draft);
      problem.textContent = why ?? '';
      create.disabled = why !== null;
    };

    // One row of exclusive options. Buttons change in place, so keyboard focus stays where it was.
    const options = <T extends string | number>(label: string, items: { value: T; label: string }[], current: () => T, pick: (v: T) => void) => {
      const buttons = items.map((o) => h('button', {
        type: 'button',
        role: 'radio',
        onclick: () => {
          pick(o.value);
          mark();
          refresh();
        },
      }, o.label));
      const mark = () => items.forEach((o, i) => {
        const on = o.value === current();
        buttons[i].className = on ? 'tokens-opt on' : 'tokens-opt';
        buttons[i].setAttribute('aria-checked', String(on));
      });
      mark();
      const group = h('div', { class: 'tokens-opts', role: 'radiogroup', 'aria-label': label }, buttons);
      rovingRadios(group);
      return h('div', { class: 'tokens-field' },
        h('div', { class: 'tokens-label' }, label),
        group);
    };

    const paintBoards = () => {
      if (draft.allBoards) {
        boardsBody.replaceChildren(h('p', { class: 'tokens-hint' }, 'Every board you can open, now and later.'));
      } else if (!boards.length) {
        boardsBody.replaceChildren(h('p', { class: 'tokens-hint' }, 'You have no boards on this server yet.'));
      } else {
        boardsBody.replaceChildren(h('div', { class: 'tokens-boards' }, boards.map((b) => h('label', { class: 'tokens-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.boardIds.includes(b.id),
            onchange: (e: Event) => {
              const box = e.currentTarget as HTMLInputElement;
              draft.boardIds = box.checked ? [...draft.boardIds, b.id].slice(0, MAX_BOARDS) : draft.boardIds.filter((id) => id !== b.id);
              box.checked = draft.boardIds.includes(b.id);
              refresh();
            },
          }),
          h('span', null, b.title || 'Untitled board')))));
      }
    };
    const paintScope = () => {
      scopeHint.textContent = SCOPE_OPTIONS.find((o) => o.value === draft.scope)?.hint ?? '';
    };

    const name = h('input', {
      class: 'input', type: 'text', maxlength: 80, placeholder: 'For example Claude Code on my laptop', 'aria-label': 'Token name, for example Claude Code on my laptop',
      oninput: () => {
        draft.name = name.value;
        refresh();
      },
    });

    create.addEventListener('click', async () => {
      if (draftProblem(me.user.role, draft) !== null) return;
      create.disabled = true;
      try {
        const made = await api.createAccessToken(toRequest(draft));
        onCreated?.();
        showCreated(made);
      } catch (e) {
        toast(describe(e));
        refresh();
      }
    });

    paintBoards();
    paintScope();
    body.replaceChildren(
      h('div', { class: 'tokens-field' }, h('div', { class: 'tokens-label' }, 'Name'), name),
      options('Access', SCOPE_OPTIONS.map((o) => ({ value: o.value as AccessScope, label: o.label })), () => draft.scope, (v) => {
        draft.scope = v;
        paintScope();
      }),
      scopeHint,
      options('Boards', [{ value: 'all', label: 'All my boards' }, { value: 'only', label: 'Only these' }], () => (draft.allBoards ? 'all' : 'only'), (v) => {
        draft.allBoards = v === 'all';
        paintBoards();
      }),
      boardsBody,
      options('Expires', EXPIRY_DAYS.map((d) => ({ value: d as number, label: `${d} days` })), () => draft.days, (v) => {
        draft.days = v;
      }),
      problem,
      h('div', { class: 'btn-row' }, create, h('button', { class: 'btn', onclick: showList }, 'Cancel')));
    refresh();
    toTop();
    name.focus();
  }

  function showCreated(made: CreatedAccessToken) {
    const snippets = clientSnippets(made.url, made.token);
    body.replaceChildren(
      h('p', { class: 'tokens-intro' }, 'Treat this like a password. It cannot be shown again; if you lose it, revoke it and make another.'),
      codeBlock('Token', made.token, 'Token'),
      codeBlock('Claude Code', snippets.claudeCode, 'Command'),
      codeBlock('Other tools (JSON)', snippets.config, 'Settings'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: load }, 'Done')));
    toTop();
  }

  load();
}

/** What the admin dashboard hands over, so this file does not import admin.ts (which imports it). */
export interface AdminKit {
  head: (cells: string[]) => HTMLElement;
  loadList: <T>(box: HTMLElement, fetchData: () => Promise<T>, show: (data: T) => void) => () => void;
  change: (run: () => Promise<unknown>, done: string) => Promise<boolean>;
  armable: (label: string, armedLabel: string, run: () => Promise<unknown>, opts?: { disabled?: boolean; title?: string }) => HTMLButtonElement;
  emptyLine: (text: string) => HTMLElement;
}

/** The body of the admin dashboard's Access tokens tab: every active token, with a revoke button each. */
export function tokensAdminPanel(me: Me, kit: AdminKit): HTMLElement {
  let tokens: AdminAccessToken[] = [];
  let grants: AdminGrant[] = [];
  let reload: () => void = () => {};
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(0, 0.9fr) auto' });
  const appActions = h('div', { class: 'admin-token-actions' });
  const actor = { id: me.user.id, role: me.user.role };

  const paint = () => {
    const rows = mergeAdminAccessRows(tokens, grants);
    if (!rows.length) box.replaceChildren(kit.emptyLine(me.mcpOauth ? CONNECTED_APP_TEXT.noAccess : 'No active access tokens.'));
    else box.replaceChildren(
      kit.head([
        CONNECTED_APP_TEXT.personColumn, CONNECTED_APP_TEXT.typeColumn, CONNECTED_APP_TEXT.accessColumn,
        CONNECTED_APP_TEXT.boardsColumn, CONNECTED_APP_TEXT.lastUsedColumn, CONNECTED_APP_TEXT.expiryColumn, CONNECTED_APP_TEXT.actionColumn,
      ]),
      ...rows.map(row),
    );
    appActions.replaceChildren();
    if (me.mcpOauth && grants.length) appActions.appendChild(
      kit.armable(CONNECTED_APP_TEXT.revokeAllApps, CONNECTED_APP_TEXT.confirmRevokeAllApps, async () => {
          if (await kit.change(() => api.adminRevokeAllGrants(), CONNECTED_APP_TEXT.adminDoneAll)) {
            grants = [];
            paint();
          }
        }),
    );
  };

  const revoke = async (t: AdminAccessToken) => {
    if (await kit.change(() => api.adminRevokeAccessToken(t.id), `Revoked ${t.name}`)) {
      tokens = tokens.filter((x) => x.id !== t.id);
      paint();
    }
  };

  const disconnect = async (grant: AdminGrant) => {
    if (await kit.change(() => api.adminDisconnectGrant(grant.id), CONNECTED_APP_TEXT.adminDoneOne)) {
      grants = grants.filter((x) => x.id !== grant.id);
      paint();
    }
  };

  const row = (access: AdminAccessRow): HTMLElement => {
    const person = access.kind === 'token'
      ? { userId: access.token.userId, userRole: access.token.userRole, userName: access.token.userName, email: access.token.email }
      : { userId: access.grant.userId, userRole: access.grant.userRole, userName: access.grant.userName, email: access.grant.email };
    const verdict = revokeVerdict(actor, { id: person.userId, role: person.userRole, disabled: false });
    const client = access.kind === 'grant' ? access.grant : null;
    const token = access.kind === 'token' ? access.token : null;
    const name = client?.clientName ?? token?.name ?? '';
    const accessLabel = client ? grantScopeLabel(client.scope) : scopeLabel(token!.scope);
    const boardText = client ? grantBoardsText(client.boardCount) : boardsSummary(token!.boardIds);
    const usedText = lastUsedLabel(client ?? token!, fmtAgo);
    const expiresText = client ? grantExpiryText(client.expiresAt, Date.now()) : expiryLabel(token!.expiresAt, Date.now());
    const button = client
      ? kit.armable(CONNECTED_APP_TEXT.disconnect, CONNECTED_APP_TEXT.confirmDisconnect, () => disconnect(client), { disabled: !verdict.allowed, title: verdict.reason })
      : kit.armable('Revoke', 'Click again to revoke', () => revoke(token!), { disabled: !verdict.allowed, title: verdict.reason });
    return h('div', { class: 'admin-row' },
      h('div', { class: 'admin-who' },
        h('div', null, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.personColumn}: `), h('span', { class: 'admin-name' }, person.userName || person.email)),
        h('div', { class: 'muted small' }, person.email)),
      h('div', { class: 'admin-who' },
        h('div', null, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.typeColumn}: `), h('span', { class: 'admin-badge' }, access.typeLabel)),
        h('div', { class: 'muted small admin-wrap' }, name),
        h('div', { class: 'muted small admin-wrap' }, client ? client.redirectHost : `…${token!.hint}`)),
      h('div', { class: 'admin-cell muted small' }, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.accessColumn}: `), accessLabel),
      h('div', { class: 'admin-cell muted small' }, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.boardsColumn}: `), boardText),
      h('div', { class: 'admin-cell muted small' }, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.lastUsedColumn}: `), usedText),
      h('div', { class: 'admin-cell muted small' }, h('span', { class: 'admin-cell-label' }, `${CONNECTED_APP_TEXT.expiryColumn}: `), expiresText),
      h('div', { class: 'btn-row admin-actions' },
        button));
  };

  const create = h('button', {
    class: 'btn primary', type: 'button', onclick: () => {
      create.focus();
      openTokensDialog(me, reload);
    },
  }, 'Create a token');
  reload = kit.loadList(box, async () => {
    if (!me.mcpOauth) return { tokens: await api.adminAccessTokens(), grants: [] as AdminGrant[] };
    const [tokenList, grantList] = await Promise.all([api.adminAccessTokens(), api.adminGrants()]);
    return { tokens: tokenList, grants: grantList };
  }, (list) => {
    tokens = list.tokens;
    grants = list.grants;
    paint();
  });
  return h('div', { class: 'admin-token-panel' },
    h('div', { class: 'admin-token-create' },
      h('p', { class: 'muted admin-note' }, 'Connect AI tools like Claude Code to this workspace over MCP.'),
      create),
    appActions,
    box);
}
