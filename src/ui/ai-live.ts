import './ai-live.css';
import type { BoardApp } from '../app';
import { applyProposal, boardOf, type AiProposal, type Layout, type Rect } from '../ai-apply';
import { fingerprintOf, isStale, refreshStale, reviewCounts, reviewed, startReview, type Fingerprint, type Review } from '../ai-review';
import type { ProposedBy } from '../types';
import { errorView, resolveAiRun, type ResolveAction } from '../ai-bar-logic';
import {
  CHANGED_NOTE, ROW_H, acceptedMessage, clearGhostText, discardedMessage, firstMessage, ghostMarkup, ghostSource, hasTray, intersects, isMine, labelColors, leftOutNote, nothingToAdd, personColor, placeLabelRows,
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
  /** The person's own review of a run (TAB-160): kept items, edits. Never sent anywhere; the ghosts on this screen follow it. */
  reviews: Map<string, Review>;
  /** How the stickies a group proposal moves looked when it arrived here, to tell which changed since. */
  seen: Map<string, Map<string, Fingerprint | null>>;
  /** Told after every recompute: the review panel follows the runs and the board. */
  listeners: Set<() => void>;
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
  const list = shownRuns(live, app);
  return avoidFor(runId, list, previewLayouts(list, boardOf(app)));
}

/** The person's own add or discard was answered: the ghosts go at once, before the relay's patch arrives. */
export function dropRun(app: BoardApp, runId: string): void {
  const live = lives.get(app);
  if (!live) return;
  live.reviews.delete(runId);
  live.seen.delete(runId);
  live.runs.drop(runId);
}

// ---------------------------------------------------------------- review (TAB-160)

/** The runs with each proposal as this person reviewed it: what is drawn here and what an add of it writes. */
/** A run as it is shown here: `changed` is set, with the stickies it named, when every one of them changed since it came (TAB-221). */
export type ShownRun = LiveRun & { changed?: { ids: string[] } };

function shownRuns(live: Live, app: BoardApp): ShownRun[] {
  return live.runs.list().map((r): ShownRun => {
    if (!r.proposal) return r;
    // with no review open the default one stands in (TAB-213): a member that changed since is neither drawn nor added
    const review = live.reviews.get(r.id) ?? (r.status === 'ready' ? startReview(r.proposal, staleIn(live, app, r.id)) : null);
    if (!review) return r;
    const shown = reviewed(r.proposal, review);
    // nothing left to draw because every sticky changed: the run stays on the board as a short row, so it can still be discarded
    const { total, stale } = reviewCounts(review);
    if (!shown && r.status === 'ready' && r.proposal.kind === 'group' && total > 0 && stale === total) {
      return { ...r, proposal: null, changed: { ids: r.proposal.groups.flatMap((g) => g.ids) } };
    }
    return { ...r, proposal: shown };
  });
}

/** Whether a member of a group proposal changed (or went) since the proposal arrived on this screen. */
function staleIn(live: Live, app: BoardApp, runId: string): (id: string) => boolean {
  const then = live.seen.get(runId);
  return (id) => isStale(then?.get(id), fingerprintOf(app.store.get(id) as { x?: number; y?: number; w?: number; h?: number; text?: string; parent?: string; type?: string; locked?: boolean } | undefined));
}

export const reviewFor = (app: BoardApp, runId: string): Review | null => lives.get(app)?.reviews.get(runId) ?? null;

/** Sets (or, with null, drops) the person's review of a run; the ghosts redraw from it. */
export function setReview(app: BoardApp, runId: string, review: Review | null): void {
  const live = lives.get(app);
  if (!live) return;
  if (review) live.reviews.set(runId, review);
  else live.reviews.delete(runId);
  live.redraw();
}

export const staleFor = (app: BoardApp, runId: string): ((id: string) => boolean) => {
  const live = lives.get(app);
  return live ? staleIn(live, app, runId) : () => false;
};

/**
 * The person's review of a run as it is now, as a function from the relay's proposal to what they add. Taken before an add
 * asks the relay: the run's patch can reach the app first and drop the review, and the add must still write what was ticked.
 */
