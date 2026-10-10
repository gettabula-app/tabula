import './tracker.css';
import { registerTrackerRenderer } from '../../tracker-frame';
import type { TrackerStore } from '../../tracker-data';
import type { BaseObj } from '../../types';
import type { BoardApp } from '../../app';
import { h } from '../../ui/dom';
import { renderTrackerSnapshot } from './frame-snapshot';
import { mountTrackerShell, type TrackerShellController } from './shell';
import type { TrackerView } from '../../tracker-types';
import { parseRoute } from '../../route';

registerTrackerRenderer(renderTrackerSnapshot);

export type TrackerPresentation = 'snapshot' | 'work';
export interface WheelState { modified: boolean; deltaY: number; scrollTop: number; scrollHeight: number; clientHeight: number }

export function trackerPresentation(zoom: number, screenWidth: number, focused: boolean, phone = false): TrackerPresentation {
  return !phone && focused && zoom >= 0.4 && screenWidth >= 560 ? 'work' : 'snapshot';
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
  viewerId: string;
  initialTrackerId?: string;
  initialTicketKey?: string;
}

interface FrameMount {
  obj: BaseObj;
  wrapper: HTMLElement;
  workHost: HTMLElement;
  open: HTMLButtonElement;
  expand: HTMLButtonElement;
  requestedWork: boolean;
  shell: TrackerShellController | null;
  portal: HTMLElement | null;
  portalOpen: boolean;
  restoringFromPop: boolean;
  suppressHashChange: boolean;
  drag: { pointerId: number; x: number; y: number; camX: number; camY: number } | null;
  pinchPoints: Map<number, { x: number; y: number }>;
  pinch: { distance: number; midpoint: { x: number; y: number } } | null;
  historyCleanup?: () => void;
}

function isTracker(obj: BaseObj): boolean {
  return obj.type === 'tracker' && typeof obj.trackerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.trackerId);
}

function isPhone(): boolean { return typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches; }
function ticketRoute(key: string | null): string { return key ? `#/t/${encodeURIComponent(key)}` : '#/t/all'; }
function tabRoute(tab: TrackerView): string { return `#/t/${tab}`; }

