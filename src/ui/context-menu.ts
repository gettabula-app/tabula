// The menu a right-click on the board opens (TAB-108): the four stacking steps, then duplicate, lock and delete.
// What is in it is decided by `contextMenuItems`, which has no DOM so a test can read it.
import type { BoardApp } from '../app';
import { h, icon } from './dom';
import { popover } from './common';

export type ContextAction = 'front' | 'forward' | 'backward' | 'back' | 'duplicate' | 'lock' | 'delete';

export interface ContextItem { action: ContextAction; label: string; hint?: string; icon: IconName; danger?: boolean; separatorBefore?: boolean }

type IconName = Parameters<typeof icon>[0];

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The entries for a selection of `count` objects, all locked or not. */
export function contextMenuItems({ count, locked }: { count: number; locked: boolean }): ContextItem[] {
  if (count === 0) return [];
  const mod = isMac() ? 'Cmd' : 'Ctrl';
  return [
    { action: 'front', label: 'Bring to front', hint: ']', icon: 'front' },
    { action: 'forward', label: 'Bring forward', hint: `${mod}+]`, icon: 'forward' },
    { action: 'backward', label: 'Send backward', hint: `${mod}+[`, icon: 'backward' },
    { action: 'back', label: 'Send to back', hint: '[', icon: 'back' },
    { action: 'duplicate', label: 'Duplicate', hint: `${mod}+D`, icon: 'dup', separatorBefore: true },
    { action: 'lock', label: locked ? 'Unlock' : 'Lock', icon: locked ? 'unlock' : 'lock' },
    { action: 'delete', label: 'Delete', hint: 'Del', icon: 'trash', danger: true },
  ];
}

const RUN: Record<ContextAction, (app: BoardApp) => void> = {
  front: (a) => a.bringToFront(),
  forward: (a) => void a.bringForward(),
  backward: (a) => void a.sendBackward(),
  back: (a) => a.sendToBack(),
  duplicate: (a) => a.duplicate(),
  lock: (a) => a.toggleLock(),
  delete: (a) => a.deleteSelection(),
};

/** Opens the menu at a screen position, for the selection as it is now. Closes on a pick, Escape or a click elsewhere. */
export function openContextMenu(app: BoardApp, x: number, y: number): void {
  const sel = app.selected();
  const items = contextMenuItems({ count: sel.length, locked: sel.length > 0 && sel.every((o) => o.locked) });
  if (!items.length || app.readOnly) return;
  // the popover places itself against an element: a one pixel anchor at the pointer
  const anchor = h('span', { style: `position:fixed;left:${Math.round(x)}px;top:${Math.round(y)}px;width:1px;height:1px;pointer-events:none`, 'aria-hidden': 'true' });
  document.body.appendChild(anchor);
  const menu = h('div', { class: 'menu ctx-menu', role: 'menu', 'aria-label': 'Object actions' },
    ...items.flatMap((item) => [
      item.separatorBefore ? h('hr', { class: 'menu-sep', role: 'separator' }) : null,
      h('button', {
        class: `menu-item${item.danger ? ' danger' : ''}`, role: 'menuitem',
        onclick: () => {
          pop.close();
          RUN[item.action](app);
        },
      }, icon(item.icon, 18), h('span', null, item.label), item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null),
    ]),
  );
  const pop = popover(anchor, menu, { side: 'bottom', className: 'ctx-pop', onClose: () => anchor.remove() });
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}
