import './ai-bar.css';
import type { BoardApp } from '../app';
import { applyProposal, type AiProposal } from '../ai-apply';
import { settledNotice } from '../ai-live-logic';
import type { SettledRun } from '../ai-runs';
import {
  CHIPS, CHOSEN_BY_ADMIN, MODEL_CHIP_TIP, NARROW_DOCK, NOT_PRIVATE, NO_FACTS, OUTPUT_CAP, PHONE_DOCK, PROMPT_MAX, VISIBILITY_OFF, VISIBILITY_ON,
  addedMessage, aiTop, armedAfter, arrowPos, buildRunBody, canWalkHistory, chipState, clampPos, contextAfterSelection, contextLabel, contextMenu,
  disclosure, dockBottom, dragPos, errorView, estimateFor, formatPos, formatWait, isAdminRole, modelChipLabel, modelChipText,
  nearestIds, parseHistory, parsePos, placeholderFor, previewLine, promptSent, pushHistory, rateSpoken, rateText, resolveAiRun, runAi, runTarget,
  runTip, runningText, serializeHistory, settledMessage, stepHistory, thisRunText, toggleArmed, HISTORY_SHOWN,
  type AiContext, type AiFailure, type BarUi, type ErrorView, type Facts, type Pos, type RunBody,
} from '../ai-bar-logic';
import { ApiError, api, type AiConfig, type AiFeature } from '../api';
import { authState, onAuth } from '../auth';
import { boxBounds } from '../geometry';
import { isBox } from '../types';
import { openAiKeyDialog } from './ai';
import { modelLabel } from './ai-logic';
import { avoidForRun, barMoved, dropRun, linkBar, openReview, proposedByFor, reviewedProposal, setOwnRun, setStarting } from './ai-live';
import { toast } from './common';
import { ICONS, h, icon } from './dom';

// The AI bar (docs/ai-toolbar.md): a tray docked at the bottom of the board where the person asks the AI to summarise, cluster or
// generate. This file reads the board, draws the bar and calls the relay; the rules and the text are in src/ai-bar-logic.ts.
// A run produces a proposal that waits in the bar (Add to board, Discard, Retry); nothing is written until the person adds it.

const KEY_OPEN = 'driftboard:ai-bar';
const KEY_POS = 'driftboard:ai-bar-pos';
const KEY_HISTORY = 'driftboard:ai-history';
const KEY_PRIVATE = 'driftboard:ai-private';

// Storage may be blocked: the bar still works and forgets.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage is unavailable */ }
}

const fetchFn: typeof fetch = (...a) => fetch(...a);
const TOAST_LONG = 8000;
const RESOLVE_TIMEOUT_MS = 15000;
const resolveSignal = (): AbortSignal | undefined => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(RESOLVE_TIMEOUT_MS) : undefined);

// ---------------------------------------------------------------- glyphs the shared icon set does not have

const LOCAL_ICONS = {
  spark: '<path d="M11.5 5c.6 4.4 2.3 6.1 6.5 6.5-4.2.4-5.9 2.1-6.5 6.5-.6-4.4-2.3-6.1-6.5-6.5 4.2-.4 5.9-2.1 6.5-6.5z"/><path d="M19 2.5v3M17.5 4h3" stroke-width="1.5"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></g>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.2" r=".9" fill="currentColor"/>',
  wifiOff: '<path d="M3 3l18 18"/><path d="M2.5 9a14 14 0 015-2.9M10 5.2a14 14 0 0111.5 3.8M5.5 12.5a9.5 9.5 0 014.2-2.4M14 10.1a9.5 9.5 0 014.5 2.4M8.6 15.8a5 5 0 013.6-1.2"/><circle cx="12" cy="19" r=".9" fill="currentColor"/>',
} as const;

