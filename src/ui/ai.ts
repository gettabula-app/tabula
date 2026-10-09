import './ai.css';
import { ApiError, api, type AdminAi, type AiConfig } from '../api';
import { cloudErrorMessage } from '../cloud-logic';
import { dialog, fmtAgo, toast } from './common';
import { h, icon } from './dom';
import type { AdminKit } from './tokens';
import {
  DATA_NOTICE, FEATURE_OPTIONS, LIMIT_CAPS, LIMIT_LABELS, MODEL_OPTIONS, PROVIDER, UNCONFIGURED_TEXT, draftOf, draftProblem, keyDates, keyLine, keyProblem,
  keyTestErrorMessage, patchOf, sourceLabel, type AdminDraft, type LimitName,
} from './ai-logic';

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

/** The children that exist: replaceChildren takes no null. */
const nodes = (...children: (Node | null)[]): Node[] => children.filter((n): n is Node => n !== null);

/** A destructive control: the first click arms it, the second runs it. */
function armed(label: string, armedLabel: string, run: () => Promise<unknown>): HTMLButtonElement {
  let on = false;
  const button = h('button', { class: 'btn' }, label);
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
      button.disabled = false;
      reset();
    }
  });
  button.addEventListener('blur', reset);
  return button;
}

/**
 * A field for an API key. It is never given a value, never filled in again and cleared by `clear()`: the page
 * shows a stored key only as its last four characters.
 */
function keyField(label: string, onInput: () => void, onEnter: () => void) {
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    maxlength: 600,
    placeholder: 'Paste the key',
    'aria-label': label,
    oninput: onInput,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') onEnter();
    },
  });
  return { input, clear: () => (input.value = '') };
}

/** Check the stored key without asking the person to enter or expose it again. */
function keyTest(run: () => Promise<unknown>) {
  const status = h('p', { class: 'ai-problem', role: 'status', 'aria-live': 'polite' });
  const button = h('button', { class: 'btn' }, 'Test key');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Testing…';
    status.textContent = '';
    try {
      await run();
      status.textContent = 'The key works.';
    } catch (e) {
      status.textContent = keyTestErrorMessage(e) ?? describe(e);
    } finally {
      button.disabled = false;
      button.textContent = 'Test key';
    }
  });
  return { button, status };
}

/** The "Your AI key" dialog in the account menu: the person's own key for AI features, when the workspace allows it. */
export function openAiKeyDialog(): void {
  const body = h('div', { class: 'ai' });
  const { box, close } = dialog('Your AI key', body);
  box.classList.add('ai-dialog');
  // Leaving the page takes the dialog away, like the tokens dialog.
  const onLeave = () => {
    window.removeEventListener('hashchange', onLeave);
    close();
  };
  window.addEventListener('hashchange', onLeave);
  const alive = () => body.isConnected;

  const intro = h('p', { class: 'ai-intro' },
    'AI features use your own key when you add one, and the workspace key otherwise. The provider checks the key when you save it; it is stored encrypted on the server and cannot be shown again.');

  const load = () => {
    body.replaceChildren(intro, h('p', { class: 'ai-state', role: 'status' }, 'Loading…'));
    void api.aiConfig().then(
      (config) => {
        if (alive()) show(config);
      },
      (e: unknown) => {
        if (alive()) body.replaceChildren(intro, h('div', { class: 'ai-error', role: 'alert' }, h('span', null, describe(e)), h('button', { class: 'btn', onclick: load }, 'Retry')));
      },
    );
  };

  const remove = async () => {
    try {
      await api.deleteMyAiKey();
      toast('Key removed');
      load();
    } catch (e) {
      toast(describe(e));
    }
  };

  function show(config: AiConfig) {
    if (!config.personalKeys) {
      body.replaceChildren(intro, h('p', { class: 'ai-state' }, 'Your workspace does not allow personal keys. A workspace admin can turn them on in Admin, AI.'));
      return;
    }
    const mine = config.myKey;
    const problem = h('p', { class: 'ai-problem', role: 'status' });
    const save = h('button', { class: 'btn primary', disabled: true }, 'Save key');

    const check = () => {
      save.disabled = keyProblem(field.input.value) !== null;
    };
    const submit = async () => {
      const value = field.input.value;
      if (keyProblem(value) !== null) return;
      save.disabled = true;
      save.textContent = 'Checking…';
      problem.textContent = 'Checking the key with the provider…';
      try {
        await api.saveMyAiKey({ provider: PROVIDER, apiKey: value.trim() });
        field.clear();
        toast('Key saved');
        if (alive()) load();
      } catch (e) {
        if (!alive()) return;
        problem.textContent = describe(e);
        save.textContent = 'Save key';
        check();
      }
    };
    const field = keyField('API key', check, () => void submit());
    save.addEventListener('click', () => void submit());
    const tested = mine ? keyTest(() => api.testMyAiKey()) : null;

    body.replaceChildren(...nodes(
      intro,
      h('p', { class: 'ai-source' }, sourceLabel(config.keySource)),
      mine
        ? h('div', { class: 'ai-key' },
          h('div', { class: 'ai-key-who' },
            h('div', { class: 'ai-key-line' }, keyLine(mine)),
            h('div', { class: 'ai-meta' }, keyDates(mine, fmtAgo)),
            tested!.status),
          h('div', { class: 'btn-row' }, tested!.button, armed('Remove', 'Click again to remove', remove)))
        : null,
      config.hasSecret
        ? h('div', { class: 'ai-field' },
          h('label', { class: 'ai-label' }, mine ? 'Replace with a new key' : 'API key', field.input),
          problem,
          h('div', { class: 'btn-row' }, save))
        : h('div', { class: 'ai-error', role: 'alert' }, h('span', null, UNCONFIGURED_TEXT)),
      h('p', { class: 'ai-notice' }, DATA_NOTICE)));
    field.input.focus();
  }

  load();
}

