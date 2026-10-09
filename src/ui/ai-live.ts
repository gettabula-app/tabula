import './ai-live.css';
import type { BoardApp } from '../app';
import { applyProposal, boardOf, type Layout, type Rect } from '../ai-apply';
import { errorView, resolveAiRun, type ResolveAction } from '../ai-bar-logic';
import {
  ROW_H, acceptedMessage, clearGhostText, discardedMessage, firstMessage, ghostMarkup, ghostSource, hasTray, intersects, isMine, labelColors, personColor, placeLabelRows,
  previewBox, previewLabelText, stacked, targetBounds, type LabelRowIn,
} from '../ai-live-logic';
import { LiveRuns, avoidFor, presenceLine, previewLayouts, type LiveRun, type SettledRun } from '../ai-runs';
import { authState, onAuth } from '../auth';
import { onFontLoaded } from '../fonts';
import { DEFAULTS } from '../markup';
import { toast } from './common';
import { h } from './dom';

// The live layer of the AI bar (docs/ai-toolbar.md, "Multiplayer (TAB-141)"): what the board shows of the AI runs of the people on
// it. One LiveRuns per board, fed by the relay. Every ready run is drawn as ghosts on the canvas with a label row (and, for
// someone else's, Discard and Accept for editors); every run in flight that is not the person's own gets an outline around its
// target. It mounts whenever the flag is on, also for viewers and commenters, who see all of it and can touch none of it.

const fetchFn: typeof fetch = (...a) => fetch(...a);
const TOAST_LONG = 8000;
const RESOLVE_TIMEOUT_MS = 15000;
const OUTLINE_GAP = 8;

/** What the live layer asks of the bar, so the two do not import each other. */
export interface BarLink {
  /** The bar's box (or its button's) in viewport pixels, or null when it is not on screen. */
  rect(): DOMRect | null;
  /** A run came off the board: the bar returns to idle when it was the one its preview came from. */
  settled(run: SettledRun): void;
}

interface Live {
  runs: LiveRuns;
  /** The run the bar started: the person's own in open mode, and the one the bar (not a label row) acts on. */
  ownRunId: string | null;
  /** The bar has sent a request and does not know its run yet: who it runs as, to tell the run when it appears. */
  starting: { name: string; color: string } | null;
  link: BarLink | null;
  layouts: Map<string, Layout>;
  redraw(): void;
  /** Only the places of the label rows and outlines changed (the bar moved, the selection changed). */
  replace(): void;
}

const lives = new WeakMap<BoardApp, Live>();

/** The runs of this board as the relay told them; null when the live layer is not mounted (flag off, scratch board). */
export const liveRunsFor = (app: BoardApp): LiveRuns | null => lives.get(app)?.runs ?? null;

/** The bar says which run is its own, from the stream of its request. */
export function setOwnRun(app: BoardApp, id: string | null): void {
  const live = lives.get(app);
  if (!live || live.ownRunId === id) return;
  live.ownRunId = id;
  live.redraw();
}

/** The bar sent a run request as this person (or, with null, has its answer): the run that appears meanwhile is its own. */
export function setStarting(app: BoardApp, as: { name: string; color: string } | null): void {
  const live = lives.get(app);
  if (!live) return;
  live.starting = as;
  live.redraw();
}

export function linkBar(app: BoardApp, link: BarLink | null): void {
  const live = lives.get(app);
  if (!live) return;
  live.link = link;
  live.redraw();
}

/** The bar changed size or place: the label rows make way for it. */
export function barMoved(app: BoardApp): void {
  lives.get(app)?.replace();
}

/** The areas of the previews laid out before this run's: adding it there lands where its ghosts are. Taken before the add is awaited. */
export function avoidForRun(app: BoardApp, runId: string): Rect[] {
  const live = lives.get(app);
  if (!live) return [];
  const list = live.runs.list();
  return avoidFor(runId, list, previewLayouts(list, boardOf(app)));
}

/** The person's own add or discard was answered: the ghosts go at once, before the relay's patch arrives. */
export function dropRun(app: BoardApp, runId: string): void {
  lives.get(app)?.runs.drop(runId);
}