export function glyph(name: keyof typeof LOCAL_ICONS | keyof typeof ICONS, size = 18): HTMLSpanElement {
  if (!(name in LOCAL_ICONS)) return icon(name as keyof typeof ICONS, size);
  const s = document.createElement('span');
  s.className = 'ico';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${LOCAL_ICONS[name as keyof typeof LOCAL_ICONS]}</svg>`;
  return s;
}

// ---------------------------------------------------------------- reading the board

interface Gathered {
  facts: Facts;
  selection: string[];
  selectionStickies: string[];
  view: { id: string; x: number; y: number }[];
  center: { x: number; y: number };
}

/**
 * What the bar counts. A selection stands for its objects, and a selected frame for the stickies inside it. Only stickies are
 * counted for the visible area and the whole board: the v1 features read stickies.
 */
function gather(app: BoardApp): Gathered {
  const vp = app.r.viewport();
  const cache = app.store.cache;
  const frames = new Set<string>();
  const selection = new Set<string>();
  for (const id of app.selection) {
    const o = cache.get(id);
    if (!o || app.flow.isHidden(o as never)) continue;
    if (o.type === 'frame') frames.add(id);
    else selection.add(id);
  }
  const view: Gathered['view'] = [];
  let onBoard = 0;
  for (const o of cache.values()) {
    // a note private writing hides from this person is not theirs to hand to the AI
    if (o.type !== 'sticky' || !isBox(o) || app.flow.isHidden(o as never)) continue;
    onBoard++;
    if (o.parent && frames.has(o.parent)) selection.add(o.id);
    const b = boxBounds(o);
    if (b.x < vp.x + vp.w && vp.x < b.x + b.w && b.y < vp.y + vp.h && vp.y < b.y + b.h) view.push({ id: o.id, x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }
  const ids = [...selection];
  const selectionStickies = ids.filter((id) => cache.get(id)?.type === 'sticky');
  return {
    facts: { selected: ids.length, selectedStickies: selectionStickies.length, inView: view.length, onBoard },
    selection: ids,
    selectionStickies,
    view,
    center: { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 },
  };
}

// ---------------------------------------------------------------- mounting

export interface AiBarControl {
  /** Expands the bar, optionally sets its context and arms an action, and focuses the prompt. Starts nothing. */
  open(opts?: { arm?: AiFeature; context?: AiContext }): void;
  /** The bar's box, or its button's when collapsed, in viewport pixels; null while it is not on screen. */
  rect(): DOMRect | null;
}

const controls = new WeakMap<BoardApp, AiBarControl>();
const watchers = new WeakMap<BoardApp, Set<(why: 'mount' | 'layout') => void>>();
let shown = 0;

export const aiBarFor = (app: BoardApp): AiBarControl | null => controls.get(app) ?? null;

/** The bar came or went ('mount': the entry points show or hide), or changed size or place ('layout': the quick bar makes way). */
export function onAiBarChange(app: BoardApp, fn: (why: 'mount' | 'layout') => void): () => void {
  let set = watchers.get(app);
  if (!set) watchers.set(app, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

const announce = (app: BoardApp, why: 'mount' | 'layout') => {
  for (const fn of watchers.get(app) ?? []) fn(why);
};
/** Whether a bar is on the board right now: the shortcuts dialog lists "Ask AI" only for people who have it. */
export const aiBarShown = (): boolean => shown > 0;

/**
 * The bar is behind a flag until the canvas previews (TAB-123 step 3) are in: `?aibar` in the URL, or
 * localStorage `driftboard:flag:aibar` set to `1`. Without it nothing of the bar exists, not even its shortcut.
 */
export function aiBarFlag(): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('aibar')) return true;
  return read('driftboard:flag:aibar') === '1';
}

/**
 * Mounts the bar when AI is on for the workspace (GET /api/ai/config) and the person can edit this board, and takes it away
 * again, cancelling a preview, when either stops being true. Nothing is drawn for viewers, commenters or a workspace without AI.
 */
export function mountAiBar(app: BoardApp, chrome: HTMLElement): void {
  if (!aiBarFlag()) return;
  let config: AiConfig | null = null;
  let bar: Bar | null = null;
  let loading = false;
  let gone = false;

  const evaluate = () => {
    if (gone) return;
    if (config?.enabled && !app.readOnly) {
      if (bar) bar.setConfig(config);
      else bar = createBar(app, chrome, config);
    } else if (bar) {
      bar.destroy(true);
      bar = null;
    }
  };
  const load = () => {
    if (loading || gone || app.readOnly) return;
    loading = true;
    // a refusal (signed out, no access, no such route) takes the bar away; a connection that failed does not
    void api.aiConfig().then(
      (c) => { config = c; },
      (e: unknown) => {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) config = null;
      },
    ).then(() => {
      loading = false;
      evaluate();
    });
  };
  const sync = () => {
    evaluate();
    load();
  };

  const offs = [app.on('readonly', sync), onAuth(sync)];
  app.onDestroy(() => {
    gone = true;
    for (const off of offs) off();
    bar?.destroy(false);
    bar = null;
  });
  load();
}

// ---------------------------------------------------------------- the bar

interface Snap {
  ctx: AiContext;
  facts: Facts;
  prompt: string;
  armed: AiFeature | null;
}

/** What a run was started with: Retry runs exactly this again. */
interface Req {
  feature: AiFeature;
  body: RunBody;
  snap: Snap;
}

interface Bar {
  setConfig(c: AiConfig): void;
  /** `cancel`: the person lost the right to edit, so a preview is discarded; when the board just closes it stays for others. */
  destroy(cancel: boolean): void;
}

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace', ' ']);

const isEditable = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function createBar(app: BoardApp, chrome: HTMLElement, initial: AiConfig): Bar {
  let config = initial;
  let destroyed = false;
  let runSeq = 0;
  let selKey = '';
  let gathered: Gathered | null = null;

  const st = {
    ui: 'idle' as BarUi,
    open: read(KEY_OPEN) !== 'collapsed',
    armed: null as AiFeature | null,
    ctx: 'view' as AiContext,
    facts: NO_FACTS as Facts,
    prompt: '',
    histIdx: -1,
    history: parseHistory(read(KEY_HISTORY)),
    privateRun: read(KEY_PRIVATE) === '1',
    pos: parsePos(read(KEY_POS)),
    req: null as Req | null,
    run: null as { ctl: AbortController; token: number } | null,
    preview: null as { runId: string; proposal: AiProposal } | null,
    error: null as ErrorView | null,
    wait: 0,
    busy: false,
  };

  const isPhone = () => chrome.clientWidth <= PHONE_DOCK;
  const account = () => {
    const a = authState();
    return a.mode === 'signed-in' || a.mode === 'offline' ? a.me : null;
  };
  const isAdmin = () => isAdminRole(account()?.user.role);

  // ------------------------------------------------------------ the parts

  const ID = 'aibar';
  const fab = h('button', {
    class: 'tray aibar-fab', type: 'button', 'aria-label': 'Ask AI', 'aria-expanded': 'false', 'aria-controls': ID, 'data-tip': 'Ask AI', 'data-tip-key': 'mod+k',
    hidden: true, onclick: () => setOpen(true, true),
  }, glyph('spark', 22));

  const grip = h('button', {
    class: 'aibar-grip', type: 'button', 'aria-label': 'Move AI bar', 'data-tip': 'Drag to move. Double-click to dock.',
  }, glyph('grip', 16));
  const ctxLabel = h('span');
  const ctxBtn = h('button', { class: 'aibar-ctx', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openPop('ctx', ctxBtn) }, ctxLabel, icon('chevron', 14));
  const input = h('input', {
    class: 'aibar-input', type: 'text', 'aria-label': 'Prompt', autocomplete: 'off', enterkeyhint: 'send', spellcheck: 'true', maxlength: PROMPT_MAX,
  });
  const histBtn = h('button', {
    class: 'icon-btn aibar-hist', type: 'button', 'aria-label': 'Prompt history', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => openPop('hist', histBtn),
  }, icon('history', 18));
  const field = h('div', { class: 'aibar-field' }, input, histBtn);
  const status = h('div', { class: 'aibar-status aibar-off', role: 'status', 'aria-live': 'polite' });
  const summary = h('div', { class: 'aibar-summary', hidden: true });
  const err = h('div', { class: 'aibar-error aibar-off', role: 'alert' });
  const modelBtn = h('button', {
    class: 'aibar-model', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': MODEL_CHIP_TIP, onclick: () => openPop('model', modelBtn),
  });
  const actions = h('div', { class: 'aibar-actions' });
  const collapseBtn = h('button', {
    class: 'icon-btn aibar-collapse', type: 'button', 'aria-label': 'Collapse AI bar', 'data-tip': 'Collapse', 'data-tip-key': 'mod+k', onclick: () => collapse(),
  });
  const main = h('div', { class: 'aibar-main' }, ctxBtn, field, status, summary, err, modelBtn, actions, collapseBtn, grip);

  const chipEls = CHIPS.map((c, i) => ({
    id: c.id,
    el: h('button', { class: 'chip', type: 'button', 'data-id': c.id, 'aria-pressed': 'false', tabindex: i === 0 ? 0 : -1 }, c.label),
  }));
  const chips = h('div', { class: 'aibar-chips', role: 'toolbar', 'aria-label': 'AI quick actions' }, chipEls.map((c) => c.el));

  const sends = h('span');
  const pays = h('span', { class: 'sep' });
  const modelLine = h('button', { class: 'aibar-model-line', type: 'button', 'aria-haspopup': 'dialog', onclick: () => openPop('model', modelLine) });
  const disc = h('div', { class: 'aibar-disclosure' }, sends, pays, h('span', { class: 'sep aibar-model-wrap' }, modelLine));
  const progress = h('div', { class: 'aibar-progress', 'aria-hidden': 'true' });
  const bar = h('section', { class: 'tray aibar', id: ID, 'aria-label': 'Ask AI', 'data-ui': 'idle', 'data-open': 'true' }, main, chips, disc, progress);
  const dock = h('div', { class: 'aibar-dock' }, fab, bar);
  chrome.appendChild(dock);
  shown++;

  // ------------------------------------------------------------ small helpers

  const setDisabled = (el: HTMLElement, on: boolean) => {
    if (on) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  };
  const isDisabled = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';
  const setTip = (el: HTMLElement, tip: string | null, key: string | null = null) => {
    if (tip) el.setAttribute('data-tip', tip);
    else el.removeAttribute('data-tip');
    if (key) el.setAttribute('data-tip-key', key);
    else el.removeAttribute('data-tip-key');
  };
  const button = (cls: string, label: string, tip: string | null, key: string | null, onclick: (e: MouseEvent) => void) => {
    const b = h('button', { class: cls, type: 'button', onclick: (e: MouseEvent) => { if (!isDisabled(b)) onclick(e); } }, label);
    setTip(b, tip, key);
    return b;
  };

  const snapNow = (): Snap => ({ ctx: st.ctx, facts: st.facts, prompt: st.prompt, armed: st.armed });
  /** What the bar shows: the live state when idle, else what the run in hand was started with. */
  const shownSnap = (): Snap => (st.ui === 'idle' || !st.req ? snapNow() : st.req.snap);

  // ------------------------------------------------------------ context and counts

  function refresh() {
    if (destroyed) return;
    const g = gather(app);
    gathered = g;
    const key = app.selection.join(',');
    const changed = key !== selKey;
    selKey = key;
    st.facts = g.facts;
    if (changed) st.ctx = contextAfterSelection(st.ctx, g.facts.selected);
    else if (st.ctx === 'selection' && g.facts.selected === 0) st.ctx = 'view';
    paint();
  }

  let raf = 0;
  const later = (live = false) => {
    if (raf || !st.open) return;
    if (live && (st.ui !== 'idle' || st.ctx === 'none')) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refresh();
    });
  };

  // ------------------------------------------------------------ painting

  let actionsSig = '';
  const btns: Partial<Record<'run' | 'stop' | 'discard' | 'retry' | 'review' | 'add' | 'edit' | 'dismiss', HTMLButtonElement>> = {};
  let waitNum: HTMLElement | null = null;
  let errKey: ErrorView | null = null;
  let collapseIcon = '';
  let openState: boolean | null = null;
  let openTimer = 0;

  function applyOpen() {
    if (openState === st.open) return;
    const first = openState === null;
    openState = st.open;
    clearTimeout(openTimer);
    const ms = reducedMotion() ? 0 : 160;
    if (st.open) {
      bar.hidden = false;
      fab.setAttribute('aria-expanded', 'true');
      if (first) {
        fab.hidden = true;
        bar.dataset.open = 'true';
        return;
      }
      fab.dataset.open = 'false';
      void bar.offsetWidth;
      bar.dataset.open = 'true';
      openTimer = window.setTimeout(() => { if (st.open) fab.hidden = true; }, ms);
    } else {
      fab.hidden = false;
      fab.setAttribute('aria-expanded', 'false');
      if (first) {
        bar.hidden = true;
        bar.dataset.open = 'false';
        fab.dataset.open = 'true';
        return;
      }
      void fab.offsetWidth;
      fab.dataset.open = 'true';
      bar.dataset.open = 'false';
      openTimer = window.setTimeout(() => { if (!st.open) bar.hidden = true; }, ms);
    }
  }

  function paint() {
    if (destroyed) return;
    if (st.ui === 'idle') st.armed = armedAfter(st.armed, st.ctx, st.facts, config.features);
    const idle = st.ui === 'idle', running = st.ui === 'running', preview = st.ui === 'preview', failed = st.ui === 'error';
    const snap = shownSnap();
    const phone = isPhone();
    bar.dataset.ui = st.ui;
    applyOpen();

    // row 2
    ctxLabel.textContent = contextLabel(snap.ctx, snap.facts);
    ctxBtn.setAttribute('aria-label', `Context: ${ctxLabel.textContent}`);
    ctxBtn.hidden = preview || failed;
    field.hidden = !idle;
    const runText = running && st.req ? runningText(st.req.feature, snap.ctx, snap.facts) : '';
    if (status.textContent !== runText) status.replaceChildren(...(runText ? [h('span', null, runText)] : []));
    status.classList.toggle('aibar-off', !running);
    summary.hidden = !preview;
    const line = preview && st.preview ? previewLine(st.preview.proposal) : '';
    if (summary.textContent !== line) summary.textContent = line;
    err.classList.toggle('aibar-off', !failed);
    if (failed && errKey !== st.error) renderError();
    if (!failed && errKey) {
      errKey = null;
      err.replaceChildren();
    }
    const chipText = modelChipText({ armed: snap.armed, model: config.model, ctx: snap.ctx, facts: snap.facts, prompt: snap.prompt });
    modelBtn.hidden = !(idle || running);
    modelBtn.textContent = chipText;
    modelBtn.classList.toggle('armed', !!snap.armed);
    modelBtn.setAttribute('aria-label', modelChipLabel(chipText));
    modelLine.textContent = chipText;
    modelLine.setAttribute('aria-label', modelChipLabel(chipText));
    if (collapseIcon !== (phone ? 'chevron' : 'minus')) {
      collapseIcon = phone ? 'chevron' : 'minus';
      collapseBtn.replaceChildren(icon(phone ? 'chevron' : 'minus', 18));
    }
    setDisabled(collapseBtn, running || preview);
    grip.hidden = phone;

    paintActions();

    // row 1
    for (const { id, el } of chipEls) {
      const state = chipState(id, snap.ctx, snap.facts, config.features);
      el.classList.toggle('on', snap.armed === id);
      el.setAttribute('aria-pressed', String(snap.armed === id));
      // live in idle and after an error (docs/ai-toolbar.md, "States"), inert while running and previewing
      setDisabled(el, !(idle || failed) || !state.enabled);
      if ((idle || failed) && state.reason) el.setAttribute('data-tip', state.reason);
      else el.removeAttribute('data-tip');
    }

    // row 3
    const feature = idle ? st.armed : st.req?.feature ?? null;
    const [first, second] = disclosure({
      ui: st.ui, ctx: snap.ctx, facts: snap.facts, prompt: snap.prompt, withPrompt: promptSent(feature), keySource: config.keySource,
      privateRun: st.privateRun, proposalKind: st.preview?.proposal.kind ?? null,
    });
    if (sends.textContent !== first) sends.textContent = first;
    if (pays.textContent !== second) pays.textContent = second;

    // the prompt
    const placeholder = placeholderFor(st.armed);
    if (input.placeholder !== placeholder) input.placeholder = placeholder;
    if (input.value !== st.prompt) input.value = st.prompt;
    restackLater();
  }

  function paintActions() {
    const idle = st.ui === 'idle', running = st.ui === 'running', preview = st.ui === 'preview', failed = st.ui === 'error';
    const v = st.error;
    const sig = failed ? `error:${v?.retry}:${v?.edit}` : st.ui;
    if (sig !== actionsSig) {
      actionsSig = sig;
      for (const k of Object.keys(btns)) delete btns[k as keyof typeof btns];
      const list: HTMLElement[] = [];
      if (idle) list.push((btns.run = button('btn primary', 'Run', null, null, startRun)));
      else if (running) list.push((btns.stop = button('btn', 'Stop', 'Stop', 'escape', stop)));
      else if (preview) {
        list.push(
          (btns.discard = button('btn ghost', 'Discard', 'Discard', 'escape', discard)),
          (btns.retry = button('btn', 'Retry', 'Run it again', null, retryPreview)),
          // item by item, edited before it is added (TAB-160): the panel's Add and Discard are this bar's
          (btns.review = button('btn', 'Review', 'Choose what to add and edit it first', null, () => {
            const p = st.preview;
            if (p) openReview(app, p.runId, { accept: () => void add(false), discard });
          })),
          // a click with no pointer (detail 0) is the keyboard: the focus then goes back to the prompt
          (btns.add = button('btn primary', 'Add to board', 'Add to board', 'enter', (e) => void add(e.detail === 0))),
        );
      } else if (failed && v) {
        if (v.retry) list.push((btns.retry = button('btn', 'Retry', 'Run it again', null, retryError)));
        if (v.edit) list.push((btns.edit = button('btn', 'Edit request', 'Back to the prompt', null, dismiss)));
        list.push((btns.dismiss = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', 'data-tip': 'Dismiss', 'data-tip-key': 'escape', onclick: dismiss }, icon('close', 18))));
      }
      actions.replaceChildren(...list);
    }
    if (idle && btns.run) {
      const target = runTarget(st.armed, st.prompt, st.ctx, st.facts, config.features);
      setDisabled(btns.run, !target);
      setTip(btns.run, runTip(target), target ? 'enter' : null);
    }
    if (preview) for (const b of [btns.discard, btns.retry, btns.review, btns.add]) if (b) setDisabled(b, st.busy);
    if (failed && btns.retry) {
      const waiting = st.wait > 0;
      setDisabled(btns.retry, waiting);
      setTip(btns.retry, waiting ? 'Available when the countdown ends' : 'Run it again');
    }
  }

  function renderError() {
    errKey = st.error;
    waitNum = null;
    const v = st.error;
    if (!v) {
      err.replaceChildren();
      return;
    }
    const text = h('span');
    if (v.kind === 'rate') {
      // the number counts down for the eye; a screen reader gets the sentence once, and again when the wait ends
      const visible: (Node | string)[] = [];
      if (st.wait > 0) {
        waitNum = h('span', null, formatWait(st.wait));
        visible.push('Too many requests. Try again in ', waitNum, '.');
      } else visible.push(rateText(0));
      text.append(h('span', { class: 'aibar-sr' }, rateSpoken(st.wait)), h('span', { 'aria-hidden': 'true' }, ...visible));
    } else {
      text.append(v.text);
      if (v.link) {
        const label = v.link.target === 'my-key'
          ? h('button', { class: 'link', type: 'button', onclick: () => openAiKeyDialog() }, v.link.label)
          : h('a', { class: 'link', href: '#/admin/ai' }, v.link.label);
        text.append(' ', v.link.before, label, v.link.after);
      } else if (v.note) text.append(' ', h('span', { class: 'note' }, v.note));
    }
    err.replaceChildren(glyph(v.offline ? 'wifiOff' : 'alert', 18), text);
  }

  // ------------------------------------------------------------ the countdown of a rate limit

  let waitUntil = 0;
  let countdown = 0;
  const stopCountdown = () => {
    clearInterval(countdown);
    countdown = 0;
  };
  function startCountdown() {
    stopCountdown();
    countdown = window.setInterval(() => {
      st.wait = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
      if (st.wait > 0) {
        if (waitNum) waitNum.textContent = formatWait(st.wait);
        return;
      }
      stopCountdown();
      if (st.ui === 'error') {
        renderError();
        paint();
      }
    }, 1000);
  }

  // ------------------------------------------------------------ focus, open and collapse

  function focusPrimary() {
    const target = st.ui === 'idle' ? input : st.ui === 'running' ? btns.stop : st.ui === 'preview' ? btns.add : actions.querySelector<HTMLElement>('button, a');
    target?.focus();
  }
  const focusPrompt = () => {
    if (st.ui === 'idle') input.focus();
  };

  function setOpen(v: boolean, focus = false) {
    st.open = v;
    write(KEY_OPEN, v ? 'open' : 'collapsed');
    closePop();
    if (v) refresh();
    else paint();
    if (focus) setTimeout(() => (v ? focusPrimary() : fab.focus()), 0);
  }
  const canCollapse = () => st.ui === 'idle' || st.ui === 'error';
  function collapse() {
    if (canCollapse()) setOpen(false, true);
  }
  /** Ctrl/Cmd+K: expands and focuses the prompt; with focus in the open bar it collapses; with focus elsewhere it focuses the prompt. */
  function toggle() {
    if (!st.open) return setOpen(true, true);
    const at = document.activeElement;
    const inside = !!at && (dock.contains(at) || !!pop?.el.contains(at));
    if (inside && canCollapse()) return setOpen(false, true);
    focusPrimary();
  }

  // ------------------------------------------------------------ running

  function startRun() {
    if (st.ui !== 'idle' || app.readOnly || destroyed) return;
    refresh();
    const feature = runTarget(st.armed, st.prompt, st.ctx, st.facts, config.features);
    const g = gathered;
    if (!feature || !g) return;
    const body = buildRunBody({
      feature, boardId: app.conn.id, ctx: st.ctx, prompt: st.prompt, selection: g.selection, selectionStickies: g.selectionStickies,
      view: nearestIds(g.view, g.center), person: { name: app.user.name, color: app.user.color }, keySource: config.keySource, privateRun: st.privateRun,
    });
    if (promptSent(feature) && st.prompt.trim()) {
      st.history = pushHistory(st.history, st.prompt);
      write(KEY_HISTORY, serializeHistory(st.history));
    }
    st.histIdx = -1;
    closePop();
    void begin({ feature, body, snap: snapNow() });
  }

  async function begin(req: Req) {
    st.req = req;
    st.error = null;
    st.preview = null;
    stopCountdown();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return fail('network');
    const ctl = new AbortController();
    const token = ++runSeq;
    st.run = { ctl, token };
    st.ui = 'running';
    paint();
    focusPrimary();
    // the live layer draws this run's ghosts from the relay's patches; it needs to know which run is the bar's own
    setStarting(app, { name: app.user.name, color: app.user.color });
    const onRunId = (id: string) => {
      if (destroyed || st.run?.token !== token) return;
      setOwnRun(app, id);
      setStarting(app, null);
    };
    const out = await runAi(fetchFn, req.body, { signal: ctl.signal, onRunId });
    setStarting(app, null);
    if (destroyed || st.run?.token !== token) return;
    st.run = null;
    if (!out.ok) {
      if (out.failure.code !== 'aborted') fail(out.failure.code, out.failure);
      return;
    }
    if (!out.runId) return fail('internal');
    setOwnRun(app, out.runId);
    st.preview = { runId: out.runId, proposal: out.proposal };
    st.ui = 'preview';
    paint();
    focusPrimary();
  }

  function fail(code: string, failure?: AiFailure) {
    st.run = null;
    st.preview = null;
    st.error = errorView(code, { admin: isAdmin(), keySource: config.keySource, retryAfter: failure?.retryAfter ?? null, message: failure?.message ?? null });
    st.ui = 'error';
    stopCountdown();
    st.wait = st.error.wait ?? 0;
    if (st.wait > 0) {
      waitUntil = Date.now() + st.wait * 1000;
      startCountdown();
    }
    renderError();
    paint();
  }

  /** Stop closes the request, which makes the relay fail the run; the prompt is kept. */
  function stop() {
    if (st.ui !== 'running') return;
    st.run?.ctl.abort();
    st.run = null;
    st.ui = 'idle';
    paint();
    focusPrompt();
  }

  function dismiss() {
    if (st.ui !== 'error') return;
    stopCountdown();
    st.error = null;
    st.ui = 'idle';
    paint();
    focusPrompt();
  }

  function retryError() {
    if (st.ui !== 'error' || st.wait > 0 || !st.req) return;
    void begin(st.req);
  }

  // ------------------------------------------------------------ the preview

  /** Discard writes nothing. The relay may say 409 or 404: the preview is gone either way. */
  function discard() {
    const p = st.preview;
    if (st.ui !== 'preview' || st.busy) return;
    if (p) {
      void resolveAiRun(fetchFn, p.runId, 'discard', resolveSignal(), app.user.name);
      dropRun(app, p.runId);
    }
    st.preview = null;
    st.ui = 'idle';
    paint();
    focusPrompt();
  }

  /** Retry: let go of this preview and run the same request again. */
  function retryPreview() {
    const p = st.preview;
    const req = st.req;
    if (st.ui !== 'preview' || st.busy || !p || !req) return;
    void resolveAiRun(fetchFn, p.runId, 'discard', resolveSignal(), app.user.name);
    dropRun(app, p.runId);
    void begin(req);
  }

  /** Add to board: the relay settles it first (the first call wins), and only the app that won writes. */
  async function add(byKeyboard: boolean) {
    const p = st.preview;
    if (st.ui !== 'preview' || !p || st.busy) return;
    // a review that kept nothing adds nothing: said before the relay settles the run for everyone
    if (!reviewedProposal(app, p.runId, p.proposal)) return void toast('Nothing is selected to add.');
    st.busy = true;
    paint();
    // taken before the answer: the stickies land where the ghosts are, whatever the board does meanwhile
    const avoid = avoidForRun(app, p.runId);
    const proposedBy = proposedByFor(app, p.runId);
    const res = await resolveAiRun(fetchFn, p.runId, 'accept', resolveSignal(), app.user.name);
    st.busy = false;
    if (destroyed || st.preview !== p) return;
    const leave = () => {
      st.preview = null;
      st.ui = 'idle';
    };
    switch (res.kind) {
      case 'ok': {
        const proposal = res.proposal ? reviewedProposal(app, p.runId, res.proposal) : null;
        dropRun(app, p.runId);
        if (!proposal) return fail('internal');
        const applied = applyProposal(app, proposal, avoid, proposedBy);
        if (!applied.ok) return fail(applied.reason === 'read_only' ? 'read_only' : 'board_changed');
        leave();
        st.prompt = '';
        st.histIdx = -1;
        st.armed = null;
        st.req = null;
        paint();
        refresh();
        toast(addedMessage(proposal), TOAST_LONG, { label: 'Undo', keyId: 'mod+z', onClick: () => app.store.undo.undo() });
        if (byKeyboard) input.focus();
        return;
      }
      case 'settled':
        dropRun(app, p.runId);
        leave();
        paint();
        toast(settledMessage(res.action, res.by, account()?.user.id ?? null));
        return;
      case 'gone':
        dropRun(app, p.runId);
        leave();
        paint();
        toast('That preview is gone. Run it again.');
        return;
      case 'forbidden':
        return fail('forbidden');
      case 'read_only':
        return fail('read_only');
      case 'running':
        paint();
        return toast('The AI is still working on it. Try again in a moment.');
      case 'network':
        paint();
        return toast('Could not reach the server. Try again.');
      default:
        paint();
        return toast('Something went wrong. Try again.');
    }
  }

  /** The relay says a run came off the board. When it is the one this preview came from, someone else settled it. */
  function settledElsewhere(run: SettledRun) {
    const p = st.preview;
    // during the bar's own add, the answer to its click tells the story
    if (destroyed || st.ui !== 'preview' || !p || p.runId !== run.id || st.busy) return;
    const hadFocus = dock.contains(document.activeElement);
    st.preview = null;
    st.ui = 'idle';
    paint();
    if (hadFocus) focusPrompt();
    toast(settledNotice(run, account()?.user.id ?? null));
  }

  // ------------------------------------------------------------ popovers

  type PopKind = 'ctx' | 'hist' | 'model';
  let pop: { kind: PopKind; el: HTMLElement; anchor: HTMLElement } | null = null;

  function closePop(refocus = false) {
    if (!pop) return;
    const { el, anchor } = pop;
    pop = null;
    el.remove();
    for (const b of [ctxBtn, histBtn, modelBtn, modelLine]) b.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus();
  }

  function openPop(kind: PopKind, anchor: HTMLElement) {
    if (pop?.kind === kind && pop.anchor === anchor) return closePop(true);
    closePop();
    if (kind === 'ctx') refresh();
    const el = kind === 'ctx' ? contextPop() : kind === 'hist' ? historyPop() : modelPop();
    el.addEventListener('keydown', (e) => {
      if (NAV_KEYS.has(e.key)) e.stopPropagation();
      if (e.key === 'Tab') return closePop();
      const items = [...el.querySelectorAll<HTMLElement>('.menu-item')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
      if (to === null || !items.length) return;
      e.preventDefault();
      items[(to + items.length) % items.length].focus();
    });
    chrome.appendChild(el);
    pop = { kind, el, anchor };
    anchor.setAttribute('aria-expanded', 'true');
    const cr = chrome.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    el.style.left = `${Math.round(Math.max(8, Math.min(cr.width - el.offsetWidth - 8, ar.left - cr.left)))}px`;
    if (ar.top - cr.top < el.offsetHeight + 16) el.style.top = `${Math.round(ar.bottom - cr.top + 8)}px`;
    else el.style.bottom = `${Math.round(cr.bottom - ar.top + 8)}px`;
    if (kind === 'model') el.focus();
    else (el.querySelector<HTMLElement>('[aria-checked="true"], .menu-item') ?? el).focus();
  }

  function contextPop(): HTMLElement {
    return h('div', { class: 'tray aibar-pop', role: 'menu', 'aria-label': 'What the AI works on' }, contextMenu(st.facts).map((item) => {
      const b = h('button', {
        class: 'menu-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(st.ctx === item.id), 'aria-disabled': item.disabled ? 'true' : undefined,
        onclick: () => {
          if (item.disabled) return;
          st.ctx = item.id;
          closePop(true);
          paint();
        },
      }, h('span', null, item.label), h('span', { class: 'menu-hint' }, item.hint));
      return b;
    }));
  }

  function historyPop(): HTMLElement {
    const list = st.history.slice(0, HISTORY_SHOWN);
    return h('div', { class: 'tray aibar-pop', role: 'listbox', 'aria-label': 'Recent prompts' }, list.length
      ? list.map((text) => h('button', {
        class: 'menu-item', type: 'button', role: 'option', 'aria-selected': 'false',
        onclick: () => {
          st.prompt = text;
          st.histIdx = -1;
          closePop();
          paint();
          input.focus();
        },
      }, h('span', null, text)))
      : h('div', { class: 'aibar-note' }, 'No prompts yet.'));
  }

  function modelPop(): HTMLElement {
    const snap = shownSnap();
    const feature = snap.armed ?? 'generate';
    const description = h('span');
    const paintDescription = () => description.replaceChildren(h('b', null, 'Private run'), h('br'), st.privateRun ? VISIBILITY_ON : VISIBILITY_OFF);
    let visibility: HTMLElement;
    if (config.keySource === 'user') {
      paintDescription();
      visibility = h('label', { class: 'aibar-switch' },
        h('input', {
          type: 'checkbox', role: 'switch', checked: st.privateRun,
          onchange: (e: Event) => {
            st.privateRun = (e.currentTarget as HTMLInputElement).checked;
            write(KEY_PRIVATE, st.privateRun ? '1' : null);
            paintDescription();
            paint();
          },
        }),
        description);
    } else {
      visibility = h('div', { class: 'aibar-note' }, `${VISIBILITY_OFF} ${NOT_PRIVATE}`);
    }
    return h('div', { class: 'tray aibar-pop', role: 'dialog', 'aria-label': 'Model and cost', tabindex: -1 },
      h('div', { class: 'aibar-label' }, 'Model'),
      h('div', { class: 'aibar-note' }, h('b', null, modelLabel(config.model)), h('br'), CHOSEN_BY_ADMIN, isAdmin() ? [' ', h('a', { class: 'link', href: '#/admin/ai' }, 'AI settings')] : null),
      h('div', { class: 'aibar-label' }, 'Visibility'),
      visibility,
      h('div', { class: 'aibar-label' }, 'This run'),
      h('div', { class: 'aibar-note' }, thisRunText(estimateFor({ armed: snap.armed, ctx: snap.ctx, facts: snap.facts, prompt: snap.prompt }), OUTPUT_CAP[feature])));
  }

  const onPointerDown = (e: PointerEvent) => {
    if (pop && e.target instanceof Node && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePop();
  };
  window.addEventListener('pointerdown', onPointerDown, true);

  // ------------------------------------------------------------ the prompt, the chips

  input.addEventListener('input', () => {
    st.prompt = input.value;
    st.histIdx = -1;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      startRun();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && canWalkHistory(st.prompt, st.histIdx) && st.history.length) {
      e.preventDefault();
      const step = stepHistory(st.history, st.histIdx, e.key === 'ArrowUp' ? 'up' : 'down');
      st.histIdx = step.index;
      st.prompt = step.text;
      paint();
    }
  });

  const roving = (to: HTMLElement) => {
    for (const { el } of chipEls) el.tabIndex = el === to ? 0 : -1;
  };
  chips.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('.chip');
    if (!el) return;
    roving(el);
    if ((st.ui !== 'idle' && st.ui !== 'error') || isDisabled(el)) return;
    // after an error a chip is a fresh start: the error goes, the choice stays
    if (st.ui === 'error') {
      stopCountdown();
      st.error = null;
      st.ui = 'idle';
    }
    // a chip arms its action; Run or Enter starts it, with the estimate in view
    st.armed = toggleArmed(st.armed, el.dataset.id as AiFeature, st.ctx, st.facts, config.features);
    paint();
    if (st.armed) input.focus();
  });
  chips.addEventListener('keydown', (e) => {
    const els = chipEls.map((c) => c.el);
    const at = els.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = els[(to + els.length) % els.length];
    roving(next);
    next.focus();
    next.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  });

  // keys inside the bar are the bar's: arrows must not nudge the selection, Delete must not delete it
  dock.addEventListener('keydown', (e) => {
    if (NAV_KEYS.has(e.key)) e.stopPropagation();
  });

  // ------------------------------------------------------------ dock and drag

  const visibleEl = () => (st.open ? bar : fab);
  function applyPos(pos: Pos | null): Pos | null {
    if (!pos || isPhone()) {
      dock.classList.remove('dragged');
      dock.style.left = dock.style.bottom = dock.style.right = '';
      return null;
    }
    const cr = chrome.getBoundingClientRect();
    const r = visibleEl().getBoundingClientRect();
    const p = clampPos(pos, { w: r.width, h: r.height }, { w: cr.width, h: cr.height });
    dock.classList.add('dragged');
    dock.style.left = `${p.left}px`;
    dock.style.bottom = `${p.bottom}px`;
    dock.style.right = 'auto';
    return p;
  }
  const currentPos = (): Pos => {
    const cr = chrome.getBoundingClientRect();
    const r = visibleEl().getBoundingClientRect();
    return { left: r.left - cr.left, bottom: cr.bottom - r.bottom };
  };
  function dockAgain() {
    st.pos = null;
    write(KEY_POS, null);
    applyPos(null);
    restack();
  }
  function remember(p: Pos | null) {
    if (!p) return;
    st.pos = p;
    write(KEY_POS, formatPos(p));
  }

  let drag: { x: number; y: number; start: Pos; cur: Pos | null } | null = null;
  grip.addEventListener('pointerdown', (e) => {
    if (isPhone() || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, start: currentPos(), cur: null };
    grip.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    closePop();
  });
  grip.addEventListener('pointermove', (e) => {
    if (drag) drag.cur = applyPos(dragPos(drag.start, e.clientX - drag.x, e.clientY - drag.y));
  });
  const endDrag = () => {
    if (drag) remember(drag.cur);
    drag = null;
    bar.classList.remove('dragging');
    restack();
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', dockAgain);
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      return dockAgain();
    }
    const next = arrowPos(currentPos(), e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    remember(applyPos(next));
    restack();
  });

  /**
   * Stacks the bar above whatever is docked below it (the session bar, a poll card) and publishes `--ai-bottom` on the chrome and
   * `--ai-top` on the page: how far the bar reaches up from the bottom, so the toast and the focus cards stay above it.
   */
  let boxSig = '';
  function restack() {
    if (destroyed) return;
    const cr = chrome.getBoundingClientRect();
    const tops: number[] = [];
    for (const el of chrome.querySelectorAll('.flowbar.show, .poll-card:not([hidden])')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0) tops.push(r.top);
    }
    chrome.style.setProperty('--ai-bottom', `${dockBottom({ narrow: cr.width <= NARROW_DOCK, boardBottom: cr.bottom, tops })}px`);
    const placed = applyPos(st.pos);
    // a bar dragged elsewhere does not stack: it stays where it was put
    const top = placed ? 0 : aiTop(cr.bottom, visibleEl().getBoundingClientRect().top);
    document.documentElement.style.setProperty('--ai-top', `${top}px`);
    // the quick bar and the label rows on the board make way for the bar
    const box = visibleEl().getBoundingClientRect();
    const sig = `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}`;
    if (sig !== boxSig) {
      boxSig = sig;
      barMoved(app);
      announce(app, 'layout');
    }
  }
  let restackRaf = 0;
  function restackLater() {
    if (restackRaf || destroyed) return;
    restackRaf = requestAnimationFrame(() => {
      restackRaf = 0;
      restack();
    });
  }

  const ro = new ResizeObserver(restackLater);
  const watch = new MutationObserver(() => {
    watchBars();
    restackLater();
  });
  function watchBars() {
    for (const el of chrome.querySelectorAll('.flowbar, .poll-card')) {
      ro.observe(el);
      watch.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
  }
  ro.observe(chrome);
  ro.observe(bar);
  ro.observe(fab);
  watch.observe(chrome, { childList: true });
  watchBars();

  // ------------------------------------------------------------ keyboard

  const onKey = (e: KeyboardEvent) => {
    if (destroyed || e.isComposing || document.querySelector('.modal-back')) return;
    const mod = e.metaKey || e.ctrlKey;
    const target = e.target;
    const inBar = target instanceof Node && (dock.contains(target) || !!pop?.el.contains(target));
    const editable = isEditable(target);
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Ctrl/Cmd+K: the text editor on the board and other text fields keep the key
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      if (app.editor.active || (editable && !inBar)) return;
      consume();
      toggle();
      return;
    }
    // "/" is the fallback when no text field has focus
    if (e.key === '/' && !mod && !e.altKey && !editable && !app.editor.active) {
      consume();
      setOpen(true, true);
      return;
    }
    if (app.editor.active) return;

    if (e.key === 'Escape') {
      if (document.querySelector('.popover')) return;
      if (pop) {
        consume();
        closePop(true);
      } else if (!st.open) return;
      else if (st.ui === 'running') {
        consume();
        stop();
      } else if (st.ui === 'preview') {
        consume();
        discard();
      } else if (st.ui === 'error') {
        consume();
        dismiss();
      } else if (st.armed) {
        consume();
        st.armed = null;
        paint();
      }
      return;
    }
    // Enter adds the preview when focus is on the board or on Add (a focused button handles Enter itself)
    if (e.key === 'Enter' && !e.repeat && !mod && st.ui === 'preview' && st.open && !editable && !(target instanceof Element && target.closest('button, a, [role="menuitemradio"], [role="option"]'))) {
      consume();
      void add(true);
    }
  };
  window.addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------ the board

  const offs = [app.on('selection', () => later()), app.on('objects', () => later(true)), app.r.onCamera(() => { if (st.ctx === 'view') later(true); }), app.on('flow', restackLater)];
  // the phone layout swaps the collapse glyph and hides the grip
  let wasPhone = isPhone();
  const onResize = () => {
    if (isPhone() !== wasPhone) {
      wasPhone = isPhone();
      paint();
    } else restackLater();
  };
  window.addEventListener('resize', onResize);

  const control: AiBarControl = {
    open(opts = {}) {
      if (opts.context) st.ctx = opts.context;
      if (!st.open) {
        st.open = true;
        write(KEY_OPEN, 'open');
      }
      refresh();
      if (opts.arm && chipState(opts.arm, st.ctx, st.facts, config.features).enabled) st.armed = opts.arm;
      paint();
      setTimeout(() => focusPrimary(), 0);
    },
    rect() {
      const el = visibleEl();
      if (destroyed || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 ? r : null;
    },
  };
  controls.set(app, control);
  linkBar(app, { rect: () => control.rect(), settled: settledElsewhere });
  announce(app, 'mount');

  refresh();

  return {
    setConfig(c) {
      config = c;
      paint();
    },
    destroy(cancel) {
      if (destroyed) return;
      destroyed = true;
      st.run?.ctl.abort();
      // a preview nobody settles stays for the others to add or discard; losing the right to edit takes it with us
      if (cancel && st.preview) {
        void resolveAiRun(fetchFn, st.preview.runId, 'discard', resolveSignal(), app.user.name);
        dropRun(app, st.preview.runId);
      }
      stopCountdown();
      clearTimeout(openTimer);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(restackRaf);
      for (const off of offs) off();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      watch.disconnect();
      closePop();
      dock.remove();
      chrome.style.removeProperty('--ai-bottom');
      document.documentElement.style.removeProperty('--ai-top');
      if (controls.get(app) === control) {
        controls.delete(app);
        linkBar(app, null);
      }
      shown--;
      announce(app, 'mount');
    },
  };
}
