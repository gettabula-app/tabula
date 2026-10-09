import './group-ui.css';
import type { BoardApp } from '../app';
import { h } from './dom';

/** The local group scope control; the group's outline and board dimming are renderer overlays. */
export function mountGroupUI(app: BoardApp, parent: HTMLElement) {
  const done = h('button', { class: 'group-done', type: 'button', onclick: () => app.leaveGroup() }, 'Done');
  parent.appendChild(done);

  const place = () => {
    const id = app.scope;
    const group = id ? app.store.get(id) : undefined;
    if (!id || group?.type !== 'group') {
      done.hidden = true;
      return;
    }
    const bounds = app.r.bounds(group);
    if (!bounds) {
      done.hidden = true;
      return;
    }
    const viewport = parent.getBoundingClientRect();
    const at = app.r.toScreen({ x: bounds.x, y: bounds.y });
    const width = done.offsetWidth || 64, height = done.offsetHeight || 32;
    const x = Math.max(8, Math.min((viewport.width || 1) - width - 8, at.x));
    const above = at.y - height - 8;
    const y = above >= 64 ? above : Math.min((viewport.height || 1) - height - 8, at.y + 8);
    done.hidden = false;
    done.setAttribute('aria-label', `Done editing ${group.name?.trim() || 'Group'}`);
    done.style.transform = `translate(${x}px, ${y}px)`;
  };

  app.on('selection', place);
  app.on('objects', place);
  const offCamera = app.r.onCamera(place);
  app.onDestroy(() => {
    offCamera();
    done.remove();
  });
  place();
}