/** The body of the admin dashboard's AI tab: on or off, features, model, who may bring a key, limits and the workspace key. */
export function aiAdminPanel(kit: AdminKit): HTMLElement {
  const root = h('div', { class: 'ai-admin' });
  let saved: AdminAi | null = null;
  let draft: AdminDraft | null = null;

  const render = () => {
    if (!saved || !draft) return;
    const state = saved;
    const edit = draft;

    const save = h('button', { class: 'btn primary', disabled: true }, 'Save settings');
    const problem = h('p', { class: 'ai-problem', role: 'status' });
    const refresh = () => {
      const why = draftProblem(edit);
      problem.textContent = why ?? '';
      save.disabled = why !== null || patchOf(state, edit) === null;
    };

    const checkbox = (label: string, checked: boolean, set: (on: boolean) => void) =>
      h('label', { class: 'ai-check' },
        h('input', {
          type: 'checkbox',
          checked,
          onchange: (e: Event) => {
            set((e.currentTarget as HTMLInputElement).checked);
            refresh();
          },
        }),
        h('span', null, label));

    const limit = (name: LimitName) =>
      h('label', { class: 'ai-limit' },
        h('span', { class: 'ai-label' }, LIMIT_LABELS[name]),
        h('input', {
          class: 'input',
          type: 'number',
          min: 1,
          max: LIMIT_CAPS[name],
          step: 1,
          inputmode: 'numeric',
          value: edit[name],
          oninput: (e: Event) => {
            edit[name] = (e.currentTarget as HTMLInputElement).value;
            refresh();
          },
        }));

    const model = h('select', {
      class: 'input',
      'aria-label': 'Model',
      onchange: () => {
        edit.model = model.value;
        refresh();
      },
    }, MODEL_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === edit.model }, o.label)));

    const saveSettings = async () => {
      const patch = patchOf(state, edit);
      if (!patch || draftProblem(edit) !== null) return;
      save.disabled = true;
      let next: AdminAi | undefined;
      const ok = await kit.change(async () => {
        next = await api.updateAdminAi(patch);
      }, 'AI settings saved');
      if (ok && next) {
        saved = next;
        draft = draftOf(next);
        render();
      } else {
        refresh();
      }
    };
    save.addEventListener('click', () => void saveSettings());

    // the workspace key
    const keyStatus = h('p', { class: 'ai-problem', role: 'status' });
    const saveKey = h('button', { class: 'btn primary', disabled: true }, state.key ? 'Replace key' : 'Save key');
    const checkKey = () => {
      saveKey.disabled = !state.hasSecret || keyProblem(keyInput.input.value) !== null;
    };
    const submitKey = async () => {
      const value = keyInput.input.value;
      if (!state.hasSecret || keyProblem(value) !== null) return;
      saveKey.disabled = true;
      saveKey.textContent = 'Checking…';
      keyStatus.textContent = 'Checking the key with the provider…';
      let next: AdminAi | undefined;
      const ok = await kit.change(async () => {
        next = await api.updateAdminAi({ apiKey: value.trim(), provider: PROVIDER });
      }, 'Workspace key saved');
      if (ok && next) {
        keyInput.clear();
        saved = next;
        render();
      } else {
        // what was typed stays, so a typo can be fixed
        keyStatus.textContent = '';
        saveKey.textContent = state.key ? 'Replace key' : 'Save key';
        checkKey();
      }
    };
    const keyInput = keyField('Workspace API key', checkKey, () => void submitKey());
    saveKey.addEventListener('click', () => void submitKey());

    const removeKey = async () => {
      if (await kit.change(() => api.deleteAdminAiKey(), 'Workspace key removed')) saved = { ...state, key: null };
      render();
    };

    const key = state.key;
    const tested = key ? keyTest(() => api.testAdminAiKey()) : null;
    root.replaceChildren(...nodes(
      h('p', { class: 'ai-notice' }, DATA_NOTICE),
      h('dl', { class: 'admin-facts' },
        fact('AI', checkbox('Allow AI features in this workspace', edit.enabled, (on) => (edit.enabled = on))),
        fact('Features', h('div', { class: 'ai-checks' }, FEATURE_OPTIONS.map((o) =>
          checkbox(o.label, edit.features.includes(o.id), (on) => {
            edit.features = on ? [...edit.features.filter((f) => f !== o.id), o.id] : edit.features.filter((f) => f !== o.id);
          })))),
        fact('Model', h('div', { class: 'admin-select ai-model' }, model, icon('chevron', 16))),
        fact('Personal keys', checkbox('People can add a key of their own, which they use instead of the workspace key', edit.personalKeys, (on) => (edit.personalKeys = on))),
        fact('Guests', checkbox('Members only: guests cannot use AI features or add a key', edit.membersOnly, (on) => (edit.membersOnly = on))),
        fact('Limits', h('div', { class: 'ai-limits' }, limit('perPersonHour'), limit('perWorkspaceHour')))),
      h('div', { class: 'btn-row ai-actions' }, save, problem),

      h('h3', { class: 'admin-sub' }, 'Workspace key'),
      state.hasSecret ? null : h('div', { class: 'ai-error', role: 'alert' }, h('span', null, UNCONFIGURED_TEXT)),
      key
        ? h('div', { class: 'ai-key' },
          h('div', { class: 'ai-key-who' },
            h('div', { class: 'ai-key-line' }, keyLine(key)),
            h('div', { class: 'ai-meta' }, keyDates(key, fmtAgo)),
            key.readable ? null : h('div', { class: 'ai-meta ai-warn' }, 'This key cannot be read with the current TABULA_AI_SECRET. Enter it again.'),
            tested!.status),
          h('div', { class: 'btn-row' }, tested!.button, kit.armable('Remove', 'Click again to remove', removeKey)))
        : kit.emptyLine('No workspace key yet. Without one, only people with a key of their own can run AI features.'),
      state.hasSecret
        ? h('div', { class: 'ai-field' },
          h('label', { class: 'ai-label' }, key ? 'Replace with a new key' : 'Anthropic API key', keyInput.input),
          keyStatus,
          h('div', { class: 'btn-row' }, saveKey))
        : null));
    refresh();
  };

  kit.loadList(root, () => api.adminAi(), (data) => {
    saved = data;
    draft = draftOf(data);
    render();
  });
  return root;
}

const fact = (label: string, control: HTMLElement) => h('div', { class: 'admin-fact' }, h('dt', null, label), h('dd', null, control));
