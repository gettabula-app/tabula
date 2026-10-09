import './focus.css';
import type { BoardApp } from '../app';
import { personColor } from '../palette';
import { isBox } from '../types';
import { boxBounds } from '../geometry';
import { newId } from '../store';
import {
  REQUEST_TTL_MS, RequestTracker, buildRequest, cameraToView, isFollowedBy, loadMuted, mutePerson, parseRequest, parseView,
  promptLifetime, requestText, saveMuted, sameCamera, unmutePerson, cooldownLeft, viewDiffers, viewToCamera, type FocusRequest, type View,
} from '../focus-requests';
import { h } from './dom';
import { dialog, toast } from './common';

/** What the session bar needs: ask the others to look here, and how long until it may ask again. */
export interface FocusControl {
  /** Puts a request on this person's awareness state. False while the cooldown runs. Moves nobody. */
  ask(): boolean;
  cooldownLeft(): number;
}

const controls = new WeakMap<BoardApp, FocusControl>();

export const focusFor = (app: BoardApp): FocusControl | null => controls.get(app) ?? null;

const MAX_CARDS = 3;
const VIEW_EVERY_MS = 120;
/** The stack sits above the toast, which is 124 px up, and above the session bar when it is taller than that. */
const STACK_MIN_BOTTOM = 124;
/** Room for a toast between the session bar and the stack: the toast moves above the bar while one shows. */
const TOAST_ROOM = 52;

interface Card {
  el: HTMLElement;
  timer: number;
  clientId: number;
}

/**
 * Requests to look at someone's view, and following. A request is a field on the sender's awareness state; it moves
 * nobody. The recipient gets a card with Go to, Follow, Dismiss and Mute. Following is a mode the follower starts and
 * ends: while it runs, the person followed sends their view on awareness, and the follower's camera tracks it until the
 * follower moves the board themselves, presses Esc or the other person leaves.
 */
