import './home.css';
import type { BoardApp } from '../app';
import type { Id } from '../types';
import { isBox } from '../types';
import { toTemplateContent, validateContent, type CustomTemplate } from '../custom-templates';
import { putTemplate } from '../template-store';
import { thumbnailSvg } from '../template-thumb';
import { CATEGORIES, CUSTOM_CATEGORY } from '../templates';
import { newId } from '../store';
import { h } from './dom';
import { dialog, field, toast } from './common';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 280;

/** Opens the Save as template dialog for some objects of the board, or for the whole board. */
export function openSaveTemplate(app: BoardApp, source: Id[] | 'board'): void {
  const ids = source === 'board' ? app.store.ordered().map((o) => o.id) : source;
  const objs = app.gather(ids);
  if (!objs.length) {
    toast('Add something to the board first.');
    return;
  }
  const meta = app.store.getMeta();
  const steps = app.flow.state().steps;
  const only = ids.length === 1 ? app.store.get(ids[0]) : undefined;
  const prefill = (isBox(only) && only.type === 'frame' && only.name?.trim()) || meta.name;

  const name = h('input', { class: 'input', maxlength: NAME_MAX, value: prefill.slice(0, NAME_MAX), 'aria-label': 'Name', spellcheck: 'false', autocomplete: 'off' });
  const category = h('select', { class: 'input', 'aria-label': 'Category' }, ...[...CATEGORIES, CUSTOM_CATEGORY].map((c) => h('option', { value: c }, c)));
  category.value = CUSTOM_CATEGORY;
  const description = h('textarea', { class: 'input', rows: 3, maxlength: DESCRIPTION_MAX, 'aria-label': 'Description', placeholder: 'What is it for? (optional)' });
  const include = h('input', { type: 'checkbox', checked: true });
  const error = h('div', { class: 'error', role: 'alert' });
  const preview = h('div', { class: 'tpl-thumb' });
  const summary = h('p', { class: 'muted small' });

  const build = () => toTemplateContent(objs, steps, {
    includeSteps: include.checked,
    fonts: { heading: meta.headingFont, body: meta.bodyFont },
  }, (id) => app.store.get(id));
  // Over the size limits validateContent says so in plain words; nothing is saved then.
  const problem = (content: ReturnType<typeof build>): string | null => {
    try {
      validateContent(content);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  let content = build();
  let limit: string | null = null;
  const refresh = () => {
    content = build();
    limit = problem(content);
    error.textContent = limit ?? '';
    const save = dlg.box.querySelector<HTMLButtonElement>('.modal-actions .btn.primary');
    if (save) save.disabled = limit !== null;
    const n = content.objects.length;
    summary.textContent = `${n} ${n === 1 ? 'object' : 'objects'}${content.steps.length ? `, ${content.steps.length} session ${content.steps.length === 1 ? 'step' : 'steps'}` : ''}`;
  };
  preview.innerHTML = thumbnailSvg(content.objects);

  const dlg = dialog('Save as template', h('div', { class: 'save-tpl' },
    h('div', { class: 'save-tpl-form' },
      field('Name', name),
      field('Category', category),
      field('Description', description),
      steps.length ? h('label', { class: 'check' }, include, 'Include session steps') : null,
      error),
    h('div', { class: 'save-tpl-preview' }, preview, summary),
  ), [
    { label: 'Cancel' },
    {
      label: 'Save template', primary: true,
      onClick: async () => {
        const title = name.value.trim();
        if (!title) {
          error.textContent = 'Give the template a name.';
          name.focus();
          return false;
        }
        refresh();
        if (limit) return false;
        const now = Date.now();
        const t: CustomTemplate = {
          id: newId(), version: 1, name: title, category: category.value, description: description.value.trim(),
          content, createdBy: app.user.id, createdAt: now, updatedAt: now,
        };
        try {
          await putTemplate(t);
        } catch (e) {
          error.textContent = (e as Error).message;
          return false;
        }
        toast(`Saved “${title}” to My templates.`);
      },
    },
  ]);
  include.addEventListener('change', refresh);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) dlg.box.querySelector<HTMLButtonElement>('.modal-actions .btn.primary')?.click();
  });
  refresh();
}
