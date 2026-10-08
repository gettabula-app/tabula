import { h, icon } from './dom';
import { dialog, fmtAgo, toast } from './common';
import { deleteBoard, listBoards, relayUrl, touchBoard } from '../sync';
import { newId } from '../store';
import { readBoardFile, type ImportedBoard } from '../exporters';
import { TEMPLATES } from '../templates';

export interface HomeNav {
  open: (id: string, opts?: { template?: string; imported?: ImportedBoard }) => void;
}

/** Board list: everything here lives in this browser; nothing is fetched. */
export function renderHome(root: HTMLElement, nav: HomeNav) {
  document.title = 'Mira';
  const boards = listBoards();
  const fileInput = h('input', { type: 'file', accept: '.drift,.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const imported = await readBoardFile(f);
      const id = newId();
      touchBoard(id, { name: imported.json.meta?.name || f.name.replace(/\.\w+$/, '') });
      nav.open(id, { imported });
    } catch (e) {
      toast((e as Error).message);
    }
  });

  const list = boards.length
    ? h('ul', { class: 'board-list', 'aria-label': 'Your boards' }, ...boards.map((b) => h('li', null,
      h('a', { href: `#/b/${b.id}`, class: 'board-link' },
        h('span', { class: 'board-title' }, b.name || 'Untitled board'),
        h('span', { class: 'board-meta' }, `Edited ${fmtAgo(b.updatedAt)}`)),
      h('button', {
        class: 'icon-btn', title: 'Delete board from this device', 'aria-label': `Delete ${b.name}`,
        onclick: () => dialog('Delete this board?', h('p', null, `“${b.name}” will be removed from this device. Copies on a relay or on collaborators’ devices are not affected.`), [
          { label: 'Cancel' },
          { label: 'Delete board', primary: true, onClick: async () => { await deleteBoard(b.id); renderHome(root, nav); } },
        ]),
      }, icon('trash', 18)),
    )))
    : h('div', { class: 'home-empty' }, h('p', null, 'No boards on this device yet. Create one, or open a link someone shared with you.'));

  const relay = relayUrl();
  root.replaceChildren(h('main', { class: 'home' },
    h('header', { class: 'home-head' },
      h('div', { class: 'wordmark', 'aria-label': 'Mira' }, 'Mira'),
      h('p', { class: 'home-lede' }, 'An infinite whiteboard that lives on your device. Sketch, diagram and run workshops offline; sync with your team when you are online.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary big', onclick: () => nav.open(newId()) }, icon('plus', 18), 'New board'),
        h('button', { class: 'btn big', onclick: () => fileInput.click() }, icon('upload', 18), 'Open a board file'),
        fileInput,
      ),
    ),
    h('section', { class: 'home-col' },
      h('h2', null, 'Your boards'),
      list,
    ),
    h('section', { class: 'home-col' },
      h('h2', null, 'Run a team exercise'),
      h('ul', { class: 'template-grid' }, ...TEMPLATES.map((t) => h('li', null,
        h('button', { class: 'template-card', onclick: () => nav.open(newId(), { template: t.id }) },
          h('span', { class: 'tpl-cat' }, t.category),
          h('span', { class: 'tpl-name' }, t.name),
          h('span', { class: 'tpl-desc' }, t.description)),
      ))),
    ),
    h('footer', { class: 'home-foot muted small' },
      relay ? `Boards are stored in this browser and sync through ${relay.replace(/^ws/, 'http').replace(/\/sync$/, '')} when it is reachable.` : 'Sync is off. Boards are stored in this browser only.',
      ' Fonts by Fontshare. Icons by Iconify.'),
  ));
}
