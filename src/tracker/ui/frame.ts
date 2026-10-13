import './tracker.css';
import { registerTrackerRenderer } from '../../tracker-frame';
import type { TrackerApi, TrackerStore } from '../../tracker-data';
import type { BaseObj } from '../../types';
import type { BoardApp } from '../../app';
import { h } from '../../ui/dom';
import { clearTrackerSnapshots, renderTrackerSnapshot } from './frame-snapshot';
import { mountTrackerShell, type TrackerShellController } from './shell';
import type { TrackerView } from '../../tracker-types';
import { navigateTrackerPath, onTrackerRoute } from '../../route';
import { buildTrackerPath, type TrackerPathRoute } from '../../tracker-route';
import { focusCanvas } from '../../ui/canvas-focus';
import { onAuth } from '../../auth';

registerTrackerRenderer(renderTrackerSnapshot);

/** A frame is live (its interior is the real tracker) at this zoom or above ... */
export const LIVE_MIN_ZOOM = 0.4;
/** ... and when it is at least this tall on screen. */
export const LIVE_MIN_SCREEN_HEIGHT = 240;
/** At most this many frames are live at once; the others are snapshots. */
export const LIVE_CAP = 3;
/** A live shell that has been out of the live set this long is destroyed. Its viewer state survives on the store. */
export const LIVE_HOLD_MS = 500;

export type TrackerPresentation = 'snapshot' | 'work';
export interface ScreenRect { x: number; y: number; w: number; h: number }
export interface LiveCandidate { id: string; rect: ScreenRect; eligible: boolean; selected: boolean; hovered: boolean }
export interface WheelState { modified: boolean; deltaY: number; scrollTop: number; scrollHeight: number; clientHeight: number }

/** Live ('work') by zoom and on-screen height, never on a phone. Focus and selection do not decide it. */
export function trackerPresentation(zoom: number, screenWidth: number, screenHeight: number, phone = false): TrackerPresentation {
  return !phone && zoom >= LIVE_MIN_ZOOM && screenHeight >= LIVE_MIN_SCREEN_HEIGHT ? 'work' : 'snapshot';
}

