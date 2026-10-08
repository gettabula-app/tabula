import './tokens.css';
import { ApiError, api, type AccessScope, type AccessToken, type AdminAccessToken, type CreatedAccessToken, type Me, type ServerBoard } from '../api';
import { cloudErrorMessage } from '../cloud-logic';
import { revokeVerdict } from './admin-logic';
import { dialog, fmtAgo, toast } from './common';
import { h } from './dom';
import {
  EXPIRY_DAYS, MAX_BOARDS, SCOPE_OPTIONS, boardsLabel, boardsSummary, clientSnippets, draftProblem, emptyDraft, expiryLabel,
  lastUsedLabel, scopeLabel, toRequest, type Draft,
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
export function openTokensDialog(me: Me): void {
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
    void Promise.all([api.accessTokens(), api.boards().catch(() => [] as ServerBoard[])]).then(
      ([list, mine]) => {
        if (!alive()) return;
        tokens = list;
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
      const { revoked } = await api.revokeAllAccessTokens();
      toast(revoked === 1 ? '1 token revoked' : `${revoked} tokens revoked`);
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
    body.replaceChildren(
      intro,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: showForm }, 'New token'),
        tokens.length ? armed('Revoke all', 'Click again to revoke all', revokeAll) : null),
      tokens.length
        ? h('div', { class: 'tokens-list' }, tokens.map(row))
        : h('p', { class: 'tokens-state' }, 'No tokens yet.'));
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
      return h('div', { class: 'tokens-field' },
        h('div', { class: 'tokens-label' }, label),
        h('div', { class: 'tokens-opts', role: 'radiogroup', 'aria-label': label }, buttons));
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
      class: 'input', type: 'text', maxlength: 80, placeholder: 'For example Claude Code on my laptop', 'aria-label': 'Token name',
      oninput: () => {
        draft.name = name.value;
        refresh();
      },
    });

    create.addEventListener('click', async () => {
      if (draftProblem(me.user.role, draft) !== null) return;
      create.disabled = true;
      try {
        showCreated(await api.createAccessToken(toRequest(draft)));
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
  const box = h('div', { class: 'admin-box', style: '--cols: minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 1fr) auto' });
  const actor = { id: me.user.id, role: me.user.role };

  const paint = () => {
    if (!tokens.length) {
      box.replaceChildren(kit.emptyLine('No active access tokens.'));
      return;
    }
    box.replaceChildren(kit.head(['Person', 'Token', 'Boards', 'Used', '']), ...tokens.map(row));
  };

  const revoke = async (t: AdminAccessToken) => {
    if (await kit.change(() => api.adminRevokeAccessToken(t.id), `Revoked ${t.name}`)) {
      tokens = tokens.filter((x) => x.id !== t.id);
      paint();
    }
  };

  const row = (t: AdminAccessToken): HTMLElement => {
    const verdict = revokeVerdict(actor, { id: t.userId, role: t.userRole, disabled: false });
    return h('div', { class: 'admin-row' },
      h('div', { class: 'admin-who' },
        h('div', null, h('span', { class: 'admin-name' }, t.userName || t.email)),
        h('div', { class: 'muted small' }, t.email)),
      h('div', { class: 'admin-who' },
        h('div', null, h('span', { class: 'admin-name' }, t.name), h('span', { class: 'admin-badge' }, scopeLabel(t.scope))),
        h('div', { class: 'muted small' }, `…${t.hint}`)),
      h('div', { class: 'admin-cell muted small' }, boardsSummary(t.boardIds)),
      h('div', { class: 'admin-cell muted small' },
        h('div', null, lastUsedLabel(t, fmtAgo)),
        h('div', null, expiryLabel(t.expiresAt, Date.now()))),
      h('div', { class: 'btn-row admin-actions' },
        kit.armable('Revoke', 'Click again to revoke', () => revoke(t), { disabled: !verdict.allowed, title: verdict.reason })));
  };

  kit.loadList(box, () => api.adminAccessTokens(), (list) => {
    tokens = list;
    paint();
  });
  return box;
}

