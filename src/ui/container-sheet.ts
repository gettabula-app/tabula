import './container-sheet.css';
import type { BoardApp } from '../app';
import type { BaseObj, Id } from '../types';
import { LIMITS } from '../../shared/containers';
import { addCard, addCardRefusal, moveCards, moveRefusal } from '../containers';
import { listLabels } from '../labels';
import { kanbanSwatch } from '../markup';
import { popover } from './common';
import { keepKeys } from './card-dialog';
import { h, icon } from './dom';
import { focusFirst, inertPage, restoreFocus, trapTab } from './focus-scope';
import { item, sep } from './kanban-menus';
import { dueChip, filterParts, initials, keyboardMove, localToday, moveAnnouncement, type MoveKey } from './kanban-logic';
import { activeLane, laneName, moveChoices, moveToIndex, rowDropIndex, sheetRights, sheetSummary, sheetTabs } from './sheet-logic';

// The list sheet (docs/kanban.md, Phone and touch; slice 5): a kanban as lane tabs and card rows, full width under the
// top bar. It is the phone's way to work a kanban and, since it is built from real buttons and lists, the keyboard and
// screen reader route to everything the canvas does. Every write goes through the same functions as the canvas
// (src/containers.ts), so WIP limits, locks and the read-only board behave the same; moves are announced through the
// board's announcer. Sheet and Move to… use the admin pairs (ink and graphite on paper) as the design says; the row's ⋯
// menu is a kanban menu, tray chrome like the others.

const ARROWS: Record<string, MoveKey> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

let current: { close: () => void; containerId: Id } | null = null;

/** Closes the sheet when one is open. */
export function closeContainerSheet() {
  current?.close();
}

/** The sheet that is open, if any (for tests and the board UI). */
export const openSheetFor = () => current?.containerId ?? null;