export function takeReview(app: BoardApp, runId: string, proposal: AiProposal | null): TakenReview {
  const live = lives.get(app);
  const review = live?.reviews.get(runId);
  // with no review open the default one is made now, so an add skips the members that changed since as the panel would (TAB-213)
  const kept = review ? structuredClone(review) : proposal && live ? startReview(proposal, staleIn(live, app, runId)) : null;
  return { choose: (p) => (kept ? reviewed(p, kept) : p), stale: kept ? reviewCounts(kept).stale : 0 };
}

/** What takeReview took: the function from the relay's proposal to what is written, and how many members it leaves out as changed. */
export interface TakenReview {
  choose: (proposal: AiProposal) => AiProposal | null;
  stale: number;
}

/** The label rows' own margins, as in `placeLabelRows` (src/ai-live-logic.ts): the board's edge, and the rail's. */
const ROW_EDGE_PX = 8;
const ROW_RAIL_PX = 4;

/** The room a preview gets around it when it is brought into view, beyond the chrome's own insets: the label row above it. */
const SHOW_PAD = 40;
const SHOW_MAX_ZOOM = 1;

/**
 * Brings a preview into view (TAB-218): the camera flies to its box. Only ever called from a click on a Show button, for the
 * person's own run: a preview that arrives, yours or anyone's, never moves the camera (test/ai-live-camera.test.ts).
 */
export function showRun(app: BoardApp, runId: string): boolean {
  const layout = lives.get(app)?.layouts.get(runId);
  if (!layout) return false;
  app.r.flyTo(previewBox(layout), SHOW_PAD, SHOW_MAX_ZOOM);
  return true;
}

/** What an add stamps on the objects it creates: the run's feature and who asked for it. */
export function proposedByFor(app: BoardApp, runId: string): ProposedBy | undefined {
  const run = lives.get(app)?.runs.get(runId);
  return run ? { feature: run.feature, by: { id: run.by.id, name: run.by.name } } : undefined;
}

export function onLiveChange(app: BoardApp, fn: () => void): () => void {
  const live = lives.get(app);
  if (!live) return () => {};
  live.listeners.add(fn);
  return () => live.listeners.delete(fn);
}

