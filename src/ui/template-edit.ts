import './template-edit.css';
import type { BoardApp } from '../app';
import type { Store } from '../store';
import { instantiate, type CustomTemplate } from '../custom-templates';
import { putTemplate } from '../template-store';
import { h } from './dom';
import { dialog, toast } from './common';
import { mountBoardUi } from './board';
import { boardTemplateContent, contentProblem, openTemplateDetails, type TemplateDetails } from './save-template';

/** Origin of the writes that load the template: not undoable, so Ctrl+Z cannot empty the board. */
const LOAD = 'template';

/** Puts a saved template on an empty scratch board's store: objects at the grid origin, the fonts and the steps. */
export function loadTemplate(store: Store, tpl: CustomTemplate, userId: string): void {
  const { objects, steps } = instantiate(tpl.content, { x: 0, y: 0 }, userId);
  const zs = store.topZs(objects.length);
  const now = Date.now();
  objects.forEach((o, i) => {
    o.z = zs[i];
    o.updatedAt = now;
  });
  const fonts = tpl.content.fonts;
  store.transactAs(() => {
    objects.forEach((o) => store.create(o));
    store.meta.set('name', tpl.name);
    if (fonts) {
      store.meta.set('headingFont', fonts.heading);
      store.meta.set('bodyFont', fonts.body);
    }
  }, LOAD);
  if (steps.length) store.setFlow({ steps });
}

/**
 * The editing chrome around a scratch board that holds a template (see loadTemplate): the board UI without sharing and
 * sync, and a banner with Details, Cancel and Save template. Changes after this call mark the editor dirty; Cancel asks
 * before throwing them away, and so does closing the tab.
 */
let guard: ((target: string) => boolean) | null = null;

/** The router asks this before leaving the editor; false means it should stay (a confirm is showing). */
export function templateLeaveGuard(): ((target: string) => boolean) | null {
  return guard;
}

export function mountTemplateEditor(app: BoardApp, root: HTMLElement, tpl: CustomTemplate): void {
  let details: TemplateDetails = { name: tpl.name, category: tpl.category, description: tpl.description, includeSteps: true };
  let dirty = false;
  let saving = false;
  app.conn.doc.on('update', () => {
    dirty = true;
  });

  const leave = () => {
    location.hash = '#/templates';
  };

  const confirmLeave = (go: () => void) => {
    if (!dirty) {
      go();
      return;
    }
    const dlg = dialog('Discard changes?', h('p', null, `Discard changes to “${details.name}”? They have not been saved.`), [
      { label: 'Keep editing' },
      {
        label: 'Discard changes',
        onClick: () => {
          dirty = false;
          go();
        },
      },
    ]);
    dlg.box.querySelector('.modal-actions .btn:last-child')?.classList.add('danger');
  };
  const cancel = () => confirmLeave(leave);
  guard = (target) => {
    if (!dirty) return true;
    confirmLeave(() => {
      location.hash = target;
    });
    return false;
  };
  app.lifetime.signal.addEventListener('abort', () => {
    guard = null;
  });

  const save = async () => {
    if (saving) return;
    app.editor.commit();
    const objs = app.gather(app.store.ordered().map((o) => o.id));
    if (!objs.length) {
      toast('Add something to the board first.');
      return;
    }
    const content = boardTemplateContent(app, objs, details.includeSteps);
    const problem = contentProblem(content);
    if (problem) {
      toast(problem);
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    try {
      await putTemplate({
        ...tpl, name: details.name, category: details.category, description: details.description, content, updatedAt: Date.now(),
      });
    } catch (e) {
      toast((e as Error).message);
      saving = false;
      saveBtn.disabled = false;
      return;
    }
    dirty = false;
    toast(`Saved “${details.name}”.`);
    leave();
  };

  const nameEl = h('b', null, details.name);
  const saveBtn = h('button', { class: 'btn primary', onclick: save }, 'Save template');
  const banner = h('div', { class: 'template-banner', role: 'region', 'aria-label': 'Editing template' },
    h('p', { class: 'template-banner-text' }, 'Editing template ', nameEl),
    h('div', { class: 'template-banner-actions' },
      h('button', {
        class: 'btn', onclick: () => openTemplateDetails(app, details, (d) => {
          if (JSON.stringify(d) !== JSON.stringify(details)) dirty = true;
          details = d;
          nameEl.textContent = d.name;
          document.title = `Editing ${d.name} - Tabula`;
        }),
      }, 'Details'),
      h('button', { class: 'btn ghost', onclick: cancel }, 'Cancel'),
      saveBtn));

  mountBoardUi(app, root, { home: cancel }, { scratch: true });
  root.classList.add('editing-template');
  root.appendChild(banner);
  document.title = `Editing ${details.name} - Tabula`;

  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  }, { signal: app.lifetime.signal });
}