export function openContainerSheet(app: BoardApp, containerId: Id, laneId?: Id) {
  if (app.store.get(containerId)?.type !== 'container') return null;
  current?.close();
  const store = app.store;
  let lane: Id | null = laneId ?? null;
  let adding = false;
  let addText = '';
  let dragging: { id: Id; pointer: number; index: number; row: HTMLElement } | null = null;
  const opener = document.activeElement as HTMLElement | null;

  const rights = () => sheetRights(app.readOnly, app.comments.readOnly());
  const layout = () => store.containerLayout(containerId);
  const cardsIn = (id: Id) => layout()?.cards.get(id) ?? [];
  const obj = (id: Id) => store.get(id) as BaseObj | undefined;

  const titleEl = h('h2', { class: 'ks-name', id: `ks-name-${containerId}` });
  const summary = h('span', { class: 'ks-summary' });
  const filterBtn = h('button', { class: 'ks-btn ks-filter', type: 'button', 'aria-haspopup': 'dialog' });
  const closeBtn = h('button', { class: 'ks-btn icon', type: 'button', 'aria-label': 'Close list' }, icon('close', 20));
  const tabs = h('div', { class: 'ks-tabs', role: 'tablist', 'aria-label': 'Lanes' });
  const rows = h('ul', { class: 'ks-rows', role: 'list' });
  /** The element with a `data-focus` key, to give focus back to after a redraw. */
  const byKey = (key: string) => Array.from(sheet.querySelectorAll<HTMLElement>('[data-focus]')).find((el) => el.dataset.focus === key) ?? null;
  const panel = h('div', { class: 'ks-panel', role: 'tabpanel', id: `ks-panel-${containerId}` }, rows);
  const addBar = h('div', { class: 'ks-add' });
  const sheet = h('section', { class: 'ks-sheet', role: 'region', 'aria-labelledby': titleEl.id },
    h('div', { class: 'ks-head' }, h('div', { class: 'ks-title' }, titleEl, summary), filterBtn, closeBtn),
    tabs, panel, addBar);
  keepKeys(sheet);

  // ---- placing: full width, from under the board's top tray to the bottom of the view
  const place = () => {
    const top = document.querySelector('.top-left')?.getBoundingClientRect();
    sheet.style.setProperty('--ks-top', `${top && top.bottom > 0 ? Math.round(top.bottom + 8) : 64}px`);
  };

  // ---- writes, each one transaction and one undo step through src/containers.ts
  const announceAt = (cardId: Id) => {
    const at = layout();
    const into = at ? [...at.cards].find(([, ids]) => ids.includes(cardId)) : undefined;
    if (into) app.announce(moveAnnouncement(laneName(obj(into[0])), into[1].indexOf(cardId) + 1, into[1].length));
  };
  /** Moves one card into a lane at an index, or says why not. Returns whether it moved. */
  const move = (cardId: Id, to: Id, index: number): boolean => {
    if (!rights().edit) return false;
    if (obj(cardId)?.locked) {
      app.notify('This card is locked. Unlock it to move it.');
      return false;
    }
    const refused = moveRefusal(store, [cardId], to);
    if (refused) {
      app.notify(refused);
      return false;
    }
    if (!moveCards(store, [cardId], to, index)) return false;
    announceAt(cardId);
    return true;
  };
  /** Alt+arrows on a row, as on the canvas: up and down in the lane, left and right to the next lane (it follows). */
  const keyMove = (cardId: Id, key: MoveKey) => {
    const at = layout();
    const m = at ? keyboardMove(at, cardId, key) : null;
    if (!m) return;
    if (move(cardId, m.lane, m.index)) {
      lane = m.lane;
      focusKey = `row:${cardId}`;
      render();
    }
  };
  const add = (title: string): boolean => {
    if (!lane || !rights().edit) return false;
    const refused = addCardRefusal(store, lane);
    if (refused) {
      app.notify(refused);
      return false;
    }
    const id = addCard(store, lane, title, { createdBy: app.user.id, font: store.getMeta().bodyFont });
    if (!id) return false;
    app.announce(`Added to ${laneName(obj(lane))}: ${title.trim()}`);
    return true;
  };

  // ---- the row's ⋯ menu and Move to…
  const rowMenu = (cardId: Id, anchor: HTMLElement) => {
    const card = obj(cardId);
    if (!card) return;
    const r = rights();
    const ids = cardsIn(lane!);
    const at = ids.indexOf(cardId);
    const locked = !!card.locked;
    const lockTip = locked ? 'This card is locked' : undefined;
    const menu = h('div', { class: 'menu k-menu', role: 'menu', 'aria-label': `Actions for ${card.text || 'card'}`, style: 'width:240px' });
    keepKeys(menu);
    let pop: { close: () => void } | null = null;
    const pick = (fn: () => void) => () => {
      pop?.close();
      fn();
    };
    const entries: (HTMLElement | null)[] = [
      r.edit ? item('Move to…', pick(() => openMoveTo(cardId)), { disabled: locked, title: lockTip }) : null,
      r.edit ? item('Move up', pick(() => keyMove(cardId, 'up')), { disabled: locked || at <= 0, title: lockTip }) : null,
      r.edit ? item('Move down', pick(() => keyMove(cardId, 'down')), { disabled: locked || at < 0 || at >= ids.length - 1, title: lockTip }) : null,
      r.edit ? sep() : null,
      r.open ? item('Open', pick(() => app.openCardDialog(cardId))) : null,
      r.edit ? item('Turn into sticky', pick(() => app.turnIntoStickies([cardId])), { disabled: locked, title: lockTip }) : null,
    ];
    menu.append(...entries.filter((x): x is HTMLElement => !!x));
    pop = popover(anchor, menu, { side: 'bottom', className: 'k-pop', label: menu.getAttribute('aria-label')! });
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  };

  let moveTo: { close: () => void } | null = null;
  /** The card Move to… is open for: its row is marked while it is. */
  let moving: Id | null = null;
  const openMoveTo = (cardId: Id) => {
    moveTo?.close();
    const card = obj(cardId);
    const from = lane;
    const at = layout();
    if (!card || !from || !at) return;
    let target: Id = from;
    let position: 'top' | 'bottom' = 'bottom';
    const choices = moveChoices(at.lanes.map((id) => ({ id, ...obj(id) })), from, (id) => cardsIn(id).length, (id) => moveRefusal(store, [cardId], id));
    const first = choices.find((c) => !c.current && !c.disabled);
    if (first) target = first.id;
    const group = h('div', { class: 'ks-lanes', role: 'radiogroup', 'aria-label': 'Lane' });
    const radios = choices.map((c) => {
      const sw = h('span', { class: 'ks-sw', 'aria-hidden': 'true' });
      const colour = kanbanSwatch(obj(c.id)?.fill);
      if (colour) sw.style.setProperty('--lc', colour);
      const b = h('button', {
        class: 'ks-lane-opt', type: 'button', role: 'radio', 'aria-checked': String(c.id === target),
        'aria-disabled': c.disabled ? 'true' : undefined, 'data-lane': c.id, 'data-tip': c.reason ?? undefined,
        onclick: () => {
          if (c.disabled) return app.notify(c.reason!);
          target = c.id;
          for (const x of radios) x.setAttribute('aria-checked', String(x === b));
        },
      }, h('span', { class: 'ks-rd', 'aria-hidden': 'true' }), sw, h('span', { class: 'ks-lane-name' }, c.name),
      h('span', { class: `ks-end${c.over && !c.current ? ' over' : ''}` }, c.disabled ? icon('lock', 12) : null, c.end),
      c.reason ? h('span', { class: 'sr-only' }, `. ${c.reason}`) : null);
      return b;
    });
    group.append(...radios);
    const posBtn = (p: 'top' | 'bottom', text: string) => h('button', {
      class: 'ks-opt', type: 'button', 'aria-pressed': String(p === position),
      onclick: (e: Event) => {
        position = p;
        for (const x of posRow.children) x.setAttribute('aria-pressed', String(x === e.currentTarget));
      },
    }, text);
    const posRow = h('div', { class: 'ks-pos', role: 'group', 'aria-label': 'Position' });
    posRow.append(posBtn('top', 'Top'), posBtn('bottom', 'Bottom'));
    const scrim = h('div', { class: 'ks-scrim' });
    const titleId = `ks-move-${cardId}`;
    const box = h('section', { class: 'ks-bsheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'ks-bs-head' }, h('h2', { id: titleId }, 'Move to…'), h('button', { class: 'ks-btn icon', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('close', 20))),
      h('p', { class: 'ks-bs-sub' }, card.text || 'Card'),
      group, posRow,
      h('div', { class: 'ks-bs-foot' },
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'primary', type: 'button', onclick: () => {
          const index = moveToIndex(cardsIn(target), cardId, position);
          if (move(cardId, target, index)) {
            close();
            lane = target;
            focusKey = `row:${cardId}`;
            render();
          }
        } }, 'Move')));
    const wrap = h('div', { class: 'ks-move' }, scrim, box);
    keepKeys(box);
    document.body.appendChild(wrap);
    const release = inertPage(wrap);
    const back = document.activeElement as HTMLElement | null;
    scrim.addEventListener('pointerdown', () => close());
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else trapTab(e, box);
    });
    // it goes when the card does, or when this person can no longer move it
    const stop = [store.onChange(() => {
      if (obj(cardId)?.type !== 'card' || !rights().edit) close();
    }), app.on('readonly', () => close())];
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      stop.forEach((f) => f());
      wrap.remove();
      release();
      moveTo = null;
      moving = null;
      render();
      restoreFocus(back);
    }
    moveTo = { close };
    moving = cardId;
    render();
    // the chosen lane (rovingRadios-style: the checked radio is the Tab stop)
    for (const r of radios) r.setAttribute('tabindex', r.getAttribute('aria-checked') === 'true' ? '0' : '-1');
    group.addEventListener('keydown', (e) => {
      const list = radios;
      const i = list.indexOf(e.target as HTMLButtonElement);
      if (i < 0) return;
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      // a lane that refuses the card is skipped; the one arrived at is chosen, as a click chooses it
      let to = i;
      for (let n = 1; n < list.length; n++) {
        const at = (i + step * n + list.length * n) % list.length;
        if (list[at].getAttribute('aria-disabled') !== 'true') {
          to = at;
          break;
        }
      }
      if (to === i) return;
      list[to].click();
      for (const r of list) r.setAttribute('tabindex', r === list[to] ? '0' : '-1');
      list[to].focus();
    });
    focusFirst(box, radios.find((r) => r.getAttribute('aria-checked') === 'true') ?? null);
  };

  // ---- drawing
  let focusKey: string | null = null;
  const keyOf = (el: Element | null) => (el instanceof HTMLElement ? el.closest<HTMLElement>('[data-focus]')?.dataset.focus ?? null : null);

  const chipsOf = (card: BaseObj, names: Map<Id, { name: string; color: string }>) => {
    const labels = (card.labels ?? []).map((id) => names.get(id)).filter((l): l is { name: string; color: string } => !!l);
    if (!labels.length) return null;
    const max = 2;
    return h('div', { class: 'ks-chips' }, ...labels.slice(0, max).map((l) => {
      const c = h('span', { class: 'ks-chip' }, l.name);
      const sw = kanbanSwatch(l.color);
      if (sw) c.style.setProperty('--lc', sw);
      return c;
    }), labels.length > max ? h('span', { class: 'ks-more', title: labels.slice(max).map((l) => l.name).join(', ') }, `+${labels.length - max}`) : null);
  };

  const metaOf = (card: BaseObj, done: boolean, today: string) => {
    const due = dueChip(card.due, today, done);
    const comments = app.r.commentCount(card.id);
    const owner = card.ownerName?.trim();
    if (!due && !comments && !owner) return null;
    return h('div', { class: 'ks-meta' },
      due ? h('span', { class: `ks-due ${due.kind}` }, due.kind === 'done' ? icon('check', 12) : null, due.text, due.kind === 'overdue' ? h('span', { class: 'sr-only' }, ', overdue') : null) : null,
      h('span', { class: 'ks-spacer' }),
      comments ? h('span', { class: 'ks-ccount', title: `${comments} ${comments === 1 ? 'comment' : 'comments'}` }, icon('comment', 14), String(comments)) : null,
      owner ? h('span', { class: 'ks-owner', title: `Owner: ${owner}`, 'aria-label': `Owner: ${owner}` }, initials(owner)) : null,
    );
  };

  const rowOf = (card: BaseObj, done: boolean, today: string, names: Map<Id, { name: string; color: string }>) => {
    const r = rights();
    const title = card.text?.trim() || 'Untitled card';
    const dim = app.isDimmed(card);
    const canDrag = r.edit && !card.locked;
    const grip = canDrag
      ? h('span', { class: 'ks-grip', 'aria-hidden': 'true', 'data-grip': card.id }, icon('grip', 20))
      : h('span', { class: 'ks-grip off', 'aria-hidden': 'true' }, card.locked ? icon('lock', 14) : null);
    const head = r.open
      ? h('button', { class: 'ks-row-title', type: 'button', 'data-focus': `row:${card.id}`, 'data-card': card.id, 'aria-keyshortcuts': r.edit ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined, onclick: () => app.openCardDialog(card.id) }, title)
      : h('div', { class: 'ks-row-title', tabindex: '0', 'data-focus': `row:${card.id}` }, title);
    const more = r.edit
      ? h('button', { class: 'ks-btn icon ks-more-btn', type: 'button', 'aria-label': `Actions for ${title}`, 'aria-haspopup': 'menu', 'data-focus': `more:${card.id}`, onclick: (e: Event) => rowMenu(card.id, e.currentTarget as HTMLElement) }, icon('dots', 20))
      : h('span', { class: 'ks-more-gap', 'aria-hidden': 'true' });
    const li = h('li', { class: `ks-row${dim ? ' dim' : ''}${card.locked ? ' locked' : ''}${moving === card.id ? ' sel' : ''}`, 'data-id': card.id }, grip,
      h('div', { class: 'ks-row-body' }, head, chipsOf(card, names), metaOf(card, done, today), dim ? h('span', { class: 'sr-only' }, 'Does not match the filter') : null),
      more);
    const accent = kanbanSwatch(card.fill);
    if (accent) li.style.setProperty('--fc', accent);
    return li;
  };

  function render() {
    const c = obj(containerId);
    const at = layout();
    if (!c || c.type !== 'container' || !at || !store.isShown(c)) return close();
    if (dragging) return;
    const r = rights();
    const keep = keyOf(document.activeElement) ?? focusKey;
    focusKey = null;
    const scroll = panel.scrollTop;
    const keepScroll = rows.childElementCount > 0;

    lane = activeLane(at.lanes, lane);
    const laneObj = lane ? obj(lane) : undefined;
    const total = [...at.cards.values()].reduce((n, ids) => n + ids.length, 0);
    titleEl.textContent = c.name?.trim() || 'Kanban';
    summary.textContent = sheetSummary(at.lanes.length, total);
    const parts = filterParts(app.kanbanFilter(containerId));
    filterBtn.replaceChildren(icon('filter', 18), h('span', null, parts ? `Filter · ${parts}` : 'Filter'));
    filterBtn.classList.toggle('on', parts > 0);
    filterBtn.setAttribute('aria-label', parts ? `Filter cards, ${parts} on` : 'Filter cards');

    // lane tabs, with counts as on the lane headers
    tabs.replaceChildren(...sheetTabs(at.lanes.map((id) => ({ id, ...obj(id) })), (id) => cardsIn(id).length).map((t) => {
      const on = t.id === lane;
      return h('button', {
        class: `ks-tab${on ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(on), 'aria-controls': panel.id,
        id: `ks-tab-${t.id}`, tabindex: on ? '0' : '-1', 'data-focus': `tab:${t.id}`, 'aria-label': t.label,
        onclick: () => {
          lane = t.id;
          adding = false;
          panel.scrollTop = 0;
          render();
        },
      }, h('span', { class: 'ks-tab-name' }, t.name), h('span', { class: `ks-n${t.count.state === 'over' ? ' over' : ''}` }, t.count.block ? icon('lock', 10) : null, t.count.text));
    }));
    if (lane) panel.setAttribute('aria-labelledby', `ks-tab-${lane}`);

    // rows
    const today = localToday();
    const names = new Map(listLabels(store).map((l) => [l.id, l]));
    const ids = lane ? cardsIn(lane) : [];
    const done = laneObj?.stage === 'done';
    rows.replaceChildren(...(ids.length
      ? ids.map((id) => obj(id)).filter((o): o is BaseObj => !!o).map((card) => rowOf(card, done, today, names))
      : [h('li', { class: 'ks-empty' }, 'No cards in this lane')]));
    rows.setAttribute('aria-label', `Cards in ${laneName(laneObj)}`);

    // the Add card bar: editors only; a full block lane refuses it and says why
    addBar.hidden = !r.edit || !lane;
    if (r.edit && lane) {
      const refused = addCardRefusal(store, lane);
      if (adding && !refused) {
        const input = h('input', { class: 'ks-input', type: 'text', maxlength: LIMITS.title, 'aria-label': `New card in ${laneName(laneObj)}`, placeholder: 'Card title', 'data-focus': 'add-input', value: addText });
        input.addEventListener('input', () => (addText = input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            if (input.value.trim() && add(input.value)) {
              addText = '';
              focusKey = 'add-input';
              render();
              panel.scrollTop = rows.scrollHeight;
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            stopAdding();
          }
        });
        addBar.replaceChildren(input, h('button', { class: 'ks-add-go', type: 'button', onclick: () => {
          if (input.value.trim() && add(input.value)) {
            addText = '';
            focusKey = 'add-input';
            render();
          }
        } }, 'Add'), h('button', { class: 'ks-btn icon', type: 'button', 'aria-label': 'Stop adding', onclick: () => stopAdding() }, icon('close', 20)));
      } else {
        adding = false;
        addBar.replaceChildren(h('button', {
          class: `ks-add-btn${refused ? ' refused' : ''}`, type: 'button', 'data-focus': 'add', 'aria-disabled': refused ? 'true' : undefined, 'data-tip': refused ?? undefined,
          onclick: () => {
            const why = addCardRefusal(store, lane!);
            if (why) return app.notify(why);
            adding = true;
            focusKey = 'add-input';
            render();
          },
        }, icon(refused ? 'lock' : 'plus', 18), h('span', null, `Add card to ${laneName(laneObj)}`), refused ? h('span', { class: 'sr-only' }, `. ${refused}`) : null));
      }
    }

    if (keepScroll) panel.scrollTop = scroll;
    if (keep) byKey(keep)?.focus({ preventScroll: !keep.startsWith('tab:') });
  }

  const stopAdding = () => {
    adding = false;
    addText = '';
    focusKey = 'add';
    render();
  };

  // ---- keys: the tabs move with the arrows, a row moves with Alt+arrows, Escape closes
  tabs.addEventListener('keydown', (e) => {
    const list = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const i = list.indexOf(e.target as HTMLButtonElement);
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const to = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const key = list[to].dataset.focus!;
    list[to].click();
    byKey(key)?.focus();
  });
  rows.addEventListener('keydown', (e) => {
    const key = ARROWS[e.key];
    const id = (e.target as HTMLElement).dataset?.card;
    if (!key || !e.altKey || !id || !rights().edit) return;
    e.preventDefault();
    keyMove(id, key);
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation();
      close();
    }
  });

  // ---- a row dragged by its handle: a line where it would land, one move on release (within the lane)
  const line = h('div', { class: 'ks-drop', 'aria-hidden': 'true' });
  rows.addEventListener('pointerdown', (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>('[data-grip]');
    if (!grip || !rights().edit || e.button !== 0) return;
    const row = grip.closest<HTMLElement>('.ks-row')!;
    e.preventDefault();
    grip.setPointerCapture?.(e.pointerId);
    dragging = { id: grip.dataset.grip!, pointer: e.pointerId, index: -1, row };
    row.classList.add('dragging');
    panel.appendChild(line);
    track(e.clientY);
  });
  const others = () => Array.from(rows.querySelectorAll<HTMLElement>('.ks-row')).filter((r) => r !== dragging?.row);
  const track = (y: number) => {
    if (!dragging) return;
    const list = others();
    const mids = list.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
    dragging.index = rowDropIndex(mids, y);
    const box = panel.getBoundingClientRect();
    const at = list[dragging.index]?.getBoundingClientRect().top ?? (list[list.length - 1]?.getBoundingClientRect().bottom ?? box.top);
    line.style.top = `${Math.round(at - box.top + panel.scrollTop - 1)}px`;
  };
  rows.addEventListener('pointermove', (e) => {
    if (dragging && e.pointerId === dragging.pointer) track(e.clientY);
  });
  const endDrag = (commit: boolean) => {
    const d = dragging;
    if (!d) return;
    dragging = null;
    line.remove();
    d.row.classList.remove('dragging');
    if (commit && lane && d.index >= 0) {
      focusKey = `row:${d.id}`;
      move(d.id, lane, d.index);
    }
    render();
  };
  rows.addEventListener('pointerup', (e) => {
    if (dragging && e.pointerId === dragging.pointer) endDrag(true);
  });
  rows.addEventListener('pointercancel', () => endDrag(false));

  // ---- living with the board
  let frame = 0;
  const later = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };
  const stops = [
    store.onChange(later),
    app.on('filter', later),
    app.on('comments', later),
    // a role that changes while it is open: the rows offer what the new role allows
    app.on('readonly', () => {
      if (app.readOnly) adding = false;
      later();
    }),
    app.comments.onReadOnly(later),
  ];
  const onLabels = () => later();
  store.labels.observe(onLabels);
  const onResize = () => place();
  window.addEventListener('resize', onResize);

  filterBtn.addEventListener('click', () => {
    const b = filterBtn.getBoundingClientRect();
    app.openKanbanMenu?.('filter', containerId, { x: b.left, y: b.top, w: b.width, h: b.height });
  });
  closeBtn.addEventListener('click', () => close());

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    endDrag(false);
    moveTo?.close();
    cancelAnimationFrame(frame);
    stops.forEach((f) => f());
    store.labels.unobserve(onLabels);
    window.removeEventListener('resize', onResize);
    sheet.remove();
    if (current?.close === close) current = null;
    restoreFocus(opener);
  }

  document.body.appendChild(sheet);
  current = { close, containerId };
  place();
  render();
  focusFirst(sheet, byKey(`tab:${lane}`));
  app.announce(`${titleEl.textContent} as a list: ${laneName(lane ? obj(lane) : undefined)}`);
  return { close, sheet };
}