export function mountFocus(app: BoardApp, parent: HTMLElement) {
  const aw = app.conn.awareness;
  const me = app.user;
  const boardId = app.conn.id;
  const stack = h('div', { class: 'focus-stack', role: 'status', 'aria-live': 'polite' });
  parent.appendChild(stack);
  const place = () => {
    const bar = parent.querySelector('.flowbar.show');
    const above = bar ? parent.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8 + TOAST_ROOM : 0;
    // the AI bar publishes --ai-top (how far it reaches up from the bottom); the stack keeps clear of it, and of the toast above it
    stack.style.setProperty('--focus-bottom', `max(${Math.max(STACK_MIN_BOTTOM, Math.round(above))}px, calc(var(--ai-top, 0px) + ${TOAST_ROOM}px))`);
  };
  const placeLater = () => requestAnimationFrame(place);
  window.addEventListener('resize', placeLater);

  // ---------------------------------------------------------------- sending

  let lastAskAt: number | null = null;
  let clearTimer = 0;
  const publish = (req: FocusRequest) => {
    aw.setLocalStateField('focusRequest', req);
    clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      if ((aw.getLocalState()?.focusRequest as FocusRequest | null | undefined)?.id === req.id) aw.setLocalStateField('focusRequest', null);
    }, REQUEST_TTL_MS);
  };
  const sender = () => ({ id: me.id, name: me.name, color: me.color });

  const control: FocusControl = {
    ask() {
      const now = Date.now();
      if (cooldownLeft(lastAskAt, now) > 0) return false;
      lastAskAt = now;
      const vp = app.r.viewport();
      publish(buildRequest({ id: newId(), now, from: sender(), view: { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2, zoom: app.zoom } }));
      return true;
    },
    cooldownLeft: () => cooldownLeft(lastAskAt, Date.now()),
  };
  controls.set(app, control);

  // The session moved to a step with a frame on this screen: this screen has flown there, and the others are told.
  app.flow.onLocalStep = (step, frame) => publish(buildRequest({
    id: newId(), now: Date.now(), from: sender(), view: { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2, zoom: 1 },
    step: { id: step.id, title: step.title || 'Untitled step' },
  }));

  // ---------------------------------------------------------------- going to a request

  const goTo = (req: FocusRequest) => {
    if (req.kind === 'step') {
      const step = app.store.getFlow().steps.find((s) => s.id === req.stepId);
      const frame = step?.frameId ? app.store.get(step.frameId) : undefined;
      if (isBox(frame)) return app.r.flyTo(boxBounds(frame), 72, 1.2);
    }
    app.r.flyToCenter({ x: req.x, y: req.y }, req.zoom);
  };

  // ---------------------------------------------------------------- following

  let target: { clientId: number; userId: string; name: string } | null = null;
  /** True while this code sets the camera; any other change of the camera while following is the person moving the board. */
  let applying = false;
  /** The camera as this code last left it. */
  let ours = { ...app.r.cam };
  const chipText = h('span', { class: 'focus-chip-text' });
  const chip = h('div', { class: 'focus-chip' }, chipText, h('button', { class: 'btn ghost', onclick: () => stop('you') }, 'Stop'));

  const apply = (v: View) => {
    const size = app.r.size();
    if (!viewDiffers(v, cameraToView(app.r.cam, size))) return;
    applying = true;
    try {
      app.r.setCamera(viewToCamera(v, size));
    } finally {
      applying = false;
    }
    ours = { ...app.r.cam };
  };

  /** Ends following without a word. Returns the name of the person who was followed. */
  function end(): string | null {
    if (!target) return null;
    const name = target.name;
    target = null;
    aw.setLocalStateField('following', null);
    chip.remove();
    return name;
  }

  function stop(why: 'you' | 'left') {
    const name = end();
    if (name) toast(why === 'left' ? `${name} left the board, so you stopped following` : `Stopped following ${name}`);
  }

  const follow = (clientId: number, req: FocusRequest) => {
    end();
    const state = aw.getStates().get(clientId);
    if (!state) return toast(`${req.from.name} has left the board`);
    target = { clientId, userId: req.from.id, name: req.from.name };
    chipText.textContent = `Following ${req.from.name}. Pan, zoom or press Esc to stop.`;
    stack.prepend(chip);
    ours = { ...app.r.cam };
    aw.setLocalStateField('following', clientId);
    // The other screen starts sending its view now. Until it arrives, a view request's own view stands in for it.
    const view = parseView(state.view) ?? (req.kind === 'view' ? { x: req.x, y: req.y, zoom: req.zoom } : null);
    if (view) apply(view);
  };

  // ---------------------------------------------------------------- sending my view to the people following me

  let publishing = false;
  let viewTimer = 0;
  const sendView = () => {
    viewTimer = 0;
    if (publishing) aw.setLocalStateField('view', cameraToView(app.r.cam, app.r.size()));
  };
  const syncPublishing = () => {
    const want = isFollowedBy(aw.getStates(), aw.clientID);
    if (want === publishing) return;
    publishing = want;
    if (want) return sendView();
    clearTimeout(viewTimer);
    viewTimer = 0;
    aw.setLocalStateField('view', null);
  };

  // A camera that is not the one this code left is the person moving the board (setCamera({}) with nothing to change is not).
  const offCamera = app.r.onCamera(() => {
    if (!applying && target && !sameCamera(app.r.cam, ours)) stop('you');
    if (publishing && !viewTimer) viewTimer = window.setTimeout(sendView, VIEW_EVERY_MS);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && target) stop('you');
  };
  window.addEventListener('keydown', onKey, true);

  // ---------------------------------------------------------------- the cards

  const cards = new Map<string, Card>();
  const dropCard = (userId: string) => {
    const c = cards.get(userId);
    if (!c) return;
    clearTimeout(c.timer);
    c.el.remove();
    cards.delete(userId);
    place();
  };

  const showCard = (clientId: number, req: FocusRequest) => {
    const life = promptLifetime(req, Date.now());
    if (life <= 0) return;
    const userId = req.from.id;
    dropCard(userId);
    const done = (fn: () => void) => () => {
      dropCard(userId);
      fn();
    };
    const el = h('div', { class: 'focus-card', 'data-kind': req.kind },
      h('p', { class: 'focus-text' }, h('span', { class: 'focus-swatch', 'aria-hidden': 'true', style: req.from.color ? `--c:${personColor(req.from.color)}` : undefined }), requestText(req)),
      h('div', { class: 'focus-actions' },
        h('button', { class: 'btn primary', onclick: done(() => goTo(req)) }, 'Go to'),
        h('button', { class: 'btn', onclick: done(() => follow(clientId, req)) }, 'Follow'),
        h('button', { class: 'btn ghost', onclick: done(() => undefined) }, 'Dismiss'),
        h('button', {
          class: 'btn ghost focus-mute',
          onclick: done(() => {
            saveMuted(me.id, boardId, mutePerson(loadMuted(me.id, boardId), { id: userId, name: req.from.name }));
            toast(`Muted ${req.from.name}. Unmute them in the board menu.`);
          }),
        }, `Mute ${req.from.name}`)));
    stack.appendChild(el);
    cards.set(userId, { el, clientId, timer: window.setTimeout(() => dropCard(userId), life) });
    while (cards.size > MAX_CARDS) dropCard(cards.keys().next().value!);
    place();
  };

  // ---------------------------------------------------------------- awareness

  const tracker = new RequestTracker();
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const states = aw.getStates();
    for (const id of [...added, ...updated]) {
      if (id === aw.clientID) continue;
      const st = states.get(id);
      const raw = st?.focusRequest as { id?: unknown } | null | undefined;
      if (!raw || typeof raw !== 'object' || (typeof raw.id === 'string' && tracker.hasSeen(raw.id))) continue;
      const req = parseRequest(raw);
      // The sender must be the person this client announced, or anyone could ask in someone else's name.
      if (!req || st?.user?.id !== req.from.id) continue;
      const verdict = tracker.evaluate(req, { now: Date.now(), me: me.id, muted: loadMuted(me.id, boardId), following: target?.userId ?? null });
      if (verdict.show) showCard(id, req);
    }
    for (const id of removed) {
      for (const [userId, c] of cards) if (c.clientId === id) dropCard(userId);
    }
    if (target) {
      if (removed.includes(target.clientId)) stop('left');
      else if (updated.includes(target.clientId)) {
        const view = parseView(states.get(target.clientId)?.view);
        if (view) apply(view);
      }
    }
    syncPublishing();
  };
  aw.on('change', onChange);
  const offFlow = app.on('flow', placeLater);

  app.onDestroy(() => {
    aw.off('change', onChange);
    offFlow();
    window.removeEventListener('resize', placeLater);
    offCamera();
    window.removeEventListener('keydown', onKey, true);
    clearTimeout(clearTimer);
    clearTimeout(viewTimer);
    for (const c of cards.values()) clearTimeout(c.timer);
    app.flow.onLocalStep = null;
    controls.delete(app);
    stack.remove();
  });
}

// ---------------------------------------------------------------- the muted list

export const mutedCount = (app: BoardApp): number => loadMuted(app.user.id, app.conn.id).length;

/** Who this person has muted on this board, with a way back. The list outlives the people, who may be offline. */
export function openMuted(app: BoardApp) {
  const list = h('ul', { class: 'focus-muted' });
  const draw = () => {
    const muted = loadMuted(app.user.id, app.conn.id);
    list.replaceChildren(...(muted.length
      ? muted.map((p) => h('li', null,
        h('span', { class: 'focus-muted-name' }, p.name),
        h('button', {
          class: 'btn',
          'aria-label': `Unmute ${p.name}`,
          onclick: () => {
            saveMuted(app.user.id, app.conn.id, unmutePerson(loadMuted(app.user.id, app.conn.id), p.id));
            draw();
          },
        }, 'Unmute')))
      : [h('li', { class: 'muted' }, 'Nobody is muted.')]));
  };
  draw();
  dialog('Muted people', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Requests to look at their view from these people are ignored on this board, on this device. Unmute someone to see their requests again.'),
    list,
  ), [{ label: 'Done', primary: true }]);
}