/** The opener of the review panel (src/ui/ai-review-panel.ts registers it, so the two do not import each other). */
let reviewOpener: ((app: BoardApp, runId: string, actions: ReviewActions) => void) | null = null;
export interface ReviewActions { accept(): void; discard(): void }
export function setReviewOpener(fn: typeof reviewOpener): void {
  reviewOpener = fn;
}
export function openReview(app: BoardApp, runId: string, actions: ReviewActions): void {
  reviewOpener?.(app, runId, actions);
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
  /** Measured size with the buttons under the label (TAB-215); set with `w`. */
  wrap?: { w: number; h: number };
  /** Measured height of a row that is more than one line high (the short row of TAB-221); set with `w`. */
  h?: number;
  /** The width the short row was measured for: it is capped to the room beside the rail, which changes with the board's width. */
  room?: number;
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
  const live: Live = {
    runs, ownRunId: null, starting: null, link: null, layouts: new Map(), reviews: new Map(), seen: new Map(), listeners: new Set(),
    redraw: () => scheduleCompute(), replace: () => schedulePlace(),
  };
  lives.set(app, live);

  const layer = h('div', { class: 'ailive' });
  app.r.root.insertBefore(layer, app.r.cursorLayer);

  const rows = new Map<string, Row>();
  const outlines = new Map<string, Outline>();
  const busy = new Set<string>();
  let ready: ShownRun[] = [];
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
    // a review that kept nothing adds nothing: say so before the relay settles the run for everyone
    const taken = takeReview(app, run.id, run.proposal);
    if (action === 'accept' && run.proposal && !taken.choose(run.proposal)) return toast(nothingToAdd(taken.stale));
    const proposedBy = proposedByFor(app, run.id);
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
        const proposal = res.proposal ? taken.choose(res.proposal) : null;
        dropRun(app, run.id);
        if (action === 'discard') return toast(discardedMessage(nameOf(run)));
        if (!proposal) return say('error');
        const applied = applyProposal(app, proposal, avoid, proposedBy);
        if (!applied.ok) return say(applied.reason === 'read_only' ? 'read_only' : 'board_changed');
        return toast(`${acceptedMessage(proposal, nameOf(run))}${leftOutNote(taken.stale)}`, TOAST_LONG, { label: 'Undo', keyId: 'mod+z', onClick: () => app.store.undo.undo() });
      }
      case 'settled':
        dropRun(app, run.id);
        return toast(firstMessage(res.action, res.by, run.by, meId()));
      case 'gone':
        dropRun(app, run.id);
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

  function buildRow(run: ShownRun, own: boolean, tray: boolean): Row {
    const text = previewLabelText(run, own);
    const { fill, ink } = labelColors(personColor(run));
    const whose = nameOf(run);
    const discard = h('button', { class: 'ailive-btn', type: 'button', 'data-tip': whose ? `Discard ${whose}'s preview` : 'Discard the preview', onclick: () => void settle(run, 'discard') }, 'Discard');
    const accept = h('button', { class: 'ailive-btn primary', type: 'button', 'data-tip': whose ? `Add ${whose}'s preview to the board` : 'Add the preview to the board', onclick: () => void settle(run, 'accept') }, 'Accept');
    // item by item, edited before it is added (TAB-160)
    const review = h('button', { class: 'ailive-btn', type: 'button', 'data-tip': 'Choose what to add and edit it first', onclick: () => openReview(app, run.id, { accept: () => void settle(run, 'accept'), discard: () => void settle(run, 'discard') }) }, 'Review');
    // your own preview is drawn wherever the board has room, which may be off screen: Show brings it into view (TAB-218)
    const show = h('button', { class: 'ailive-btn', type: 'button', 'data-tip': 'Bring the preview into view', onclick: () => void showRun(app, run.id) }, 'Show');
    if (run.changed) {
      // every sticky it would move has changed since it came (TAB-221): nothing to draw or add, but it can be discarded
      const note = h('span', { class: 'tray ailive-note' }, CHANGED_NOTE);
      const el = h('div', { class: `ailive-row changed${own ? ' mine' : ''}`, role: 'group', 'aria-label': `${text}: ${CHANGED_NOTE}`, style: `--c:${fill};--ink:${ink}` },
        h('span', { class: 'ailive-label' }, text),
        tray ? h('span', { class: 'tray ailive-tray' }, discard) : null,
        note);
      return { el, sig: '', w: 0, buttons: tray ? [discard] : [] };
    }
    const el = h('div', { class: `ailive-row${own ? ' mine' : ''}`, role: 'group', 'aria-label': text, style: `--c:${fill};--ink:${ink}` },
      h('span', { class: 'ailive-label' }, text),
      tray ? h('span', { class: 'tray ailive-tray' }, discard, review, accept) : own ? h('span', { class: 'tray ailive-tray' }, show) : null);
    return { el, sig: '', w: 0, buttons: tray ? [discard, review, accept] : [] };
  }

  function syncRow(run: ShownRun) {
    const own = mine.has(run.id);
    const tray = hasTray(run, { readOnly: app.readOnly, barRunId: live.ownRunId });
    const { fill, ink } = labelColors(personColor(run));
    // rebuilt only when what it says changed, so a hovered or focused button is not lost to a redraw
    const sig = `${previewLabelText(run, own)}|${fill}|${ink}|${own}|${tray}|${run.changed ? 'changed' : ''}`;
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

    // what a label row keeps off: the selection's quick bar, the AI bar, the review panel, and the trays that always sit on the board
    const obstacles: Rect[] = [];
    for (const el of document.querySelectorAll('.quickbar.show, .chrome > .top-left, .chrome > .top-right, .chrome > .rail, .chrome > .zoom-tray, .chrome > .aireview')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) obstacles.push(toRect(r, origin));
    }
    const bar = live.link?.rect();
    if (bar) obstacles.push(toRect(bar, origin));

    // the run under review has its own Add and Discard in the panel: its row would only peek out from behind it
    const reviewing = new Set([...document.querySelectorAll<HTMLElement>('.chrome > .aireview')].map((el) => el.dataset.run));
    const railEl = document.querySelector('.chrome > .rail');
    const railEdgeNow = railEl ? Math.max(0, railEl.getBoundingClientRect().right - origin.left) : 0;
    const railEdge = railEdgeNow;
    const input: LabelRowIn[] = [];
    for (const run of ready) {
      const row = rows.get(run.id);
      const layout = live.layouts.get(run.id);
      if (!row || (!layout && !run.changed)) continue;
      const anchor = layout ? screenRect(previewBox(layout)) : changedAnchor(run, view);
      // a preview that is off screen shows nothing: the avatar badge says someone has one
      row.el.hidden = reviewing.has(run.id) || !intersects(anchor, view);
      if (row.el.hidden) continue;
      // the short row of a changed run (TAB-221) is never wider than the room right of the rail, and is measured again when that changes
      const room = Math.max(120, view.w - ROW_EDGE_PX - Math.max(ROW_EDGE_PX, railEdgeNow + ROW_RAIL_PX));
      if (row.room !== room) {
        // the room changed (the board was resized): the row is measured again
        row.room = room;
        row.w = 0;
        if (run.changed) row.el.style.maxWidth = `${room}px`;
      }
      if (!row.w) {
        // the row in one line, then with its buttons under the label, for a board too narrow for the first (TAB-215); the
        // stacked row is never wider than the room, and a label longer than that is cut with an ellipsis
        row.el.classList.remove('wrapped');
        if (!run.changed) row.el.style.maxWidth = '';
        row.w = row.el.offsetWidth;
        row.el.classList.add('wrapped');
        if (!run.changed) row.el.style.maxWidth = `${room}px`;
        row.wrap = { w: row.el.offsetWidth, h: row.el.offsetHeight || 2 * ROW_H };
        row.el.classList.remove('wrapped');
        if (!run.changed) row.el.style.maxWidth = '';
        if (run.changed) row.h = row.el.offsetHeight || 2 * ROW_H;
      }
      // the short row of a changed run is its own form: it is not wrapped, and it is taller than a row of buttons
      input.push({ id: run.id, anchor, w: row.w, h: row.h ?? ROW_H, ...(row.wrap?.w && !run.changed ? { wrap: row.wrap } : {}) });
    }
    // a row never goes left of the rail (its right edge is read first: the short row's width depends on it)
    for (const [id, at] of placeLabelRows(input, obstacles, { w: view.w, h: view.h }, railEdge)) {
      const el = rows.get(id)!.el;
      el.classList.toggle('wrapped', at.wrapped === true);
      if (!ready.find((r) => r.id === id)?.changed) el.style.maxWidth = at.wrapped ? `${Math.max(120, view.w - ROW_EDGE_PX - Math.max(ROW_EDGE_PX, railEdge + ROW_RAIL_PX))}px` : '';
      el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    }
  }

  /** Where the short row of a run whose stickies all changed hangs: over the ones still on the board, else in the middle of the view. */
  function changedAnchor(run: ShownRun, view: Rect): Rect {
    const boxes = (run.changed?.ids ?? []).map(boundsOf).filter((b): b is Rect => !!b).map(screenRect);
    if (!boxes.length) return { x: view.w / 2 - 1, y: view.h / 3, w: 2, h: 2 };
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
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
    const raw = runs.list();
    // how the stickies of a group proposal looked when it arrived here, and the reviews of runs that are gone
    for (const r of raw) {
      if (r.status === 'ready' && r.proposal?.kind === 'group' && !live.seen.has(r.id)) {
        const ids = r.proposal.groups.flatMap((g) => g.ids);
        live.seen.set(r.id, new Map(ids.map((id) => [id, fingerprintOf(app.store.get(id) as { x?: number; y?: number; w?: number; h?: number; text?: string; parent?: string; type?: string; locked?: boolean } | undefined)])));
      }
    }
    const open = new Set(raw.map((r) => r.id));
    for (const id of [...live.reviews.keys(), ...live.seen.keys()]) {
      if (open.has(id)) continue;
      live.reviews.delete(id);
      live.seen.delete(id);
    }
    for (const [id, review] of live.reviews) {
      const next = refreshStale(review, staleIn(live, app, id));
      if (next !== review) live.reviews.set(id, next);
    }
    const list = shownRuns(live, app);
    const me = meId();
    live.layouts = previewLayouts(list, boardOf(app));
    mine = new Set(list.filter((r) => isMine(r, me, live.ownRunId, live.starting)).map((r) => r.id));
    ready = stacked(list.filter((r) => live.layouts.has(r.id) || r.changed), (r) => mine.has(r.id));
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
    for (const fn of live.listeners) {
      try {
        fn();
      } catch {
        /* a failing listener must not stop the drawing */
      }
    }
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
