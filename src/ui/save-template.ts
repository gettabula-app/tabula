import './home.css';
import type { BoardApp } from '../app';
import type { Id, Obj } from '../types';
import { isBox } from '../types';
import { imagesLeftOut, toTemplateContent, validateContent, type CustomTemplate, type TemplateContent, type TemplateScope } from '../custom-templates';
import { authState } from '../auth';
import { putTemplate, templatesShared } from '../template-store';
import { choiceFor, choiceValue, saveBlocked, scopeLabel, shareChoices, shareHint } from '../template-share';
import { thumbnailSvg } from '../template-thumb';
import { CATEGORIES, CUSTOM_CATEGORY } from '../templates';
import { newId } from '../store';
import { h } from './dom';
import { dialog, field, toast } from './common';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 280;
const CATEGORY_OPTIONS: string[] = [...CATEGORIES, CUSTOM_CATEGORY];

/** What the form asks for; the content comes from the board. */
export interface TemplateDetails {
  name: string;
  category: string;
  description: string;
  includeSteps: boolean;
  /** Accounts mode: who the template is shared with. */
  scope: TemplateScope;
  teamId: string | null;
}

/** The template content for some gathered objects, with the board's session steps and fonts. */
export function boardTemplateContent(app: BoardApp, objs: Obj[], includeSteps: boolean): TemplateContent {
  const meta = app.store.getMeta();
  return toTemplateContent(objs, app.flow.state().steps, {
    includeSteps,
    fonts: { heading: meta.headingFont, body: meta.bodyFont },
  }, (id) => app.store.get(id));
}

/** Why content cannot be saved (over the size limits, say in plain words), or null when it can. */
export function contentProblem(content: TemplateContent): string | null {
  try {
    validateContent(content);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

interface DialogSpec {
  title: string;
  confirm: string;
  details: TemplateDetails;
  objs: Obj[];
  /** Runs with a valid form. Throwing keeps the dialog open and shows the message. */
  onSubmit: (details: TemplateDetails, content: TemplateContent) => void | Promise<void>;
  /** The dialog saves to the server itself, so it says why that is not possible (offline, a guest) and keeps Save off. */
  saves?: boolean;
}

function openTemplateDialog(app: BoardApp, spec: DialogSpec): void {
  const { objs } = spec;
  const steps = app.flow.state().steps;

  const name = h('input', { class: 'input', maxlength: NAME_MAX, value: spec.details.name.slice(0, NAME_MAX), 'aria-label': 'Name', spellcheck: 'false', autocomplete: 'off' });
  const category = h('select', { class: 'input', 'aria-label': 'Category' }, ...CATEGORY_OPTIONS.map((c) => h('option', { value: c }, c)));
  category.value = CATEGORY_OPTIONS.includes(spec.details.category) ? spec.details.category : CUSTOM_CATEGORY;
  const description = h('textarea', { class: 'input', rows: 3, maxlength: DESCRIPTION_MAX, 'aria-label': 'Description', placeholder: 'What is it for? (optional)' });
  description.value = spec.details.description;
  const include = h('input', { type: 'checkbox', checked: spec.details.includeSteps });
  const auth = authState();
  const choices = templatesShared() && (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me ? shareChoices(auth.me, spec.details) : [];
  const share = h('select', { class: 'input', 'aria-label': 'Share with' }, ...choices.map((c) => h('option', { value: c.value }, c.label)));
  share.value = choiceValue(spec.details);
  const shareNote = h('p', { class: 'muted small' });
  const showShare = () => {
    if (choices.length) shareNote.textContent = shareHint(choiceFor(choices, share.value));
  };
  const blocked = spec.saves && choices.length ? saveBlocked(auth) : null;
  const error = h('div', { class: 'error', role: 'alert' });
  const preview = h('div', { class: 'tpl-thumb' });
  const summary = h('p', { class: 'muted small' });

  let content = boardTemplateContent(app, objs, include.checked);
  let limit: string | null = null;
  const refresh = () => {
    content = boardTemplateContent(app, objs, include.checked);
    limit = contentProblem(content);
    error.textContent = blocked ?? limit ?? '';
    const save = dlg.box.querySelector<HTMLButtonElement>('.modal-actions .btn.primary');
    if (save) save.disabled = limit !== null || blocked !== null;
    const n = content.objects.length;
    const left = imagesLeftOut(objs);
    summary.textContent = `${n} ${n === 1 ? 'object' : 'objects'}${content.steps.length ? `, ${content.steps.length} session ${content.steps.length === 1 ? 'step' : 'steps'}` : ''}${left ? `. ${left} ${left === 1 ? 'image was' : 'images were'} left out: templates can't hold images yet.` : ''}`;
  };
  preview.innerHTML = thumbnailSvg(content.objects);

  const dlg = dialog(spec.title, h('div', { class: 'save-tpl' },
    h('div', { class: 'save-tpl-form' },
      field('Name', name),
      field('Category', category),
      field('Description', description),
      choices.length ? field('Share with', h('div', null, share, shareNote)) : null,
      steps.length ? h('label', { class: 'check' }, include, 'Include session steps') : null,
      error),
    h('div', { class: 'save-tpl-preview' }, preview, summary),
  ), [
    { label: 'Cancel' },
    {
      label: spec.confirm, primary: true,
      onClick: async () => {
        const title = name.value.trim();
        if (!title) {
          error.textContent = 'Give the template a name.';
          name.focus();
          return false;
        }
        refresh();
        if (limit || blocked) return false;
        const where = choiceFor(choices, share.value);
        try {
          await spec.onSubmit({
            name: title, category: category.value, description: description.value.trim(), includeSteps: include.checked,
            ...(choices.length ? { scope: where.scope, teamId: where.teamId } : { scope: spec.details.scope, teamId: spec.details.teamId }),
          }, content);
        } catch (e) {
          error.textContent = (e as Error).message;
          return false;
        }
      },
    },
  ]);
  include.addEventListener('change', refresh);
  share.addEventListener('change', showShare);
  showShare();
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) dlg.box.querySelector<HTMLButtonElement>('.modal-actions .btn.primary')?.click();
  });
  refresh();
}