const meId = (): string | null => {
  const a = authState();
  return a.mode === 'signed-in' ? a.me.user.id : a.mode === 'offline' ? a.me?.user.id ?? null : null;
};

interface Row {
  el: HTMLElement;
  sig: string;
  /** Measured width in pixels; 0 until measured. */
  w: number;
  buttons: HTMLButtonElement[];
}

interface Outline {
  el: HTMLElement;
  sig: string;
}

const toRect = (r: DOMRect, origin: DOMRect): Rect => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });

export function mountAiLive(app: BoardApp): void {
  if (lives.has(app)) return;
  const runs = new LiveRuns();
  const live: Live = { runs, ownRunId: null, starting: null, link: null, layouts: new Map(), redraw: () => scheduleCompute(), replace: () => schedulePlace() };
  lives.set(app, live);

  const layer = h('div', { class: 'ailive' });
  app.r.root.insertBefore(layer, app.r.cursorLayer);

  const rows = new Map<string, Row>();
  const outlines = new Map<string, Outline>();
  const busy = new Set<string>();
  let ready: LiveRun[] = [];
  let flying: LiveRun[] = [];
  let mine = new Set<string>();
  let shownAi = '';
  let destroyed = false;

  // ------------------------------------------------------------ words and actions

  const say = (code: string) => toast(errorView(code, { admin: false, keySource: 'workspace' }).text);
  const nameOf = (run: LiveRun): string | null => run.by.name?.trim() || null;

  const markBusy = () => {
    for (const [id, row] of rows) {
      for (const b of row.buttons) {
        if (busy.has(id)) b.setAttribute('aria-disabled', 'true');
        else b.removeAttribute('aria-disabled');
      }
    }
  };

  /** Accept or Discard on someone's preview. The relay settles it first; only the app that won writes. */
  async function settle(run: LiveRun, action: ResolveAction) {
    if (busy.has(run.id) || app.readOnly || destroyed) return;
    busy.add(run.id);
    markBusy();
    // taken now, from the board as the ghosts are drawn: the add lands where they are
    const avoid = avoidFor(run.id, runs.list(), live.layouts);
    const res = await resolveAiRun(fetchFn, run.id, action, typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(RESOLVE_TIMEOUT_MS) : undefined, app.user.name);
    busy.delete(run.id);
    if (destroyed) return;
    markBusy();
    switch (res.kind) {
      case 'ok': {
        runs.drop(run.id);
        if (action === 'discard') return toast(discardedMessage(nameOf(run)));
        if (!res.proposal) return say('error');
        const applied = applyProposal(app, res.proposal, avoid);
        if (!applied.ok) return say(applied.reason === 'read_only' ? 'read_only' : 'board_changed');
        return toast(acceptedMessage(res.proposal, nameOf(run)), TOAST_LONG, { label: 'Undo', keyId: 'mod+z', onClick: () => app.store.undo.undo() });
      }
      case 'settled':
        runs.drop(run.id);
        return toast(firstMessage(res.action, res.by, run.by, meId()));
      case 'gone':
        runs.drop(run.id);
        return toast('That preview is gone.');
      case 'forbidden':
        return say('forbidden');
      case 'read_only':
        return say('read_only');
      case 'running':
        return toast('The AI is still working on it. Try again in a moment.');
      case 'network':
        return toast('Could not reach the server. Try again.');
      default:
        return toast('Something went wrong. Try again.');
    }
  }

  // ------------------------------------------------------------ label rows

  function buildRow(run: LiveRun, own: boolean, tray: boolean): Row {
    const text = previewLabelText(run, own);
    const { fill, ink } = labelColors(personColor(run));
    const whose = nameOf(run);
    const discard = h('button', { class: 'ailive-btn', type: 'button', 'data-tip': whose ? `Discard ${whose}'s preview` : 'Discard the preview', onclick: () => void settle(run, 'discard') }, 'Discard');
    const accept = h('button', { class: 'ailive-btn primary', type: 'button', 'data-tip': whose ? `Add ${whose}'s preview to the board` : 'Add the preview to the board', onclick: () => void settle(run, 'accept') }, 'Accept');
    const el = h('div', { class: `ailive-row${own ? ' mine' : ''}`, role: 'group', 'aria-label': text, style: `--c:${fill};--ink:${ink}` },
      h('span', { class: 'ailive-label' }, text),
      tray ? h('span', { class: 'tray ailive-tray' }, discard, accept) : null);
    return { el, sig: '', w: 0, buttons: tray ? [discard, accept] : [] };
  }

  function syncRow(run: LiveRun) {
    const own = mine.has(run.id);
    const tray = hasTray(run, { readOnly: app.readOnly, barRunId: live.ownRunId });
    const { fill, ink } = labelColors(personColor(run));
    // rebuilt only when what it says changed, so a hovered or focused button is not lost to a redraw
    const sig = `${previewLabelText(run, own)}|${fill}|${ink}|${own}|${tray}`;
    const have = rows.get(run.id);
    if (have && have.sig === sig) return;
    const next = buildRow(run, own, tray);
    next.sig = sig;
    if (have) have.el.replaceWith(next.el);
    else layer.appendChild(next.el);
    rows.set(run.id, next);
    markBusy();
  }

  // ------------------------------------------------------------ outlines of runs in flight

  function syncOutline(run: LiveRun) {
    const { fill, ink } = labelColors(personColor(run));
    const line = presenceLine(run);
    const sig = `${line}|${fill}|${ink}`;
    const have = outlines.get(run.id);
    if (have && have.sig === sig) return;
    const el = h('div', { class: 'ailive-run', 'aria-hidden': 'true', hidden: true, style: `--c:${personColor(run)};--lc:${fill};--ink:${ink}` },
      h('span', { class: 'ailive-ring' }),
      h('span', { class: 'ailive-label' }, line));
    if (have) have.el.replaceWith(el);
    else layer.appendChild(el);
    outlines.set(run.id, { el, sig });
  }

  // ------------------------------------------------------------ drawing

  const boundsOf = (id: string): Rect | null => {
    const o = app.store.get(id);
    return o ? app.r.bounds(o) : null;
  };

  function ghosts(): string {
    const zoom = app.r.cam.zoom;
    const meta = app.store.getMeta();
    const env = {
      px: (v: number) => v / zoom,
      sticky: (id: string) => {
        const o = app.store.get(id);
        return o?.type === 'sticky' ? ghostSource(o, app.r.isHidden(o), DEFAULTS.sticky.fill) : undefined;
      },
      bodyFont: meta.bodyFont,
      headingFont: meta.headingFont,
    };
    let out = '';
    for (const run of ready) {
      const layout = live.layouts.get(run.id);
      if (layout) out += ghostMarkup(layout, { color: mine.has(run.id) ? null : personColor(run) }, env);
    }
    return out;
  }

  /** Board rectangles to pixels, relative to the board surface. */
  const screenRect = (r: Rect): Rect => {
    const a = app.r.toScreen({ x: r.x, y: r.y });
    const b = app.r.toScreen({ x: r.x + r.w, y: r.y + r.h });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };

  function place() {
    if (!rows.size && !outlines.size) return;
    const origin = app.r.root.getBoundingClientRect();
    const view = { x: 0, y: 0, w: origin.width, h: origin.height };

    for (const run of flying) {
      const o = outlines.get(run.id);
      if (!o) continue;
      const b = targetBounds(run.target, boundsOf);
      const r = b ? screenRect(b) : null;
      const box = r ? { x: r.x - OUTLINE_GAP, y: r.y - OUTLINE_GAP, w: r.w + 2 * OUTLINE_GAP, h: r.h + 2 * OUTLINE_GAP } : null;
      o.el.hidden = !box || !intersects(box, view);
      if (box && !o.el.hidden) {
        o.el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
        o.el.style.width = `${Math.round(box.w)}px`;
        o.el.style.height = `${Math.round(box.h)}px`;
      }
    }

    // what a label row keeps off: the selection's quick bar, the AI bar, and the trays that always sit on the board
    const obstacles: Rect[] = [];
    for (const el of document.querySelectorAll('.quickbar.show, .chrome > .top-left, .chrome > .top-right, .chrome > .rail, .chrome > .zoom-tray')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) obstacles.push(toRect(r, origin));
    }
    const bar = live.link?.rect();
    if (bar) obstacles.push(toRect(bar, origin));

    const input: LabelRowIn[] = [];
    for (const run of ready) {
      const row = rows.get(run.id);
      const layout = live.layouts.get(run.id);
      if (!row || !layout) continue;
      const anchor = screenRect(previewBox(layout));
      // a preview that is off screen shows nothing: the avatar badge says someone has one
      row.el.hidden = !intersects(anchor, view);
      if (row.el.hidden) continue;
      if (!row.w) row.w = row.el.offsetWidth;
      input.push({ id: run.id, anchor, w: row.w, h: ROW_H });
    }
    for (const [id, at] of placeLabelRows(input, obstacles, { w: view.w, h: view.h })) {
      rows.get(id)!.el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    }
  }

  function paint() {
    if (destroyed) return;
    const next = ghosts();
    if (next !== shownAi) {
      shownAi = next;
      app.r.setOverlay({ ai: next });
    }
    place();
  }

  /** Everything that depends on the runs or the board's content: the layouts, the label rows, the outlines. */
  function compute() {
    if (destroyed) return;
    const list = runs.list();
    const me = meId();
    live.layouts = previewLayouts(list, boardOf(app));
    mine = new Set(list.filter((r) => isMine(r, me, live.ownRunId, live.starting)).map((r) => r.id));
    ready = stacked(list.filter((r) => live.layouts.has(r.id)), (r) => mine.has(r.id));
    // the person's own run draws no outline: the bar shows it
    flying = list.filter((r) => r.status === 'running' && !mine.has(r.id));

    const keepRows = new Set(ready.map((r) => r.id));
    for (const [id, row] of rows) {
      if (keepRows.has(id)) continue;
      row.el.remove();
      rows.delete(id);
      busy.delete(id);
    }
    for (const run of ready) syncRow(run);
    const keepOutlines = new Set(flying.map((r) => r.id));
    for (const [id, o] of outlines) {
      if (keepOutlines.has(id)) continue;
      o.el.remove();
      outlines.delete(id);
    }
    for (const run of flying) syncOutline(run);
    paint();
  }

  let raf = 0;
  let computing = false;
  const frame = () => {
    raf = 0;
    const full = computing;
    computing = false;
    if (full) compute();
    else place();
  };
  function scheduleCompute() {
    computing = true;
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }
  function schedulePlace() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ wiring

  const quiet = () => !ready.length && !flying.length && !shownAi;
  const offs = [
    app.conn.onAiRuns((message) => {
      for (const settled of runs.apply(message)) live.link?.settled(settled);
    }),
    runs.onChange(scheduleCompute),
    // the layouts follow the board: previews go right of whatever is on it now
    app.on('objects', () => { if (!quiet()) scheduleCompute(); }),
    app.on('meta', () => { if (!quiet()) scheduleCompute(); }),
    app.on('readonly', scheduleCompute),
    // the label rows keep clear of the selection's quick bar
    ...(['selection', 'tool', 'drag', 'editing'] as const).map((ev) => app.on(ev, () => { if (!quiet()) schedulePlace(); })),
    // drawn at once, in step with the canvas: the strokes keep their pixel width and the rows keep their place
    app.r.onCamera(() => { if (!quiet()) paint(); }),
    onAuth(scheduleCompute),
    onFontLoaded(() => {
      clearGhostText();
      for (const row of rows.values()) row.w = 0;
      scheduleCompute();
    }),
  ];
  const onResize = () => schedulePlace();
  window.addEventListener('resize', onResize);

  app.onDestroy(() => {
    destroyed = true;
    cancelAnimationFrame(raf);
    for (const off of offs) off();
    window.removeEventListener('resize', onResize);
    runs.clear();
    layer.remove();
    lives.delete(app);
    if (shownAi) app.r.setOverlay({ ai: '' });
  });
}