/** Mounts a live DOM surface over selected tracker frames; board paint always remains the static SVG snapshot. */
export function mountTrackerFrames(options: TrackerFrameUiOptions): () => void {
  const { app, store } = options;
  const overlay = h('div', { class: 'trk-frame-overlay', 'aria-label': 'Tracker frames' });
  app.r.root.appendChild(overlay);
  const frames = new Map<string, FrameMount>();

  const selected = (id: string) => app.selection.includes(id);
  const lookup = (id: string) => app.store.get(id) as BaseObj | undefined;

  const closePortal = (mount: FrameMount, fromHistory: boolean) => {
    if (!mount.portalOpen) return;
    mount.portalOpen = false;
    mount.portal?.remove();
    mount.portal = null;
    mount.workHost.appendChild(mount.shell!.el);
    mount.shell!.setFullscreen(false);
    mount.shell!.focus();
    reposition(mount);
    if (fromHistory) mount.suppressHashChange = true;
  };

  const openPortal = (mount: FrameMount, route: string, push: boolean) => {
    if (!mount.shell) makeShell(mount);
    if (!mount.portalOpen) {
      mount.portal = h('div', { class: 'trk-fullscreen-portal' });
      document.body.appendChild(mount.portal);
      mount.portal.appendChild(mount.shell!.el);
      mount.portalOpen = true;
      mount.restoringFromPop = true;
      mount.shell!.setFullscreen(true);
      mount.restoringFromPop = false;
    }
    const ticketRouteActive = /^#\/t\/[A-Z]{2,5}-[1-9]\d*$/i.test(route);
    if (push) history.pushState({ trackerFullscreen: true, trackerTicket: ticketRouteActive, trackerId: mount.obj.trackerId }, '', route);
    else history.replaceState({ ...history.state, trackerFullscreen: true, trackerTicket: ticketRouteActive, trackerId: mount.obj.trackerId }, '', route);
    mount.shell!.focus();
  };

  const updateRouteForTab = (mount: FrameMount, tab: TrackerView) => {
    if (mount.portalOpen && !mount.restoringFromPop) history.replaceState({ ...history.state, trackerFullscreen: true, trackerTicket: false, trackerId: mount.obj.trackerId }, '', tabRoute(tab));
  };

  const onTicketChange = (mount: FrameMount, key: string | null) => {
    if (mount.restoringFromPop) return;
    if (key) openPortal(mount, ticketRoute(key), true);
    else if (mount.portalOpen && history.state?.trackerTicket) history.back();
  };

  const onFullscreenChange = (mount: FrameMount, value: boolean) => {
    if (mount.restoringFromPop) return;
    if (value) {
      openPortal(mount, tabRoute(mount.shell?.state.tab ?? 'all'), true);
    } else if (mount.portalOpen && !mount.restoringFromPop) {
      history.back();
    }
  };

  const makeShell = (mount: FrameMount) => {
    if (mount.shell) return;
    const obj = lookup(mount.obj.id) ?? mount.obj;
    mount.shell = mountTrackerShell(mount.workHost, {
      store, viewerId: options.viewerId, trackerId: String(obj.trackerId),
      windowId: obj.id,
      initialTab: typeof obj.view === 'string' ? obj.view as TrackerView : 'inbox',
      initialViewId: typeof obj.viewId === 'string' ? obj.viewId : undefined,
      initialTicketKey: mount.obj.trackerId === options.initialTrackerId ? options.initialTicketKey ?? obj.focusKey : obj.focusKey,
      boardName: app.store.getMeta().name, layoutWidth: obj.w,
      onFullscreenChange: (value) => onFullscreenChange(mount, value),
      onTicketChange: (key) => onTicketChange(mount, key),
      onTabChange: (tab) => updateRouteForTab(mount, tab),
      onSnapshot: () => app.r.invalidateAll(),
      onWorkExit: () => { mount.requestedWork = false; reposition(mount); },
      active: () => mount.requestedWork || mount.portalOpen,
    });
  };

  const enterWork = (mount: FrameMount) => {
    if (isPhone()) { openPortal(mount, tabRoute(mount.shell?.state.tab ?? 'inbox'), true); return; }
    mount.requestedWork = true;
    app.setSelection([mount.obj.id]);
    makeShell(mount);
    reposition(mount);
    mount.shell?.focus();
  };

  function reposition(mount: FrameMount) {
    const obj = lookup(mount.obj.id);
    if (!obj || !isTracker(obj)) return;
    mount.obj = obj;
    const screen = app.r.toScreen({ x: obj.x, y: obj.y });
    const zoom = app.zoom;
    const width = Math.max(0, obj.w * zoom);
    const height = Math.max(0, obj.h * zoom);
    const focused = selected(obj.id) && mount.requestedWork;
    const presentation = trackerPresentation(zoom, width, focused, isPhone());
    mount.wrapper.style.left = `${screen.x}px`;
    mount.wrapper.style.top = `${screen.y}px`;
    mount.wrapper.style.width = `${width}px`;
    mount.wrapper.style.height = `${height}px`;
    mount.wrapper.classList.toggle('is-work', presentation === 'work' && !mount.portalOpen);
    mount.wrapper.classList.toggle('is-selected', selected(obj.id));
    mount.open.hidden = !(selected(obj.id) || mount.wrapper.dataset.hovered === 'true') || mount.portalOpen;
    mount.expand.hidden = !(mount.portalOpen || selected(obj.id) || mount.wrapper.dataset.hovered === 'true' || presentation === 'work');
    if (mount.shell) {
      const shell = mount.shell.el;
      shell.hidden = mount.portalOpen ? false : presentation !== 'work';
      shell.style.width = `${obj.w}px`;
      shell.style.height = `${obj.h}px`;
      const uiScale = zoom;
      shell.style.transformOrigin = 'top left';
      shell.style.transform = `scale(${uiScale})`;
      shell.style.fontSize = `${Math.max(14, 9 / Math.max(zoom, 0.01))}px`;
      mount.shell.updateLayout(obj.w);
    }
    if (mount.portalOpen && mount.portal && mount.shell) {
      mount.portal.style.setProperty('--trk-frame-height', `${window.innerHeight}px`);
      mount.shell.el.style.width = `${window.innerWidth}px`;
      mount.shell.el.style.height = `${window.innerHeight}px`;
      mount.shell.el.style.transform = 'none';
      mount.shell.updateLayout(window.innerWidth);
    }
  }

  const onPopState = (event: PopStateEvent, mount: FrameMount) => {
    if (!mount.portalOpen) return;
    event.stopImmediatePropagation();
    mount.restoringFromPop = true;
    if (event.state?.trackerFullscreen) {
      const route = parseRoute(location.hash);
      if (event.state.trackerTicket && route.name === 'tracker' && route.ticketKey) mount.shell?.setTicket(route.ticketKey);
      else if (mount.shell?.state.ticketKey) mount.shell.setTicket(null);
    } else {
      if (mount.shell?.state.ticketKey) mount.shell.setTicket(null);
      closePortal(mount, true);
      mount.requestedWork = false;
    }
    mount.restoringFromPop = false;
    reposition(mount);
  };

  const onHashChange = (event: HashChangeEvent, mount: FrameMount) => {
    if (!mount.suppressHashChange) return;
    event.stopImmediatePropagation();
    mount.suppressHashChange = false;
  };

  const createFrameMount = (obj: BaseObj): FrameMount => {
    const wrapper = h('div', { class: 'trk-frame-wrap' });
    const workHost = h('div', { class: 'trk-frame-work-host' });
    const open = h('button', { class: 'trk-frame-open', type: 'button', 'aria-label': 'Open tracker', onclick: () => enterWork(mount) }, 'Open');
    const expand = h('button', { class: 'trk-frame-expand', type: 'button', 'aria-label': 'Open full screen', onclick: () => {
      makeShell(mount);
      openPortal(mount, tabRoute(mount.shell!.state.tab), true);
    } }, 'Open full screen');
    const mount: FrameMount = {
      obj, wrapper, workHost, open, expand, requestedWork: false, shell: null, portal: null, portalOpen: false,
      restoringFromPop: false, suppressHashChange: false, drag: null, pinchPoints: new Map(), pinch: null,
    };
    wrapper.append(workHost, open, expand);
    overlay.appendChild(wrapper);
    wrapper.addEventListener('pointerenter', () => { wrapper.dataset.hovered = 'true'; reposition(mount); });
    wrapper.addEventListener('pointerleave', () => { wrapper.dataset.hovered = 'false'; reposition(mount); });
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
      if (!mount.requestedWork || mount.portalOpen) return;
      if (event.pointerType === 'touch') {
        mount.pinchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (mount.pinchPoints.size === 2) {
          const [a, b] = [...mount.pinchPoints.values()];
          mount.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          mount.drag = null;
        }
        return;
      }
      const target = event.target as HTMLElement;
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
    const pop = (event: PopStateEvent) => onPopState(event, mount);
    const hash = (event: HashChangeEvent) => onHashChange(event, mount);
    window.addEventListener('popstate', pop, true);
    window.addEventListener('hashchange', hash, true);
    mount.historyCleanup = () => { window.removeEventListener('popstate', pop, true); window.removeEventListener('hashchange', hash, true); };
    return mount;
  };

  const syncFrames = () => {
    const objects = [...app.store.cache.values()].map((obj) => obj as BaseObj).filter(isTracker);
    const ids = new Set(objects.map((obj) => obj.id));
    for (const [id, mount] of frames) {
      if (ids.has(id)) continue;
      mount.shell?.destroy(); mount.portal?.remove(); mount.wrapper.remove(); mount.historyCleanup?.(); frames.delete(id);
    }
    for (const obj of objects) {
      let mount = frames.get(obj.id);
      if (!mount) { mount = createFrameMount(obj); frames.set(obj.id, mount); }
      reposition(mount);
      if (obj.trackerId === options.initialTrackerId && !mount.requestedWork && options.initialTicketKey) {
        mount.requestedWork = true;
        makeShell(mount);
        if (isPhone()) openPortal(mount, ticketRoute(options.initialTicketKey), true);
        else reposition(mount);
      }
    }
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
    for (const mount of frames.values()) {
      const obj = lookup(mount.obj.id);
      const hovering = Boolean(obj && point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
      if ((mount.wrapper.dataset.hovered === 'true') !== hovering) {
        mount.wrapper.dataset.hovered = String(hovering);
        reposition(mount);
      }
    }
  };
  const openPhoneFrame = (event: MouseEvent) => {
    if (!isPhone()) return;
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    const mount = [...frames.values()].find(({ obj }) => point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
    if (!mount) return;
    makeShell(mount);
    openPortal(mount, tabRoute(mount.shell!.state.tab), true);
  };

  const onCanvasKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('.trk')) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const id = app.selection.length === 1 ? app.selection[0] : '';
    const mount = frames.get(id);
    if (!mount) return;
    if (event.key === 'Enter') { event.preventDefault(); enterWork(mount); }
    else if (event.key.toLowerCase() === 'f') {
      event.preventDefault(); makeShell(mount); openPortal(mount, tabRoute(mount.shell!.state.tab), true);
    }
  };

  const offCamera = app.r.onCamera(() => frames.forEach(reposition));
  const offSelection = app.on('selection', () => frames.forEach(reposition));
  const offObjects = app.on('objects', syncFrames);
  const onDoubleBound = onDoubleClick as EventListener;
  app.r.svg.addEventListener('dblclick', onDoubleBound, true);
  app.r.svg.addEventListener('pointermove', hoveredFrame, true);
  app.r.svg.addEventListener('click', openPhoneFrame, true);
  document.addEventListener('keydown', onCanvasKey, true);
  const onResize = () => frames.forEach(reposition);
  window.addEventListener('resize', onResize);
  syncFrames();

  if (options.initialTrackerId) {
    const matching = [...frames.values()].find(({ obj }) => obj.trackerId === options.initialTrackerId);
    if (matching && options.initialTicketKey) {
      const frame = matching.obj;
      const screen = app.r.size();
      const zoom = Math.min(1, screen.w / frame.w, screen.h / frame.h);
      app.r.setCamera({ zoom, x: frame.x + frame.w / 2 - screen.w / (2 * zoom), y: frame.y + frame.h / 2 - screen.h / (2 * zoom) });
    }
  }

  return () => {
    offCamera(); offSelection(); offObjects();
    app.r.svg.removeEventListener('dblclick', onDoubleBound, true);
    app.r.svg.removeEventListener('pointermove', hoveredFrame, true);
    app.r.svg.removeEventListener('click', openPhoneFrame, true);
    document.removeEventListener('keydown', onCanvasKey, true);
    window.removeEventListener('resize', onResize);
    for (const mount of frames.values()) { mount.shell?.destroy(); mount.portal?.remove(); mount.wrapper.remove(); mount.historyCleanup?.(); }
    frames.clear(); overlay.remove();
  };
}