function visibleArea(rect: ScreenRect, viewport: ScreenRect): number {
  const w = Math.min(rect.x + rect.w, viewport.x + viewport.w) - Math.max(rect.x, viewport.x);
  const h = Math.min(rect.y + rect.h, viewport.y + viewport.h) - Math.max(rect.y, viewport.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The frames that are live: the eligible ones on screen, ranked selected first, then hovered, then by the largest visible area
 * (the element's rectangle intersected with the viewport), and at most `cap` of them. Ties go to the lower id, so the answer is stable.
 */
export function pickLive(frames: readonly LiveCandidate[], viewport: ScreenRect, cap: number): Set<string> {
  const ranked = frames
    .filter((frame) => frame.eligible)
    .map((frame) => ({ id: frame.id, selected: frame.selected, hovered: frame.hovered, area: visibleArea(frame.rect, viewport) }))
    .filter((frame) => frame.area > 0)
    .sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.hovered) - Number(a.hovered) || b.area - a.area
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(ranked.slice(0, Math.max(0, Math.floor(cap))).map((frame) => frame.id));
}

/** The hold rule for a frame's shell: `leftAt` is when it last left the live set (null while live). Destroy after LIVE_HOLD_MS. */
export function holdAfter(leftAt: number | null, live: boolean, now: number): { leftAt: number | null; destroy: boolean } {
  if (live) return { leftAt: null, destroy: false };
  const since = leftAt ?? now;
  return { leftAt: since, destroy: now - since >= LIVE_HOLD_MS };
}

export function wheelDisposition(state: WheelState): 'zoom' | 'list' | 'pan' {
  if (state.modified) return 'zoom';
  const canScrollUp = state.deltaY < 0 && state.scrollTop > 0;
  const canScrollDown = state.deltaY > 0 && state.scrollTop + state.clientHeight < state.scrollHeight - 1;
  return canScrollUp || canScrollDown ? 'list' : 'pan';
}

interface TrackerFrameUiOptions {
  app: BoardApp;
  store: TrackerStore;
  api: TrackerApi;
  viewerId: string;
  initialTrackerId?: string;
  initialTicketKey?: string;
}

interface FrameMount {
  obj: BaseObj;
  wrapper: HTMLElement;
  workHost: HTMLElement;
  open: HTMLButtonElement;
  /** Whether the last refresh put this frame in the live set. Only a live frame shows its shell. */
  live: boolean;
  /** When the frame left the live set while its shell was up; null while live or without a shell. */
  leftAt: number | null;
  /** The width the shell was last laid out at, so a pan or zoom does not re-lay it out. */
  layoutWidth: number;
  shell: TrackerShellController | null;
  drag: { pointerId: number; x: number; y: number; camX: number; camY: number } | null;
  pinchPoints: Map<number, { x: number; y: number }>;
  pinch: { distance: number; midpoint: { x: number; y: number } } | null;
}

function isTracker(obj: BaseObj): boolean {
  return obj.type === 'tracker' && typeof obj.trackerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.trackerId);
}

function isPhone(): boolean { return typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches; }

function routeForShell(shell: TrackerShellController): TrackerPathRoute {
  if (shell.state.ticketKey) return { kind: 'ticket', key: shell.state.ticketKey };
  if (shell.state.viewId) return shell.state.tab === 'projects'
    ? { kind: 'view', view: 'projects', id: shell.state.viewId }
    : { kind: 'view', view: 'views', id: shell.state.viewId };
  return { kind: 'view', view: shell.state.tab };
}

/** Mounts a live DOM surface over selected tracker frames; board paint always remains the static SVG snapshot. */
export function mountTrackerFrames(options: TrackerFrameUiOptions): () => void {
  const { app, store } = options;
  const overlay = h('div', { class: 'trk-frame-overlay', 'aria-label': 'Tracker frames' });
  app.r.root.appendChild(overlay);
  const frames = new Map<string, FrameMount>();

  const selected = (id: string) => app.selection.includes(id);
  const lookup = (id: string) => app.store.get(id) as BaseObj | undefined;
  const viewport = (): ScreenRect => ({ x: 0, y: 0, ...app.r.size() });
  let holdTimer = 0;

  const openFullscreenRoute = (mount: FrameMount) => {
    app.setSelection([mount.obj.id]);
    if (!mount.shell) makeShell(mount);
    if (mount.shell) navigateTrackerPath(routeForShell(mount.shell));
  };

  const onFullscreenChange = (mount: FrameMount, value: boolean) => {
    if (!value || !mount.shell) return;
    const target = routeForShell(mount.shell);
    // The frame's embedded shell stays in frame mode while the route host takes over the viewport.
    mount.shell.setFullscreen(false);
    navigateTrackerPath(target);
  };

  /** Escape at the top of the element: focus goes back to the canvas and the frame stays selected. */
  const leaveToCanvas = () => { focusCanvas(); };

  const makeShell = (mount: FrameMount) => {
    if (mount.shell) return;
    const obj = lookup(mount.obj.id) ?? mount.obj;
    mount.layoutWidth = obj.w;
    mount.shell = mountTrackerShell(mount.workHost, {
      store, api: options.api, viewerId: options.viewerId, trackerId: String(obj.trackerId),
      windowId: obj.id,
      element: true,
      onOpenFullScreen: () => openFullscreenRoute(mount),
      elementLink: () => {
        const path = mount.shell ? buildTrackerPath(routeForShell(mount.shell)) : null;
        return path ? `${location.origin}${path}` : null;
      },
      initialTab: typeof obj.view === 'string' ? obj.view as TrackerView : 'all',
      initialViewId: typeof obj.viewId === 'string' ? obj.viewId : undefined,
      initialTicketKey: mount.obj.trackerId === options.initialTrackerId ? options.initialTicketKey ?? obj.focusKey : obj.focusKey,
      boardName: app.store.getMeta().name, layoutWidth: obj.w,
      // a person who can only view this board only views its tracker too (read again at every refresh, so it follows a role change)
      get readOnly() { return app.readOnly; },
      onFullscreenChange: (value) => onFullscreenChange(mount, value),
      onSnapshot: () => app.r.invalidateAll(),
      onWorkExit: leaveToCanvas,
    });
    reposition(mount);
  };

  const destroyShell = (mount: FrameMount) => {
    if (!mount.shell) return;
    // a focused shell takes its focus with it: hand it to the canvas first
    if (mount.shell.el.contains(document.activeElement)) focusCanvas();
    mount.shell.destroy();
    mount.shell = null;
    mount.leftAt = null;
  };

  /** Enter and double-click: a live element takes focus; the phone opens the full-screen route. */
  const enterWork = (mount: FrameMount) => {
    if (isPhone()) { openFullscreenRoute(mount); return; }
    app.setSelection([mount.obj.id]);
    refresh();
    if (mount.live && mount.shell) mount.shell.focus();
  };

  function reposition(mount: FrameMount) {
    const obj = lookup(mount.obj.id);
    if (!obj || !isTracker(obj)) return;
    mount.obj = obj;
    const screen = app.r.toScreen({ x: obj.x, y: obj.y });
    const zoom = app.zoom;
    const width = Math.max(0, obj.w * zoom);
    const height = Math.max(0, obj.h * zoom);
    const live = mount.live && trackerPresentation(zoom, width, height, isPhone()) === 'work';
    mount.wrapper.style.left = `${screen.x}px`;
    mount.wrapper.style.top = `${screen.y}px`;
    mount.wrapper.style.width = `${width}px`;
    mount.wrapper.style.height = `${height}px`;
    mount.wrapper.classList.toggle('is-work', live);
    mount.wrapper.classList.toggle('is-selected', selected(obj.id));
    const hovered = mount.wrapper.dataset.hovered === 'true';
    // the Open chip is the phone's gateway to the full-screen route; on the desktop the element is live where it is
    mount.open.hidden = !(isPhone() && (selected(obj.id) || hovered));
    if (mount.shell) {
      const shell = mount.shell.el;
      shell.hidden = !live;
      if (!live && shell.contains(document.activeElement)) focusCanvas();
      shell.style.width = `${obj.w}px`;
      shell.style.height = `${obj.h}px`;
      const uiScale = zoom;
      shell.style.transformOrigin = 'top left';
      shell.style.transform = `scale(${uiScale})`;
      shell.style.fontSize = `${Math.max(14, 9 / Math.max(zoom, 0.01))}px`;
      if (obj.w !== mount.layoutWidth) {
        mount.layoutWidth = obj.w;
        mount.shell.updateLayout(obj.w);
      }
    }
  };

  /**
   * The live set: at most LIVE_CAP eligible frames on screen (pickLive). A frame that enters it gets its shell made now; one that
   * leaves it is hidden at once (its snapshot shows) and destroyed after LIVE_HOLD_MS out of the set.
   */
  function refresh() {
    if (frames.size === 0) return;
    const now = Date.now();
    const zoom = app.zoom;
    const phone = isPhone();
    const candidates: LiveCandidate[] = [];
    for (const mount of frames.values()) {
      const obj = lookup(mount.obj.id);
      if (!obj || !isTracker(obj)) continue;
      const screen = app.r.toScreen({ x: obj.x, y: obj.y });
      const rect = { x: screen.x, y: screen.y, w: Math.max(0, obj.w * zoom), h: Math.max(0, obj.h * zoom) };
      candidates.push({
        id: obj.id, rect, eligible: trackerPresentation(zoom, rect.w, rect.h, phone) === 'work',
        selected: selected(obj.id), hovered: mount.wrapper.dataset.hovered === 'true',
      });
    }
    const picked = pickLive(candidates, viewport(), LIVE_CAP);
    let waiting = false;
    for (const mount of frames.values()) {
      mount.live = picked.has(mount.obj.id);
      if (mount.live) {
        mount.leftAt = null;
        makeShell(mount);
      } else if (mount.shell) {
        const hold = holdAfter(mount.leftAt, false, now);
        mount.leftAt = hold.leftAt;
        if (hold.destroy) destroyShell(mount);
        else waiting = true;
      }
      reposition(mount);
    }
    if (waiting && holdTimer === 0) {
      holdTimer = window.setTimeout(() => { holdTimer = 0; refresh(); }, LIVE_HOLD_MS);
    }
  }

  const createFrameMount = (obj: BaseObj): FrameMount => {
    const wrapper = h('div', { class: 'trk-frame-wrap' });
    const workHost = h('div', { class: 'trk-frame-work-host' });
    // phone only: the chip opens the full-screen route (on the desktop the element is live in place)
    const open = h('button', { class: 'trk-frame-open', type: 'button', 'aria-label': 'Open tracker', onclick: () => openFullscreenRoute(mount) }, 'Open');
    const mount: FrameMount = {
      obj, wrapper, workHost, open, live: false, leftAt: null, layoutWidth: obj.w, shell: null,
      drag: null, pinchPoints: new Map(), pinch: null,
    };
    wrapper.append(workHost, open);
    overlay.appendChild(wrapper);
    wrapper.addEventListener('pointerenter', () => { wrapper.dataset.hovered = 'true'; refresh(); });
    wrapper.addEventListener('pointerleave', () => { wrapper.dataset.hovered = 'false'; refresh(); });
    wrapper.addEventListener('wheel', (event) => {
      const modified = event.ctrlKey || event.metaKey;
      const scrollArea = (event.target as HTMLElement | null)?.closest<HTMLElement>('.trk-list-host, .trk-filter-host, .trk-ticket-stub');
      const disposition = wheelDisposition({
        modified, deltaY: event.deltaY, scrollTop: scrollArea?.scrollTop ?? 0,
        scrollHeight: scrollArea?.scrollHeight ?? 0, clientHeight: scrollArea?.clientHeight ?? 0,
      });
      if (disposition === 'list') return;
      event.preventDefault();
      if (disposition === 'zoom') {
        const bounds = app.r.root.getBoundingClientRect();
        app.r.zoomAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, Math.exp(-event.deltaY * 0.001));
      } else app.r.setCamera({ x: app.r.cam.x + event.deltaX / app.zoom, y: app.r.cam.y + event.deltaY / app.zoom });
    }, { passive: false });
    wrapper.addEventListener('pointerdown', (event) => {
      if (!mount.live || !mount.shell) return;
      const target = event.target as HTMLElement;
      if (target.closest('.trk-frame-open')) return;
      if (event.pointerType !== 'touch') {
        // a click inside the live element is a click on the element: it is selected and its tracker has the keys
        app.setSelection([mount.obj.id]);
        mount.shell.focus();
      }
      if (event.pointerType === 'touch') {
        mount.pinchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (mount.pinchPoints.size === 2) {
          const [a, b] = [...mount.pinchPoints.values()];
          mount.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          mount.drag = null;
        }
        return;
      }
      if (target.closest('button,input,textarea,select,[role="row"],[role="tab"],.trk-filter-bar,.trk-view-bar')) return;
      mount.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camX: app.r.cam.x, camY: app.r.cam.y };
      wrapper.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    wrapper.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch' && mount.pinchPoints.has(event.pointerId)) {
        mount.pinchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (mount.pinch && mount.pinchPoints.size === 2) {
          const [a, b] = [...mount.pinchPoints.values()];
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const bounds = app.r.root.getBoundingClientRect();
          app.r.setCamera({ x: app.r.cam.x - (midpoint.x - mount.pinch.midpoint.x) / app.zoom, y: app.r.cam.y - (midpoint.y - mount.pinch.midpoint.y) / app.zoom });
          app.r.zoomAt({ x: midpoint.x - bounds.left, y: midpoint.y - bounds.top }, distance / mount.pinch.distance);
          mount.pinch = { distance, midpoint };
        }
        return;
      }
      if (!mount.drag || mount.drag.pointerId !== event.pointerId) return;
      app.r.setCamera({ x: mount.drag.camX - (event.clientX - mount.drag.x) / app.zoom, y: mount.drag.camY - (event.clientY - mount.drag.y) / app.zoom });
    });
    const stopPan = (event: PointerEvent) => {
      if (mount.drag?.pointerId === event.pointerId) mount.drag = null;
      mount.pinchPoints.delete(event.pointerId);
      if (mount.pinchPoints.size < 2) mount.pinch = null;
    };
    wrapper.addEventListener('pointerup', stopPan);
    wrapper.addEventListener('pointercancel', stopPan);
    return mount;
  };

  const syncFrames = () => {
    const objects = [...app.store.cache.values()].map((obj) => obj as BaseObj).filter(isTracker);
    const ids = new Set(objects.map((obj) => obj.id));
    for (const [id, mount] of frames) {
      if (ids.has(id)) continue;
      mount.shell?.destroy(); mount.wrapper.remove(); frames.delete(id);
    }
    for (const obj of objects) {
      let mount = frames.get(obj.id);
      if (!mount) { mount = createFrameMount(obj); frames.set(obj.id, mount); }
    }
    refresh();
  };

  const onDoubleClick = (event: MouseEvent) => {
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    const hit = [...frames.values()].find(({ obj }) => point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
    if (!hit) return;
    event.preventDefault(); event.stopImmediatePropagation();
    enterWork(hit);
  };

  const hoveredFrame = (event: PointerEvent) => {
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    let changed = false;
    for (const mount of frames.values()) {
      const obj = lookup(mount.obj.id);
      const hovering = Boolean(obj && point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
      if ((mount.wrapper.dataset.hovered === 'true') !== hovering) {
        mount.wrapper.dataset.hovered = String(hovering);
        changed = true;
      }
    }
    // hover is a ranking input: a hovered snapshot can take a live place
    if (changed) refresh();
  };
  const openPhoneFrame = (event: MouseEvent) => {
    if (!isPhone()) return;
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    const mount = [...frames.values()].find(({ obj }) => point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
    if (!mount) return;
    enterWork(mount);
  };

  const onCanvasKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('.trk')) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const id = app.selection.length === 1 ? app.selection[0] : '';
    const mount = frames.get(id);
    if (!mount) return;
    if (event.key === 'Enter') { event.preventDefault(); enterWork(mount); }
    else if (event.key.toLowerCase() === 'f') {
      event.preventDefault(); openFullscreenRoute(mount);
    }
  };

  const stopTrackerRoute = onTrackerRoute(async (target) => {
    if (target.kind !== 'board-position' || target.boardId !== app.conn.id) return;
    const mount = [...frames.values()].find((frame) => frame.obj.trackerId === target.trackerId);
    const obj = mount && (lookup(mount.obj.id) ?? mount.obj);
    if (!mount || !obj || !isTracker(obj)) return;
    mount.obj = obj;
    app.setSelection([obj.id]);
    const size = app.r.size();
    // at least the live height, so the element the link opens is live where the camera puts it
    const zoom = Math.min(1, Math.max(0.45, app.zoom, (LIVE_MIN_SCREEN_HEIGHT + 1) / obj.h));
    app.r.setCamera({
      zoom,
      x: obj.x + obj.w / 2 - size.w / (2 * zoom),
      y: obj.y + obj.h / 2 - size.h / (2 * zoom),
    });
    refresh();
    makeShell(mount);
    if (!target.key) return;
    mount.shell?.setTicket(target.key);
    try {
      const detail = await store.loadTicket(target.key, true);
      return { resolvedKey: detail.resolvedKey ?? detail.ticket.key };
    } catch {
      return;
    }
  });

  const offCamera = app.r.onCamera(refresh);
  const offSelection = app.on('selection', refresh);
  const offObjects = app.on('objects', syncFrames);
  const offReadOnly = app.store.onReadOnly(refresh);
  // a snapshot is what an element last showed: it goes when the person signs out or loses access to the tracker
  const offStore = store.subscribe((snapshot) => {
    const lost = (error?: { code: string }) => error?.code === 'forbidden' || error?.code === 'not_found';
    if (lost(snapshot.metaError) || Object.values(snapshot.lists).some((list) => lost(list.error))) clearTrackerSnapshots();
  });
  const offAuth = onAuth((state) => { if (state.mode !== 'signed-in') clearTrackerSnapshots(); });
  const onDoubleBound = onDoubleClick as EventListener;
  app.r.svg.addEventListener('dblclick', onDoubleBound, true);
  app.r.svg.addEventListener('pointermove', hoveredFrame, true);
  app.r.svg.addEventListener('click', openPhoneFrame, true);
  document.addEventListener('keydown', onCanvasKey, true);
  const onResize = refresh;
  window.addEventListener('resize', onResize);
  syncFrames();

  return () => {
    offCamera(); offSelection(); offObjects(); offReadOnly(); offStore(); offAuth();
    window.clearTimeout(holdTimer);
    stopTrackerRoute();
    app.r.svg.removeEventListener('dblclick', onDoubleBound, true);
    app.r.svg.removeEventListener('pointermove', hoveredFrame, true);
    app.r.svg.removeEventListener('click', openPhoneFrame, true);
    document.removeEventListener('keydown', onCanvasKey, true);
    window.removeEventListener('resize', onResize);
    for (const mount of frames.values()) { destroyShell(mount); mount.wrapper.remove(); }
    frames.clear(); overlay.remove();
  };
}