/** Opens the Save as template dialog for some objects of the board, or for the whole board. */
export function openSaveTemplate(app: BoardApp, source: Id[] | 'board'): void {
  const ids = source === 'board' ? app.store.ordered().map((o) => o.id) : source;
  const objs = app.gather(ids);
  if (!objs.length) {
    toast('Add something to the board first.');
    return;
  }
  const meta = app.store.getMeta();
  const only = ids.length === 1 ? app.store.get(ids[0]) : undefined;
  const prefill = (isBox(only) && only.type === 'frame' && only.name?.trim()) || meta.name;

  openTemplateDialog(app, {
    title: 'Save as template',
    confirm: 'Save template',
    details: { name: prefill, category: CUSTOM_CATEGORY, description: '', includeSteps: true, scope: 'personal', teamId: null },
    objs,
    saves: true,
    onSubmit: async (d, content) => {
      const now = Date.now();
      const t: CustomTemplate = {
        id: newId(), version: 1, name: d.name, category: d.category, description: d.description,
        content, createdBy: app.user.id, createdAt: now, updatedAt: now,
        ...(templatesShared() ? { scope: d.scope, teamId: d.teamId } : {}),
      };
      const saved = await putTemplate(t);
      toast(saved.scope && saved.scope !== 'personal'
        ? `Saved “${d.name}” and shared it with ${scopeLabel(saved, null)}.`
        : `Saved “${d.name}” to My templates.`);
    },
  });
}

/** The Save as template form for the template being edited: changes the details held by the editor, saves nothing. */
export function openTemplateDetails(app: BoardApp, details: TemplateDetails, onDone: (details: TemplateDetails) => void): void {
  openTemplateDialog(app, {
    title: 'Template details',
    confirm: 'Done',
    details,
    objs: app.gather(app.store.ordered().map((o) => o.id)),
    onSubmit: (d) => onDone(d),
  });
}
