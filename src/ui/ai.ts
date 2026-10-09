import './ai.css';
import { ApiError, api, type AdminAi, type AiConfig } from '../api';
import { cloudErrorMessage } from '../cloud-logic';
import { dialog, fmtAgo, toast } from './common';
import { h, icon } from './dom';
import type { AdminKit } from './tokens';
import {
  DATA_NOTICE, FEATURE_OPTIONS, LIMIT_CAPS, LIMIT_LABELS, MODEL_OPTIONS, OPENAI_COMPATIBLE_PROVIDER, PROVIDER, PROVIDER_OPTIONS, UNCONFIGURED_TEXT,
  draftOf, draftProblem, keyDates, keyLine, keyProblem, keyTestErrorMessage, patchOf, sourceLabel, type AdminDraft, type LimitName,
} from './ai-logic';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const GENERIC = 'Something went wrong. Try again.';

function describe(e: unknown): string {
  const keyMessage = keyTestErrorMessage(e);
  if (keyMessage) return keyMessage;
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
    status.classList.remove('bad');
    try {
      await run();
      status.classList.remove('bad');
      status.textContent = 'The key works.';
    } catch (e) {
      status.classList.add('bad');
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
    const savedProvider = mine && PROVIDER_OPTIONS.some((o) => o.value === mine.provider) ? mine.provider : PROVIDER;
    const provider = h('select', { class: 'input', 'aria-label': 'Provider' }, PROVIDER_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === savedProvider }, o.label)));
    provider.value = savedProvider;
    const baseUrl = h('input', {
      class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 201,
      placeholder: 'https://integrate.api.nvidia.com/v1', value: mine?.baseUrl ?? '',
      oninput: () => check(),
    });
    const model = h('input', {
      class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 101,
      placeholder: 'moonshotai/kimi-k3', value: mine?.model ?? '',
      oninput: () => check(),
    });
    const providerFields = h('div', { class: 'ai-fields' });
    const baseUrlField = h('div', { class: 'ai-field' },
      h('label', { class: 'ai-label' }, 'Base URL', baseUrl),
      h('div', { class: 'ai-meta' }, "Where your provider's API lives: NVIDIA, OpenAI, OpenRouter or a server of your own"));
    const modelField = h('div', { class: 'ai-field' },
      h('label', { class: 'ai-label' }, 'Model', model),
      h('div', { class: 'ai-meta' }, 'The model id your provider calls it'));

    const check = () => {
      const why = keyProblem(field.input.value, provider.value, baseUrl.value, model.value);
      problem.classList.toggle('bad', why !== null);
      problem.textContent = why ?? '';
      save.disabled = why !== null;
    };
    const renderProviderFields = () => {
      providerFields.replaceChildren(...(provider.value === OPENAI_COMPATIBLE_PROVIDER ? [baseUrlField, modelField] : []));
      check();
    };
    const submit = async () => {
      const value = field.input.value;
      const why = keyProblem(value, provider.value, baseUrl.value, model.value);
      if (why !== null) {
        check();
        return;
      }
      save.disabled = true;
      save.textContent = 'Checking…';
      problem.classList.remove('bad');
      problem.textContent = 'Checking the key with the provider…';
      try {
        const input: { provider: string; apiKey: string; baseUrl?: string; model?: string } = { provider: provider.value, apiKey: value.trim() };
        if (provider.value === OPENAI_COMPATIBLE_PROVIDER) {
          input.baseUrl = baseUrl.value.trim();
          input.model = model.value.trim();
        }
        await api.saveMyAiKey(input);
        field.clear();
        toast('Key saved');
        if (alive()) load();
      } catch (e) {
        if (!alive()) return;
        const message = describe(e);
        problem.classList.add('bad');
        problem.textContent = message;
        save.textContent = 'Save key';
        check();
        problem.classList.add('bad');
        problem.textContent = message;
      }
    };
    const field = keyField('API key', check, () => void submit());
    const keyFields = h('div', { class: 'ai-field' },
      h('label', { class: 'ai-label' }, mine ? 'Replace with a new key' : 'API key', field.input));
    provider.addEventListener('change', renderProviderFields);
    save.addEventListener('click', () => void submit());
    renderProviderFields();
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
          h('label', { class: 'ai-label' }, 'Provider', provider),
          providerFields,
          keyFields,
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
      problem.classList.toggle('bad', why !== null);
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
    const savedKeyProvider = state.key && PROVIDER_OPTIONS.some((o) => o.value === state.key?.provider) ? state.key.provider : PROVIDER;
    const keyProvider = h('select', { class: 'input', 'aria-label': 'Provider' }, PROVIDER_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === savedKeyProvider }, o.label)));
    keyProvider.value = savedKeyProvider;
    const baseUrl = h('input', {
      class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 201,
      placeholder: 'https://integrate.api.nvidia.com/v1', value: state.key?.baseUrl ?? '', oninput: () => checkKey(),
    });
    const modelId = h('input', {
      class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 101,
      placeholder: 'moonshotai/kimi-k3', value: state.key?.model ?? '', oninput: () => checkKey(),
    });
    const providerFields = h('div', { class: 'ai-fields' });
    const baseUrlField = h('div', { class: 'ai-field' },
      h('label', { class: 'ai-label' }, 'Base URL', baseUrl),
      h('div', { class: 'ai-meta' }, "Where your provider's API lives: NVIDIA, OpenAI, OpenRouter or a server of your own"));
    const modelField = h('div', { class: 'ai-field' },
      h('label', { class: 'ai-label' }, 'Model', modelId),
      h('div', { class: 'ai-meta' }, 'The model id your provider calls it'));
    const checkKey = () => {
      const why = keyProblem(keyInput.input.value, keyProvider.value, baseUrl.value, modelId.value);
      keyStatus.classList.toggle('bad', why !== null);
      keyStatus.textContent = why ?? '';
      saveKey.disabled = !state.hasSecret || why !== null;
    };
    const renderProviderFields = () => {
      providerFields.replaceChildren(...(keyProvider.value === OPENAI_COMPATIBLE_PROVIDER ? [baseUrlField, modelField] : []));
      checkKey();
      updateKeyLabel();
    };
    const submitKey = async () => {
      const value = keyInput.input.value;
      const why = keyProblem(value, keyProvider.value, baseUrl.value, modelId.value);
      if (!state.hasSecret || why !== null) {
        checkKey();
        return;
      }
      saveKey.disabled = true;
      saveKey.textContent = 'Checking…';
      keyStatus.classList.remove('bad');
      keyStatus.textContent = 'Checking the key with the provider…';
      let next: AdminAi | undefined;
      let keyError: unknown = null;
      // the admin body already has `model` (the workspace's Anthropic model), so the key's own model is `keyModel`
      const input: { apiKey: string; provider: string; baseUrl?: string; keyModel?: string } = { apiKey: value.trim(), provider: keyProvider.value };
      if (keyProvider.value === OPENAI_COMPATIBLE_PROVIDER) {
        input.baseUrl = baseUrl.value.trim();
        input.keyModel = modelId.value.trim();
      }
      const ok = await kit.change(async () => {
        try {
          next = await api.updateAdminAi(input);
        } catch (e) {
          keyError = e;
          throw e;
        }
      }, 'Workspace key saved');
      if (ok && next) {
        keyInput.clear();
        saved = next;
        render();
      } else {
        // what was typed stays, so a typo can be fixed
        saveKey.textContent = state.key ? 'Replace key' : 'Save key';
        checkKey();
        const message = keyTestErrorMessage(keyError);
        if (message) {
          keyStatus.classList.add('bad');
          keyStatus.textContent = message;
        }
      }
    };
    const keyInput = keyField('Workspace API key', checkKey, () => void submitKey());
    const keyLabel = h('label', { class: 'ai-label' }, state.key ? 'Replace with a new key' : 'Anthropic API key', keyInput.input);
    function updateKeyLabel() {
      const label = state.key ? 'Replace with a new key' : keyProvider.value === PROVIDER ? 'Anthropic API key' : 'API key';
      keyLabel.replaceChildren(label, keyInput.input);
    }
    keyProvider.addEventListener('change', renderProviderFields);
    saveKey.addEventListener('click', () => void submitKey());
    renderProviderFields();

    const removeKey = async () => {
      if (await kit.change(() => api.deleteAdminAiKey(), 'Workspace key removed')) saved = { ...state, key: null };
      render();
    };

    const key = state.key;
    const tested = key ? keyTest(() => api.testAdminAiKey()) : null;
    const modelSetting = key?.provider === OPENAI_COMPATIBLE_PROVIDER
      ? h('div', null, h('div', null, key.model ?? ''), h('div', { class: 'ai-meta' }, 'From the key'))
      : h('div', { class: 'admin-select ai-model' }, model, icon('chevron', 16));
    root.replaceChildren(...nodes(
      h('p', { class: 'ai-notice' }, DATA_NOTICE),
      h('dl', { class: 'admin-facts' },
        fact('AI', checkbox('Allow AI features in this workspace', edit.enabled, (on) => (edit.enabled = on))),
        fact('Features', h('div', { class: 'ai-checks' }, FEATURE_OPTIONS.map((o) =>
          checkbox(o.label, edit.features.includes(o.id), (on) => {
            edit.features = on ? [...edit.features.filter((f) => f !== o.id), o.id] : edit.features.filter((f) => f !== o.id);
          })))),
        fact('Model', modelSetting),
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
          // the same select with its chevron as the Model above: a bare select in this tab reads as a text box
          h('label', { class: 'ai-label' }, 'Provider', h('div', { class: 'admin-select' }, keyProvider, icon('chevron', 16))),
          providerFields,
          keyLabel,
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
