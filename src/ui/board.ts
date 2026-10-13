import { openContextMenu } from './context-menu';
import { openCardDialog } from './card-dialog';
import { openLabelsDialog } from './labels-dialog';
import { openKanbanMenu } from './kanban-menus';
import { closeContainerSheet, openContainerSheet } from './container-sheet';
import { addImages, pickImages } from './image-add';
import { openLinkPopover } from './link-add';
import type { BoardApp, Tool } from '../app';
import type { GridType } from '../types';
import { isBox } from '../types';
import { createTrackerFrame, setTrackerGuest, setTrackerMember, TRACKER_FRAME_DEFAULT_SIZE } from '../tracker-frame';
import { createTrackerStore, createHttpTrackerApi, type TrackerApi, type TrackerStore } from '../tracker-data';
import { openRegisteredLinkDialog, openRegisteredUnlinkConfirm } from '../tracker/ui/link-seam';
import { installTrackerLinkDialog } from '../tracker/ui/link-dialog-open';
import { installTrackerUnlinkConfirm } from '../tracker/ui/unlink-confirm';
import { mountTrackerFrames } from '../tracker/ui/frame';
import { h, icon, ICONS } from './dom';
import { announce } from './announce';
import { leaveOutWithheld } from '../private-select';
import { openChatNotifications } from './chat-prefs';
import { dialog, field, popover, segmented, toast } from './common';
import { mountProps } from './props';
import { mountQuickbar } from './quickbar';
import { mountEditBar } from './edit-bar';
import { mountGroupUI } from './group-ui';
import { mountTouchMenu } from './touch-menu';
import { mountLibrary, openMermaidImport } from './library';
import { bindLayersKey } from './layers';
import { mountFlowBar, openVoteSetup, startVote } from './flowbar';
import { mountFocus, mutedCount, openMuted } from './focus';
import { openQuickPoll } from './polls';
import { mountComments } from './comments';
import { mountChat } from './board-chat';
import { currentChatDock } from './chat-dock';
import { mountCanvasFocus } from './canvas-focus';
import { mountSideTray } from './side-tray';
import { mountHistory } from './history';
import { canSeeHistory } from '../history';
import { openFontPicker } from './fontpicker';
import { openPrint } from './print';
import { csvKanbans, download, downloadCardsCsv, exportPng, exportSvgFile, insertImported, readBoardFile, safeName, toDrift, toJson } from '../exporters';
import { toMermaid } from '../mermaid';

const trackerBoardMockVisual = import.meta.env.MODE === 'visual' && (() => {
  const query = new URLSearchParams(location.search);
  return query.has('debug') && query.get('trackerMock') === 'board';
})();
import { fontName } from '../fonts';
import { getRelaySetting, relayUrl, saveUser, setRelaySetting } from '../sync';
import { isDesktop } from '../desktop-env';
import { api } from '../api';
import { authState, chatAvailable, imagesAvailable, onAuth, setSignedOut, signOut } from '../auth';
import { boardAccess, workspaceOf } from '../cloud-logic';
import { denialForGuestSession, guestAccessEnded, GUEST_ENDED_SYNC_LABEL, GUEST_ENDED_SYNC_TIP } from '../guest-access';
import { CANVAS_INK, STICKY_COLORS, colorName } from '../palette';
import { boxBounds } from '../geometry';
import { formatShortcutLabel, SHORTCUTS } from '../shortcuts';
import { themeRadioGroup } from './theme-menu';
import { getStoredTheme, onThemeChange, THEMES } from '../themes';
import { kbdHint } from './kbd';
import { openProfileDialog } from './profile-dialog';
import { trackerEnabled as trackerAllowed } from '../tracker-gate';
import { navigateTrackerPath } from '../route';
import { stickyColorField } from './colors';
import { openAiKeyDialog } from './ai';
import { aiBarFor, aiBarShown, glyph, mountAiBar, onAiBarChange } from './ai-bar';
import { liveRunsFor, mountAiLive, onLiveChange } from './ai-live';
import './ai-review-panel';
import { avatarLine, badgeRun } from '../ai-live-logic';
import { openTokensDialog } from './tokens';
import { openSaveTemplate } from './save-template';
import { mountSharePeople } from './share';
import { mountJoinCodes } from './join-codes';
import { guestMark } from './guest-mark';
import { canChangeProfile, canManageJoinCodes, canManageShares, canSaveTemplate } from './share-logic';
import { trackPanelTop } from './panel-top';
import { mountRailScrollCue, trackMoreY } from './scroll-cue';
import { choiceForToolKind, rememberToolChoice, restoreToolChoice, type RailToolChoice } from './rail-tool-group-state';
import { DEMO } from '../demo';
import { demoWorkspaceItems } from './demo-workspace';

type IconName = keyof typeof ICONS;

/**
 * `scratch` is a template being edited on a board that is not synced or listed: it has no sharing, sync status,
 * comments, version history or Save board as template, and its home button is whatever `nav.home` does.
 */
export function mountBoardUi(app: BoardApp, root: HTMLElement, nav: { home: () => void }, opts: { scratch?: boolean; demo?: boolean; trackerId?: string; ticketKey?: string; guestId?: string } = {}) {
  const scratch = opts.scratch === true;
  const demo = opts.demo === true || DEMO;
  let trackerStore: TrackerStore | null = null;
  const trackerEnabled = () => {
    return !scratch && !demo && trackerAllowed(authState());
  };
  app.linkTrackerKanban = (kanbanId) => {
    const store = trackerStore;
    if (!trackerEnabled() || app.readOnly || !store) return;
    const layout = app.store.containerLayout(kanbanId);
    const lanes = (layout?.lanes ?? []).map((laneId) => ({ id: laneId, name: app.store.get(laneId)?.name ?? 'Lane', cardCount: layout?.cards.get(laneId)?.length ?? 0 }));
    openRegisteredLinkDialog({
      boardId: app.conn.id, kanbanId, store,
      kanban: { name: app.store.get(kanbanId)?.name ?? 'Kanban', lanes, cardCount: lanes.reduce((n, lane) => n + lane.cardCount, 0) },
    });
  };
  app.unlinkTrackerKanban = (kanbanId) => {
    const store = trackerStore;
    if (!trackerEnabled() || app.readOnly || !store) return;
    void store.listLinks(app.conn.id).then((links) => {
      const link = links.find((candidate) => candidate.kanbanId === kanbanId);
      if (!link) return app.notify('This kanban is no longer linked to the tracker.');
      if (!openRegisteredUnlinkConfirm({ boardId: app.conn.id, kanbanId, link, store })) app.notify('The unlink confirmation is unavailable.');
    }).catch((error: unknown) => app.notify(error instanceof Error ? error.message : 'Could not load tracker links.'));
  };
  const uninstallLinkDialog = installTrackerLinkDialog();
  const uninstallUnlinkConfirm = installTrackerUnlinkConfirm();
  app.lifetime?.signal.addEventListener('abort', () => { uninstallLinkDialog(); uninstallUnlinkConfirm(); }, { once: true });
  const chrome = h('div', { class: 'chrome' });
  root.appendChild(chrome);
  app.notify = toast;
  app.announce = announce;

  // ---------------------------------------------------------------- top left
  const name = h('input', { class: 'board-name', value: app.store.getMeta().name, 'aria-label': 'Board name', spellcheck: 'false' });
  name.addEventListener('change', () => app.store.setMeta({ name: name.value.trim() || 'Untitled board' }));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
  });
  app.on('meta', () => {
    if (document.activeElement !== name) name.value = app.store.getMeta().name;
    document.title = `${app.store.getMeta().name} - Tabula`;
    heading.textContent = app.store.getMeta().name;
  });
  document.title = `${app.store.getMeta().name} - Tabula`;
  // the page's h1 for a screen reader: the board's name (the visible name is an input)
  const heading = h('h1', { class: 'sr-only' }, app.store.getMeta().name);
  const status = h('button', { class: 'sync-status', onclick: () => openShare(app) });
  const renderStatus = () => {
    const s = app.conn.status;
    const others = app.participants().filter((p) => !p.isMe).length;
    const currentAuth = authState();
    const deniedForGuest = denialForGuestSession(opts.guestId ?? null, currentAuth, app.conn.denied);
    const guestLinkRemoved = guestAccessEnded(currentAuth, deniedForGuest);
    status.dataset.state = guestLinkRemoved ? 'denied' : s;
    let label = 'Local only';
    let tip = 'Sync is off. Every change is saved on this device.';
    if (guestLinkRemoved) {
      app.comments.setReadOnly(true);
      label = GUEST_ENDED_SYNC_LABEL;
      tip = GUEST_ENDED_SYNC_TIP;
    } else if (s === 'live') {
      label = others ? `Live with ${others}` : 'Live';
      tip = 'Connected to the relay. Changes sync in real time.';
    } else if (s === 'connecting') {
      label = 'Saved on this device';
      tip = 'Every change is saved on this device. Waiting for the relay to sync with others.';
    } else if (s === 'denied') {
      const restoring = app.conn.denied === 'restoring';
      label = restoring ? 'Restoring…' : app.conn.denied === 'unauthenticated' ? 'Sign in needed' : 'No access';
      tip = restoring
        ? 'The workspace is being restored from a backup. Your changes are saved on this device.'
        : 'The server refused this connection. Your changes are still saved on this device.';
    }
    status.replaceChildren(h('span', { class: 'sync-status-dot', 'aria-hidden': 'true' }), h('span', { class: 'sync-status-label' }, s === 'live' ? 'Live' : label));
    status.setAttribute('aria-label', label);
    if (window.innerWidth <= 480) {
      status.dataset.tip = label;
    } else {
      status.dataset.tip = tip;
    }
    // a change of state is announced; the count of people changing inside "live" is announced by name below
    if (lastState !== null && s !== lastState) announce(`Sync: ${label}`, { key: 'sync', delay: 800 });
    lastState = s;
  };
  let lastState: string | null = null;
  app.on('status', renderStatus);
  app.on('presence', renderStatus);
  app.lifetime.signal.addEventListener('abort', onAuth(renderStatus), { once: true });
  renderStatus();

  const badge = h('span', { class: 'readonly-badge', role: 'status' }, 'View only');
  const homeLabel = scratch ? 'Back to templates' : 'All boards';
  const topLeft = h('div', { class: 'tray top-left', role: 'region', 'aria-label': 'Board' },
    heading,
    demo ? null : h('button', { class: 'icon-btn', 'aria-label': homeLabel, onclick: nav.home }, icon('home', 18)),
    scratch ? null : name, scratch || demo ? null : status, badge,
  );

  // ---------------------------------------------------------------- top right
  const people = h('div', { class: 'people', 'aria-label': 'People on this board' });
  const phonePeople = h('button', { class: 'phone-people', type: 'button', 'aria-label': 'People on this board', 'aria-haspopup': 'dialog' });
  let fitSixAvatars = false;
  let knownPeople: Map<number, string> | null = null;
  const renderPeople = () => {
    const ps = app.participants().sort((a, b) => Number(b.isMe) - Number(a.isMe));
    const limit = window.innerWidth < 380 ? 1 : window.innerWidth < 480 ? 2 : fitSixAvatars ? 6 : 3;
    const remaining = Math.max(0, ps.length - limit);
    const canEditProfile = canChangeProfile(authState().mode);
    // who arrived and who left since the last time, said once the first list is known
    const now = new Map(ps.filter((p) => !p.isMe).map((p) => [p.clientId, `${p.user.name}${p.user.guest ? ' · Guest' : ''}`]));
    if (knownPeople) {
      for (const [id, who] of now) if (!knownPeople.has(id)) announce(`${who} joined`, { key: 'presence', delay: 700, merge: true });
      for (const [id, who] of knownPeople) if (!now.has(id)) announce(`${who} left`, { key: 'presence', delay: 700, merge: true });
    }
    knownPeople = now;
    const runs = liveRunsFor(app)?.list() ?? [];
    people.replaceChildren(...ps.slice(0, limit).map((p) => {
      // someone with an AI run or preview on the board: the spark, and what they are doing as their name
      const busy = p.isMe ? null : badgeRun(p.user, runs);
      const name = `${p.user.name}${p.user.guest ? ' · Guest' : ''}`;
      const avatarText = initials(p.user.name);
      const tip = busy ? `${avatarLine(busy)} · ${name}` : p.isMe ? `${name} (you)` : `Go to ${name}`;
      const children = [h('span', { 'aria-hidden': 'true' }, avatarText), p.user.guest ? guestMark('avatar-guest') : null,
        busy ? h('span', { class: 'avatar-ai', 'aria-hidden': 'true' }, glyph('spark', 10)) : null] as const;
      const props = { class: busy ? 'avatar ai-busy' : 'avatar', style: `--c:${p.user.color}`, 'data-tip': tip, 'aria-label': `${tip}, initials ${avatarText}` };
      if (p.isMe && !canEditProfile) return h('span', { ...props, role: 'img' }, ...children);
      return h('button', { ...props, onclick: () => (p.isMe ? openProfile(app) : app.followUser(p.clientId)) }, ...children);
    }), ...(remaining > 0 ? [h('span', { class: 'avatar more', role: 'img', 'aria-label': `${remaining} more people here`, 'data-tip': `${remaining} more people here` }, `+${remaining}`)] : []));
    const peopleLabel = ps.length === 1 ? 'People on this board: 1 person' : `People on this board: ${ps.length} people`;
    phonePeople.hidden = ps.length < 2; // alone, the chip only repeats your own avatar; the menu still has your name and colour
    phonePeople.setAttribute('aria-label', peopleLabel);
    phonePeople.dataset.tip = peopleLabel;
    phonePeople.replaceChildren(
      h('span', { class: 'phone-people-avatars', 'aria-hidden': 'true' }, ...ps.slice(0, 2).map((p, index) => h('span', {
        class: `avatar phone-avatar${index === 0 ? ' first' : ''}`, style: `--c:${p.user.color}`,
      }, initials(p.user.name)))),
      ...(ps.length > 2 ? [h('span', { class: 'phone-people-count', 'aria-hidden': 'true' }, `+${ps.length - 2}`)] : []),
    );
  };
  phonePeople.addEventListener('click', () => {
    const ps = app.participants().sort((a, b) => Number(b.isMe) - Number(a.isMe));
    const canEditProfile = canChangeProfile(authState().mode);
    let pop: ReturnType<typeof popover>;
    const list = h('div', { class: 'phone-people-list', role: 'menu', 'aria-label': 'People on this board' }, ...ps.map((p) => {
      const name = `${p.user.name}${p.user.guest ? ' · Guest' : ''}`;
      const initialsText = initials(p.user.name);
      const children = [
        h('span', { class: 'avatar phone-person-avatar', style: `--c:${p.user.color}`, 'aria-hidden': 'true' }, initialsText),
        h('span', { class: 'phone-person-name' }, p.user.name),
        p.isMe ? h('span', { class: 'phone-person-mark' }, 'You') : p.user.guest ? h('span', { class: 'phone-person-mark guest' }, 'Guest') : null,
      ] as const;
      if (p.isMe && !canEditProfile) return h('div', { class: 'menu-item phone-person-option', role: 'menuitem', 'aria-disabled': 'true' }, ...children);
      return h('button', {
        class: 'menu-item phone-person-option', type: 'button', role: 'menuitem',
        'aria-label': `${p.isMe ? `${name} (you)` : `Go to ${name}`}, initials ${initialsText}`,
        onclick: () => {
          pop.close();
          if (p.isMe) openProfile(app);
          else app.followUser(p.clientId);
        },
      }, ...children);
    }));
    pop = popover(phonePeople, list, { side: 'bottom', className: 'phone-people-pop', label: 'People on this board' });
  });
  let refreshPresenceLayout = renderPeople;
  app.on('presence', () => refreshPresenceLayout());
  renderPeople();
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': 'Menu' }, icon('dots', 18));
  const history = scratch || demo ? null : mountHistory(app, chrome);
  menuBtn.addEventListener('click', () => openMenu(app, menuBtn, history?.open ?? null, scratch, demo, () => library.open('layers')));
  // Comments and, where the server has chat (docs/chat.md), Chat share one right-hand tray
  const sideTray = mountSideTray(chrome);
  const comments = mountComments(app, chrome, sideTray);
  const chatDock = currentChatDock();
  const chat = !scratch && !demo && chatAvailable() && app.role !== null && chatDock ? mountChat(app, chatDock, sideTray) : null;
  const topRight = h('div', { class: 'tray top-right', role: 'region', 'aria-label': 'People and sharing' },
    scratch || demo ? null : people,
    scratch || demo ? null : phonePeople,
    scratch ? null : comments.button,
    chat?.button,
    scratch || demo || authState().mode === 'guest' ? null : h('button', { class: 'btn primary share-btn', 'aria-label': 'Share', onclick: () => openShare(app) }, icon('share', 16), h('span', { class: 'share-label' }, 'Share')),
    menuBtn,
  );

  // ---------------------------------------------------------------- rail
  const library = mountLibrary(app, chrome);
  bindLayersKey(app, library);
  const toolBtn = (label: string, ic: IconName, tool: Tool, key: string) => {
    const b = h('button', { class: 'rail-btn', 'aria-label': label, 'aria-keyshortcuts': key, 'data-tip-key': key.toLowerCase(), onclick: () => app.setTool(tool) }, icon(ic, 22));
    b.dataset.tool = tool.kind;
    return b;
  };
  const railGroupChoices = [
    { id: 'text', label: 'Text', icon: 'text' as IconName, key: 'T', tool: { kind: 'text' } as Tool },
    { id: 'table', label: 'Table', icon: 'table' as IconName, key: 'G', tool: { kind: 'table' } as Tool },
    { id: 'markdown', label: 'Markdown block', icon: 'markdown' as IconName, key: '', tool: { kind: 'markdown' } as Tool },
    // Link cards open an address popover instead of arming a tool, and are not offered in the demo
    ...(demo ? [] : [{ id: 'link', label: 'Link', icon: 'link' as IconName, key: '', tool: null as Tool | null }]),
  ];
  const railGroupState: RailToolChoice[] = railGroupChoices.map(({ id, tool }) => ({ id, toolKind: tool?.kind }));
  const railGroupStorageKey = 'driftboard:rail-tool-group:text-markdown-link';
  const loadRailGroupChoice = () => {
    try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(railGroupStorageKey); } catch { return null; }
  };
  const saveRailGroupChoice = (choice: string) => {
    try { localStorage.setItem(railGroupStorageKey, choice); } catch { /* grouped tool memory is a convenience */ }
  };
  let lastRailGroupChoice = restoreToolChoice(loadRailGroupChoice(), app.tool.kind, railGroupState, 'text');
  let railGroupButton: HTMLButtonElement;
  let closeRailGroup: () => void = () => {};
  let longPressTimer = 0;
  let suppressGroupClickTimer = 0;
  let suppressGroupClick = false;
  const clearGroupClickSuppression = () => {
    window.clearTimeout(suppressGroupClickTimer);
    suppressGroupClickTimer = 0;
    suppressGroupClick = false;
  };
  const deferClearGroupClickSuppression = () => {
    window.clearTimeout(suppressGroupClickTimer);
    if (!suppressGroupClick) return;
    suppressGroupClickTimer = window.setTimeout(() => {
      suppressGroupClick = false;
      suppressGroupClickTimer = 0;
    }, 50);
  };
  const currentRailGroupChoice = () => railGroupChoices.find((choice) => choice.id === lastRailGroupChoice) ?? railGroupChoices[0];
  const paintRailGroupButton = () => {
    const choice = currentRailGroupChoice();
    if (choice.tool) railGroupButton.dataset.tool = choice.tool.kind;
    else delete railGroupButton.dataset.tool;
    const active = !!choice.tool && app.tool.kind === choice.tool.kind;
    railGroupButton.classList.toggle('on', active);
    railGroupButton.setAttribute('aria-pressed', String(active));
    railGroupButton.setAttribute('aria-label', choice.label);
    if (choice.key) { railGroupButton.setAttribute('aria-keyshortcuts', choice.key); railGroupButton.dataset.tipKey = choice.key.toLowerCase(); } else { railGroupButton.removeAttribute('aria-keyshortcuts'); delete railGroupButton.dataset.tipKey; }
    railGroupButton.replaceChildren(icon(choice.icon, 20), h('span', { class: 'rail-group-chevron', 'aria-hidden': 'true' }, icon('chevron', 10)));
  };
  const selectRailGroupChoice = (id: string) => {
    const choice = railGroupChoices.find((item) => item.id === id);
    if (!choice) return;
    closeRailGroup();
    lastRailGroupChoice = choice.id;
    saveRailGroupChoice(choice.id);
    paintRailGroupButton();
    if (choice.tool) app.setTool(choice.tool);
    else if (app.readOnly) toast("You can't add links to a board you can only view.");
    else openLinkPopover(app, railGroupButton);
  };
  const openRailGroup = () => {
    if (document.querySelector('.rail-tool-pop')) return;
    const options = railGroupChoices.map((choice) => h('button', {
      class: 'menu-item rail-tool-option', type: 'button', role: 'menuitem', 'aria-label': choice.label,
      ...(choice.key ? { 'aria-keyshortcuts': choice.key } : {}), onclick: () => selectRailGroupChoice(choice.id),
    }, icon(choice.icon, 20), h('span', null, choice.label), ...(choice.key ? [h('kbd', null, choice.key)] : [])));
    const list = h('div', { class: 'rail-tool-list', role: 'presentation' }, ...options);
    list.addEventListener('keydown', (event: KeyboardEvent) => {
      const buttons = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const active = buttons.indexOf(event.target as HTMLButtonElement);
      if (active < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (active + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        buttons[active]?.click();
      }
    });
    const opened = popover(railGroupButton, list, {
      side: 'right', className: 'rail-tool-pop', label: 'Text and content tools', role: 'menu',
      onClose: () => {
        railGroupButton.setAttribute('aria-expanded', 'false');
        closeRailGroup = () => {};
      },
    });
    railGroupButton.setAttribute('aria-expanded', 'true');
    closeRailGroup = opened.close;
  };
  railGroupButton = h('button', {
    class: 'rail-btn rail-tool-group', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  });
  paintRailGroupButton();
  railGroupButton.addEventListener('click', (event) => {
    if (suppressGroupClick) {
      clearGroupClickSuppression();
      event.preventDefault();
      return;
    }
    if ((event.target as HTMLElement).closest('.rail-group-chevron')) openRailGroup();
    else selectRailGroupChoice(lastRailGroupChoice);
  });
  railGroupButton.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    openRailGroup();
  });
  railGroupButton.addEventListener('pointerdown', (event) => {
    clearGroupClickSuppression();
    window.clearTimeout(longPressTimer);
    if (event.button !== 0) return;
    longPressTimer = window.setTimeout(() => {
      suppressGroupClick = true;
      openRailGroup();
    }, 500);
  });
  const cancelRailGroupPress = () => window.clearTimeout(longPressTimer);
  const releaseRailGroupPress = () => {
    cancelRailGroupPress();
    deferClearGroupClickSuppression();
  };
  railGroupButton.addEventListener('pointerup', releaseRailGroupPress);
  railGroupButton.addEventListener('pointerleave', releaseRailGroupPress);
  railGroupButton.addEventListener('pointercancel', () => {
    cancelRailGroupPress();
    clearGroupClickSuppression();
  });
  railGroupButton.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    cancelRailGroupPress();
    openRailGroup();
  });
  app.lifetime.signal.addEventListener('abort', () => {
    window.clearTimeout(longPressTimer);
    window.clearTimeout(suppressGroupClickTimer);
    closeRailGroup();
  }, { once: true });
  const drawerBtn = (label: string, ic: IconName, tab: 'uml' | 'icons' | 'stickers' | 'templates' | 'layers') => {
    const b = h('button', { class: 'rail-btn', 'aria-label': label, onclick: () => library.open(tab) }, icon(ic, 22));
    b.dataset.drawer = tab;
    return b;
  };
  const layersBtn = drawerBtn('Layers', 'layers', 'layers');
  layersBtn.setAttribute('aria-keyshortcuts', 'Alt+L');
  layersBtn.dataset.tipKey = 'alt+l';
  const templatesBtn = drawerBtn('Templates and team exercises', 'templates', 'templates');
  templatesBtn.setAttribute('aria-haspopup', 'dialog');
  templatesBtn.setAttribute('aria-expanded', 'false');
  const stickyBtn = toolBtn('Sticky note', 'sticky', { kind: 'sticky' }, 'N');
  const shapesBtn = h('button', { class: 'rail-btn', 'aria-label': 'Shapes', 'aria-haspopup': 'true', onclick: () => library.open('shapes') }, icon('shapes', 22));
  const connectorBtn = toolBtn('Connector', 'connector', { kind: 'connector' }, 'L');
  const commentBtn = toolBtn('Comment', 'comment', { kind: 'comment' }, 'C');
  // Images (docs/images.md): hidden when the server says it keeps none
  const imageBtn = h('button', { class: 'rail-btn', 'aria-label': 'Image', 'data-tip': 'Add an image', onclick: () => pickImages(app) }, icon('image', 22));
  imageBtn.hidden = demo || !imagesAvailable();
  if (!demo) app.lifetime.signal.addEventListener('abort', onAuth(() => (imageBtn.hidden = !imagesAvailable())), { once: true });
  app.onImageFiles = demo ? null : (files) => void addImages(app, files);
  app.openObjectMenu = (x, y) => openContextMenu(app, x, y);
  // the card dialog and the Labels dialog (docs/kanban.md, slice 3)
  app.openCard = (id, focus) => void openCardDialog(app, id, focus);
  app.openLabels = () => void openLabelsDialog(app);
  app.openKanbanMenu = (kind, id, at) => openKanbanMenu(app, kind, id, at);
  // the list sheet (docs/kanban.md, Phone and touch; slice 5); it goes when the board does
  app.openSheet = (id, lane) => void openContainerSheet(app, id, lane);
  app.lifetime.signal.addEventListener('abort', closeContainerSheet, { once: true });
  const voteBtn = h('button', { class: 'rail-btn', 'data-tip': 'Start a dot vote (no limit)', 'aria-label': 'Start a dot vote' }, icon('vote', 22));
  voteBtn.addEventListener('click', (e) => {
    if (app.flow.isVoting()) {
      toast('A dot vote is running. Change dots per person or finish it from the bar at the bottom.');
      return;
    }
    // Shift-click starts at once on everything, as the button always did; otherwise the person first chooses what to vote on (TAB-232)
    if (e.shiftKey) startVote(app, { kind: 'all' });
    else openVoteSetup(app, voteBtn);
  });
  let lastSkip = 0;
  app.on('vote-skip', () => {
    if (Date.now() - lastSkip < 3000) return;
    lastSkip = Date.now();
    toast('Not part of this vote. Dots go on the items with a dashed outline.');
  });
  const syncVote = () => {
    const on = app.flow.isVoting();
    voteBtn.classList.toggle('on', on);
    voteBtn.setAttribute('aria-pressed', String(on));
  };
  app.on('flow', syncVote);
  const pollBtn = h('button', { class: 'rail-btn', 'aria-label': 'Start a quick poll' }, icon('poll', 22));
  pollBtn.addEventListener('click', () => openQuickPoll(app, pollBtn));
  // Tracker is a first-class insert action, gated by /api/me and absent on non-tracker workspaces.
  const trackerCommand = h('button', {
    class: 'rail-btn', hidden: true, 'data-command': 'tracker:create-frame', 'aria-label': 'Tracker', 'data-tip': 'Tracker',
    onclick: () => {
      const auth = authState();
      if ((auth.mode !== 'signed-in' && auth.mode !== 'offline') || auth.me?.tracker !== true || app.readOnly) return;
      const viewport = app.r.viewport();
      const frame = createTrackerFrame(app.store, {
        x: viewport.x + (viewport.w - TRACKER_FRAME_DEFAULT_SIZE.w) / 2,
        y: viewport.y + (viewport.h - TRACKER_FRAME_DEFAULT_SIZE.h) / 2,
      });
      if (frame) app.setSelection([frame.id]);
    },
  }, icon('frame', 22));
  const rail = h('nav', { class: 'tray rail', 'aria-label': 'Tools' },
    h('div', { class: 'rail-tools' },
      toolBtn('Select', 'select', { kind: 'select' }, 'V'),
      toolBtn('Hand', 'hand', { kind: 'hand' }, 'H'),
      h('hr'),
      stickyBtn,
      railGroupButton,
      shapesBtn,
      connectorBtn,
      toolBtn('Pen', 'pen', { kind: 'pen' }, 'P'),
      toolBtn('Frame', 'frame', { kind: 'frame' }, 'F'),
      trackerCommand,
      imageBtn,
      commentBtn,
      h('hr'),
      drawerBtn('UML', 'uml', 'uml'),
      drawerBtn('Icons', 'icons', 'icons'),
      drawerBtn('Stickers', 'stickers', 'stickers'),
      templatesBtn,
      layersBtn,
      voteBtn,
      pollBtn,
    ),
    // TAB-272: these controls are a sibling of the scroll region, so no scrolling tool can pass under them.
    h('div', { class: 'rail-end' },
      h('hr'),
      h('button', { class: 'rail-btn', 'aria-label': 'Undo', 'data-tip-key': 'mod+z', onclick: () => app.store.undo.undo() }, icon('undo', 22)),
      h('button', { class: 'rail-btn', 'aria-label': 'Redo', 'data-tip-key': 'mod+shift+z', onclick: () => app.store.undo.redo() }, icon('redo', 22)),
    ),
  );
  // The phone demo keeps six tools (see .demo-board in styles.css).
  for (const b of [stickyBtn, shapesBtn]) b.classList.add('demo-keep');
  for (const b of rail.querySelectorAll<HTMLElement>('[data-tool="select"], [data-tool="hand"], [data-tool="connector"]')) b.classList.add('demo-keep');
  railGroupButton.classList.add('demo-keep');
  rail.querySelector<HTMLElement>('[data-tool="pen"]')?.classList.add('demo-keep');
  // the tools scroll when the window is short, with nothing else to say so: the edge that has more behind it fades out
  const railTools = rail.querySelector<HTMLElement>('.rail-tools');
  if (railTools) {
    trackMoreY(railTools);
    // and a chevron and a thin track say so out loud, while the tools overflow (docs/design: the rail in a short window)
    const chevron = h('button', { class: 'rail-more', type: 'button', hidden: true, 'data-dir': 'down', 'aria-label': 'Scroll tools down', 'data-tip': 'Scroll tools down' }, icon('chevron', 16));
    const thumb = h('span', { class: 'rail-track-thumb' });
    const track = h('div', { class: 'rail-track', hidden: true, 'aria-hidden': 'true' }, thumb);
    rail.insertBefore(chevron, rail.querySelector('.rail-end'));
    rail.append(track);
    mountRailScrollCue(rail, railTools, chevron, track, thumb);
  }
  const syncRail = () => {
    if (choiceForToolKind(app.tool.kind, railGroupState)) {
      const groupChoice = rememberToolChoice(lastRailGroupChoice, app.tool.kind, railGroupState);
      if (groupChoice !== lastRailGroupChoice) {
        lastRailGroupChoice = groupChoice;
        saveRailGroupChoice(groupChoice);
      }
    }
    paintRailGroupButton();
    rail.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => {
      const t = app.tool;
      const on = b.dataset.tool === t.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    stickyBtn.style.setProperty('--sticky', app.stickyColor);
  };
  app.closeEscapeDrawer = () => {
    const tab = library.tab;
    if (tab) {
      library.open(null);
      (tab === 'shapes' ? shapesBtn : rail.querySelector<HTMLElement>(`[data-drawer="${tab}"]`))?.focus();
      return true;
    }
    const sideTab = sideTray.current();
    if (sideTab) {
      sideTray.hide();
      comments.button.focus();
      return true;
    }
    // the chat dock closes on Esc as the chat tray did: the first Esc leaves the message box, the next closes the dock;
    // on the Chat button itself Esc does nothing, because the button is a toggle
    if (chat && chatDock && (chatDock.mode() === 'open' || chatDock.mode() === 'compact') && document.activeElement !== chat.button) {
      chatDock.dispatch('close');
      chat.button.focus();
      return true;
    }
    return false;
  };
  app.lifetime.signal.addEventListener('abort', () => { app.closeEscapeDrawer = null; }, { once: true });
  const syncShapesBtn = () => {
    const on = library.tab === 'shapes' || app.tool.kind === 'shape';
    shapesBtn.classList.toggle('on', on);
    shapesBtn.setAttribute('aria-pressed', String(on));
  };
  library.onChange((t) => rail.querySelectorAll<HTMLElement>('[data-drawer]').forEach((b) => b.classList.toggle('on', b.dataset.drawer === t)));
  library.onChange(syncShapesBtn);
  app.on('tool', syncRail);
  app.on('tool', syncShapesBtn);
  app.on('selection', syncRail);
  syncRail();
  syncShapesBtn();
  syncVote();

  // Sticky colour tray appears while the sticky tool is active.
  const stickyTray = h('div', { class: 'tray tool-tray sticky-tray', 'aria-label': 'Sticky note colour' });
  // On a phone the open tray covers a good part of the board (taps under it are swallowed), so a picked colour closes it
  // and the sticky tool stays on; choosing the tool again, or coming back to it, shows it again.
  let stickyTrayDismissed = false;
  let stickyWas = false;
  const narrowScreen = () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
  const renderStickyTray = () => {
    const isSticky = app.tool.kind === 'sticky';
    if (!isSticky || !stickyWas) stickyTrayDismissed = false;
    stickyWas = isSticky;
    const show = isSticky && !app.readOnly && !stickyTrayDismissed;
    stickyTray.classList.toggle('show', show);
    if (!show) return;
    stickyTray.style.top = `${stickyBtn.getBoundingClientRect().top - 6}px`;
    // the AI bar's Generate, with an empty board sending only the prompt; it opens the bar and runs nothing
    const generate = aiBarFor(app) ? h('button', {
      class: 'btn ailive-generate', type: 'button', 'data-tip': 'Generate sticky notes with AI',
      onclick: () => aiBarFor(app)?.open({ arm: 'generate', context: app.store.cache.size ? undefined : 'none' }),
    }, glyph('spark', 16), 'Generate') : null;
    stickyTray.replaceChildren(
      h('div', { class: 'tray-label' }, 'Note colour'),
      stickyColorField(app, app.stickyColor, (c) => {
        app.stickyColor = c;
        if (narrowScreen()) stickyTrayDismissed = true;
        renderStickyTray();
      }, { label: 'Sticky note colour', size: 'lg' }),
      ...(generate ? [generate] : []),
    );
  };
  app.on('tool', renderStickyTray);
  app.on('meta', renderStickyTray);
  stickyBtn.addEventListener('click', () => {
    stickyTrayDismissed = false;
    renderStickyTray();
  });
  onAiBarChange(app, (why) => { if (why === 'mount') renderStickyTray(); });

  // Pen options appear while drawing.
  const penTray = h('div', { class: 'tray tool-tray pen-tray' });
  const penBtn = () => rail.querySelector<HTMLElement>('[data-tool="pen"]');
  const renderPen = () => {
    penTray.classList.toggle('show', app.tool.kind === 'pen' && !app.readOnly);
    const pb = penBtn();
    if (pb && app.tool.kind === 'pen') penTray.style.top = `${pb.getBoundingClientRect().top - 6}px`;
    penTray.replaceChildren(
      ...[CANVAS_INK, '#2F6FED', '#D64545', '#1E9A6A', '#C98A00', '#7A5AF8'].map((c) => h('button', { class: `swatch${app.penColor === c ? ' on' : ''}`, style: `--c:${c}`, 'aria-label': `Pen colour ${colorName(c).toLowerCase()}`, 'aria-pressed': String(app.penColor === c), onclick: () => { app.penColor = c; renderPen(); } })),
      h('hr'),
      ...[2, 4, 8].map((w) => h('button', { class: `icon-btn${app.penWidth === w ? ' on' : ''}`, 'aria-label': `Pen width ${w}`, 'aria-pressed': String(app.penWidth === w), onclick: () => { app.penWidth = w; renderPen(); } }, h('span', { class: 'pen-dot', style: `--s:${w + 2}px` }))),
    );
  };
  app.on('tool', renderPen);
  renderPen();

  // ---------------------------------------------------------------- bottom right
  const zoomLabel = h('button', { class: 'zoom-label', 'data-tip': 'Reset to 100%', 'data-tip-key': 'shift+0', onclick: () => app.zoomTo(1) });
  const updateZoom = () => (zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`);
  app.r.onCamera(updateZoom);
  updateZoom();
  const mini = minimap(app);
  const zoomTray = h('div', { class: 'tray zoom-tray' },
    h('button', { class: 'icon-btn', 'aria-label': 'Zoom out', 'data-tip-key': 'mod+-', onclick: () => app.zoomBy(0.8) }, icon('minus', 18)),
    zoomLabel,
    h('button', { class: 'icon-btn', 'aria-label': 'Zoom in', 'data-tip-key': 'mod+=', onclick: () => app.zoomBy(1.25) }, icon('plus', 18)),
    h('button', { class: 'icon-btn', 'aria-label': 'Fit board', 'data-tip-key': 'shift+1', onclick: () => app.zoomToFit() }, icon('fit', 18)),
    h('button', { class: 'icon-btn', 'data-tip': 'Minimap', 'aria-label': 'Toggle minimap', onclick: (e: Event) => { mini.toggle(); (e.currentTarget as HTMLElement).classList.toggle('on', mini.visible()); } }, icon('map', 18)),
  );

  chrome.append(topLeft, topRight, rail, penTray, stickyTray, mini.el, zoomTray);
  // the canvas is one tab stop, after the tool rail and before what acts on a selection (docs/canvas-keyboard.md)
  const canvasFocus = mountCanvasFocus(app, rail);
  app.onDestroy(() => canvasFocus.destroy());
  trackPanelTop(chrome, [topLeft, topRight]);
  const updatePanelTop = () => {
    const origin = chrome.getBoundingClientRect().top;
    const bottoms = [topLeft, topRight].filter((bar) => typeof bar.getClientRects !== 'function' || bar.getClientRects().length > 0).map((bar) => bar.getBoundingClientRect().bottom);
    const lowest = Math.max(origin, ...bottoms);
    chrome.style.setProperty('--panel-top', `${Math.max(72, Math.ceil(lowest - origin + 8))}px`);
  };
  const positionPhoneTray = () => {
    if (window.innerWidth <= 480) {
      topRight.style.removeProperty('top');
      const safeRight = typeof getComputedStyle === 'function'
        ? Number.parseFloat(getComputedStyle(chrome).getPropertyValue('--safe-right')) || 0
        : 0;
      const rightWidth = topRight.getBoundingClientRect().width;
      topLeft.style.right = `${Math.ceil(rightWidth + 16 + safeRight)}px`;
      updatePanelTop();
      return;
    }
    topLeft.style.removeProperty('right');
    if (window.innerWidth > 860) {
      topRight.style.removeProperty('top');
      updatePanelTop();
      return;
    }
    const origin = chrome.getBoundingClientRect().top;
    const leftBottom = topLeft.getBoundingClientRect().bottom - origin;
    const safeTop = typeof getComputedStyle === 'function'
      ? Number.parseFloat(getComputedStyle(chrome).getPropertyValue('--safe-top')) || 0
      : 0;
    // the phone demo hides the board-name chip, so the menu pill rises to the banner's edge
    const demoTop = topLeft.getBoundingClientRect().height === 0 ? 46 : 100;
    const minimumTop = (chrome.closest('.demo-board') ? demoTop : 64) + safeTop;
    topRight.style.top = `${Math.ceil(Math.max(minimumTop, leftBottom + 8))}px`;
    updatePanelTop();
  };
  const refreshPeopleLayout = () => {
    fitSixAvatars = false;
    if (window.innerWidth > 480) {
      // Measure the whole tray with the six-avatar candidate rendered. Keep it only if the actual row fits.
      fitSixAvatars = true;
      renderPeople();
      const tray = topRight.getBoundingClientRect();
      const safeLeft = typeof getComputedStyle === 'function' ? Number.parseFloat(getComputedStyle(chrome).getPropertyValue('--safe-left')) || 0 : 0;
      const safeRight = typeof getComputedStyle === 'function' ? Number.parseFloat(getComputedStyle(chrome).getPropertyValue('--safe-right')) || 0 : 0;
      fitSixAvatars = topRight.clientWidth > 0
        && topRight.scrollWidth <= topRight.clientWidth + 1
        && tray.left >= 12 + safeLeft - 0.5
        && tray.right <= window.innerWidth - 12 - safeRight + 0.5;
    }
    renderPeople();
    positionPhoneTray();
    updatePanelTop();
  };
  refreshPresenceLayout = refreshPeopleLayout;
  const topLeftObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPhoneTray);
  topLeftObserver?.observe(topLeft);
  const onWindowResize = () => {
    renderStatus();
    refreshPeopleLayout();
  };
  window.addEventListener('resize', onWindowResize);
  refreshPeopleLayout();
  app.onDestroy(() => {
    topLeftObserver?.disconnect();
    window.removeEventListener('resize', onWindowResize);
  });
  renderStickyTray();
  const props = mountProps(app, chrome);
  mountQuickbar(app, chrome, props, { demo });
  mountEditBar(app, chrome);
  mountGroupUI(app, chrome);
  mountTouchMenu(app);
  mountFocus(app, chrome);
  mountFlowBar(app, chrome);
  // the live layer first: it shows the AI runs of other people also to those who have no bar (viewers, commenters)
  if (!scratch && !demo) {
    mountAiLive(app);
    liveRunsFor(app)?.onChange(renderPeople);
  }
  if (!scratch && !demo) mountAiBar(app, chrome);
  if (!scratch && !demo) firstRunHint(app, chrome, () => library.open('templates'));

  // View-only boards keep Select and Hand; the rest of the editing chrome is disabled.
  const syncReadOnly = () => {
    const ro = app.readOnly;
    rail.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b === commentBtn || b === layersBtn) return;
      b.disabled = ro && b.dataset.tool !== 'select' && b.dataset.tool !== 'hand';
    });
    // Commenters have a read-only board but may still comment, so the tool follows the comments document.
    commentBtn.disabled = app.comments.readOnly();
    commentBtn.dataset.tip = commentBtn.disabled ? 'You can\'t comment on this board' : 'Comment';
    if (commentBtn.disabled) commentBtn.removeAttribute('data-tip-key');
    else commentBtn.dataset.tipKey = 'c';
    name.readOnly = ro;
    badge.textContent = boardAccess(app.role, workspaceOf(authState()), app.deleted).badge ?? 'View only';
    badge.classList.toggle('show', ro);
    if (ro && library.tab && library.tab !== 'layers') library.open(null);
  };
  app.on('readonly', syncReadOnly);
  app.on('comments', syncReadOnly);
  app.comments.onReadOnly(syncReadOnly);
  // A hosted workspace can turn read-only (or back) while the board is open: the badge names the reason.
  app.lifetime.signal.addEventListener('abort', onAuth(syncReadOnly), { once: true });
  syncReadOnly();

  let stopTrackerFrames: (() => void) | null = null;
  let trackerVisualInit = false;
  const mountTracker = (store: TrackerStore, api: TrackerApi, viewerId: string) => {
    trackerStore = store;
    stopTrackerFrames = mountTrackerFrames({ app, store, api, viewerId, initialTrackerId: opts.trackerId, initialTicketKey: opts.ticketKey });
    if (trackerBoardMockVisual) {
      Object.assign(window, { __trackerStore: store });
      const existing = [...app.store.cache.values()].some((obj) => obj.type === 'tracker');
      if (!existing) {
        const viewport = app.r.viewport();
        createTrackerFrame(app.store, {
          x: viewport.x + (viewport.w - TRACKER_FRAME_DEFAULT_SIZE.w) / 2,
          y: viewport.y + (viewport.h - TRACKER_FRAME_DEFAULT_SIZE.h) / 2,
        });
      }
    }
  };
  const syncTracker = () => {
    const auth = authState();
    setTrackerGuest(auth.mode === 'guest' || ((auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.user.role === 'guest'));
    const signedInWithTracker = (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.tracker === true;
    setTrackerMember(signedInWithTracker);
    const enabled = !scratch && !demo && (signedInWithTracker || trackerBoardMockVisual);
    trackerCommand.hidden = !enabled;
    if (enabled && !trackerStore) {
      if (trackerBoardMockVisual) {
        if (!trackerVisualInit) {
          trackerVisualInit = true;
          void Promise.all([import('../tracker-mock'), import('../tracker/ui/visual-seed')]).then(([mock, seed]) => {
            trackerVisualInit = false;
            if (app.lifetime.signal.aborted || !trackerBoardMockVisual) return;
            const state = new URLSearchParams(location.search).get('trackerState');
            const visual = seed.createTrackerVisualSeed();
            const wanted = seed.visualTrackerState(mock.createMockTrackerApi(state === 'empty' ? { ...visual, tickets: [] } : visual), state);
            mountTracker(createTrackerStore(wanted.api), wanted.api, 'visual-user');
          }).catch((error: unknown) => console.error('Tracker visual mock failed to initialize.', error));
        }
      } else if (auth.mode === 'signed-in' || auth.mode === 'offline') {
        const api = createHttpTrackerApi();
        mountTracker(createTrackerStore(api), api, auth.me!.user.id);
      }
    } else if (!enabled && trackerStore) {
      stopTrackerFrames?.();
      stopTrackerFrames = null;
      trackerStore.destroy();
      trackerStore = null;
    }
  };
  const stopTrackerAuth = onAuth(syncTracker);
  app.lifetime.signal.addEventListener('abort', () => {
    stopTrackerAuth();
    stopTrackerFrames?.();
    trackerStore?.destroy();
    stopTrackerFrames = null;
    trackerStore = null;
  }, { once: true });
  syncTracker();

  // Drop .drift / .json files onto the board to import them.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/uri-list')) e.preventDefault();
  });
  root.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) {
      // a link dragged from another tab: a card per address (docs/link-cards.md)
      const list = e.dataTransfer?.getData('text/uri-list') ?? '';
      if (list && !demo && app.links.dropUrls(list, app.r.clientToWorld(e.clientX, e.clientY))) e.preventDefault();
      return;
    }
    e.preventDefault();
    if (app.readOnly) return;
    // pictures go on the board where they were dropped; a board file still opens as before
    const pictures = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name));
    if (pictures.length) {
      if (demo) return;
      if (!imagesAvailable()) toast('This server does not store images.');
      else await addImages(app, pictures, app.r.clientToWorld(e.clientX, e.clientY));
      return;
    }
    await importInto(app, files[0]);
  });
}

async function importInto(app: BoardApp, file: File) {
  try {
    const { json, assets } = await readBoardFile(file);
    insertImported(app, json, assets);
    toast(`Imported ${json.objects.length} objects from ${file.name}`);
  } catch (e) {
    toast((e as Error).message);
  }
}

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function firstRunHint(app: BoardApp, chrome: HTMLElement, openTemplates: () => void = () => {
  document.querySelector<HTMLElement>('[data-drawer="templates"]')?.click();
}) {
  if (app.store.cache.size || app.readOnly) return;
  // opens the AI bar with Generate armed and only the prompt to send; it runs nothing. Shown while the bar is on the board.
  const generate = h('button', {
    class: 'btn ailive-generate', type: 'button', hidden: !aiBarFor(app), onclick: () => aiBarFor(app)?.open({ arm: 'generate', context: 'none' }),
  }, glyph('spark', 16), 'Generate');
  const hint = h('div', { class: 'empty-hint' },
    h('p', { class: 'hint-title' }, 'An empty board'),
    h('p', null, 'Press N for a sticky note, R for a rectangle, or double-click to write. Hold Space and drag to move around.'),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn primary',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        onclick: openTemplates,
      }, 'Start from a template'),
      h('button', { class: 'btn', onclick: () => openMermaidImport(app) }, 'Import Mermaid'),
      generate,
    ),
  );
  hint.hidden = hasPreview(app);
  chrome.appendChild(hint);
  onAiBarChange(app, (why) => { if (why === 'mount') generate.hidden = !aiBarFor(app); });
  // while an AI preview is on the board the hint has done its job (the person has started); it returns if the preview goes
  // and the board is still empty (TAB-214)
  const offLive = onLiveChange(app, () => { hint.hidden = hasPreview(app); });
  const off = app.on('objects', () => {
    if (app.store.cache.size) {
      hint.remove();
      off();
      offLive();
    }
  });
}

/** Whether a ready AI preview (anyone's) is on the board: its ghosts are drawn where the empty-board hint sits. */
export const hasPreview = (app: BoardApp): boolean => !!liveRunsFor(app)?.list().some((r) => r.status === 'ready');

// ---------------------------------------------------------------- minimap

function minimap(app: BoardApp) {
  const W = 220, H = 140;
  const canvas = h('canvas', { width: W * devicePixelRatio, height: H * devicePixelRatio, 'aria-label': 'Minimap', role: 'img' });
  const el = h('div', { class: 'tray minimap' }, canvas);
  let visible = false;
  let tr = { s: 1, ox: 0, oy: 0 };
  const draw = () => {
    if (!visible) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = devicePixelRatio;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const vp = app.r.viewport();
    const cb = app.r.contentBounds() ?? vp;
    const all = { x: Math.min(cb.x, vp.x), y: Math.min(cb.y, vp.y), w: 0, h: 0 };
    all.w = Math.max(cb.x + cb.w, vp.x + vp.w) - all.x;
    all.h = Math.max(cb.y + cb.h, vp.y + vp.h) - all.y;
    const s = Math.min((W - 16) / all.w, (H - 16) / all.h);
    tr = { s, ox: 8 - all.x * s + (W - 16 - all.w * s) / 2, oy: 8 - all.y * s + (H - 16 - all.h * s) / 2 };
    // what is hidden (TAB-198) is not on the board's map either
    for (const o of app.store.shown()) {
      if (!isBox(o)) continue;
      const b = boxBounds(app.store.placed(o));
      ctx.fillStyle = o.type === 'frame' ? 'rgba(255,255,255,.12)' : o.type === 'sticky' ? (o.fill ?? STICKY_COLORS[0].fill) : 'rgba(233,237,242,.55)';
      ctx.fillRect(tr.ox + b.x * s, tr.oy + b.y * s, Math.max(1, b.w * s), Math.max(1, b.h * s));
    }
    ctx.strokeStyle = '#FFD23F';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tr.ox + vp.x * s, tr.oy + vp.y * s, vp.w * s, vp.h * s);
  };
  let pending = 0;
  const later = () => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      draw();
    }, 120);
  };
  app.on('objects', later);
  app.r.onCamera(later);
  const jump = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - tr.ox) / tr.s, wy = (e.clientY - r.top - tr.oy) / tr.s;
    const vp = app.r.viewport();
    app.r.setCamera({ x: wx - vp.w / 2, y: wy - vp.h / 2 });
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    jump(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) jump(e);
  });
  return {
    el,
    toggle: () => {
      visible = !visible;
      el.classList.toggle('show', visible);
      draw();
    },
    visible: () => visible,
  };
}

// ---------------------------------------------------------------- menus & dialogs

function openMenu(app: BoardApp, anchor: HTMLElement, openHistory: (() => void) | null, scratch: boolean, demo: boolean, openLayers: () => void) {
  let pop: ReturnType<typeof popover>;
  let activeSubmenu: 'export' | 'theme' | null = null;
  let stopTheme: () => void = () => {};

  const isPhone = () => typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 500px)').matches
    : window.innerWidth <= 500;
  const isShortcutHint = (value: string) => /^(?:(?:Alt|Ctrl|Cmd|Shift|Ctrl\/Cmd)\+|[⌘⌥⇧⌃])/.test(value);
  const actionItem = (leading: HTMLElement, label: string, fn: () => unknown, hint?: string, cls = '') => {
    const trailing = hint
      ? h('span', { class: 'menu-hint' }, isShortcutHint(hint) ? kbdHint(hint) : hint)
      : null;
    const row = h('button', {
      class: 'menu-item' + (cls ? ' ' + cls : ''),
      type: 'button',
      onclick: () => { pop.close(); void fn(); },
    }, leading, h('span', { class: 'board-menu-label' }, label), trailing);
    row.dataset.menuLabel = label;
    return row;
  };
  const item = (ic: IconName, label: string, fn: () => unknown, hint?: string, cls = '') =>
    actionItem(icon(ic, 16), label, fn, hint, cls);
  const writeItem = (ic: IconName, label: string, fn: () => unknown) => {
    const row = item(ic, label, fn);
    row.disabled = app.readOnly;
    return row;
  };
  const name = () => safeName(app.store.getMeta().name);
  const fileInput = h('input', { type: 'file', accept: '.drift,.json,application/json', hidden: true });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) importInto(app, f);
  });
  const sel = app.selection.length ? app.selection : undefined;
  const auth = authState();
  const account = auth.mode === 'signed-in' ? [
    h('div', { class: 'board-menu-account' },
      icon('user', 16),
      h('div', { class: 'board-menu-account-text' },
        h('div', null, auth.me.user.name),
        h('div', { class: 'muted small' }, auth.me.user.email))),
    item('user', 'Sign out', async () => {
      await signOut().catch(() => undefined);
      location.hash = '#/signin';
    }),
    item('user', 'Sign out everywhere', async () => {
      try {
        await api.logoutAll();
      } catch {
        toast('Could not sign out everywhere. Check your connection and try again.');
        return;
      }
      setSignedOut();
      location.hash = '#/signin';
    }),
    auth.me.user.role === 'owner' || auth.me.user.role === 'admin'
      ? item('user', 'Admin', () => { location.hash = '#/admin'; })
      : null,
    auth.me.mcp ? item('link', 'AI tool access', () => openTokensDialog(auth.me)) : null,
    item('chat', 'Notification settings', () => openChatNotifications()),
    auth.me.ai?.personalKeys ? item('lock', 'Your AI key', () => openAiKeyDialog()) : null,
  ] : [];
  const showComments = item('comment', 'Show comments', () => app.setCommentsVisible(!app.commentsVisible));
  if (app.commentsVisible) showComments.append(h('span', { class: 'menu-hint' }, icon('check', 14)));
  const chatNarrow = app.toggleChat
    ? item('chat', 'Chat', () => app.toggleChat?.(), undefined, 'menu-chat-narrow')
    : null;
  const tracker = !DEMO && !demo && !scratch && trackerAllowed(auth)
    ? item('layers', 'Tracker', () => { navigateTrackerPath({ kind: 'view', view: 'all' }); })
    : null;

  const boardRows = [
    tracker,
    chatNarrow,
    ...account,
    writeItem('grid', 'Board settings', () => openSettings(app, demo)),
    demo ? writeItem('vote', 'Try dot voting', () => startVote(app, { kind: 'stickies' })) : null,
    scratch || demo || !canSaveTemplate(auth.mode) ? null : writeItem('templates', 'Save board as template', () => openSaveTemplate(app, 'board')),
    demo
      ? demoWorkspaceItems()
      : openHistory && canSeeHistory(app.role) ? item('history', 'Version history', openHistory) : null,
    item('layers', 'Layers', openLayers, 'Alt+L'),
    demo || !canChangeProfile(auth.mode) ? null : item('user', 'Your name and colour', () => openProfile(app)),
    mutedCount(app) ? item('user', 'Muted people (' + mutedCount(app) + ')', () => openMuted(app)) : null,
    scratch ? null : showComments,
    aiBarFor(app) ? actionItem(glyph('spark', 16), 'Summarise', () => aiBarFor(app)?.open({ arm: 'summarise', context: 'board' }), 'The whole board') : null,
    item('menu', 'Keyboard shortcuts', () => openShortcuts(app.toggleChat !== null)),
  ];
  const importRows = [
    writeItem('upload', 'Import a board file into this board', () => fileInput.click()),
    writeItem('mermaid', 'Import Mermaid', () => openMermaidImport(app)),
  ];
  const exportRows = [
    item('download', 'PNG image', async () => {
      toast('Preparing image…');
      try {
        download(await exportPng(app, sel, 2), name() + '.png');
      } catch (e) {
        toast((e as Error).message);
      }
    }),
    item('download', 'SVG vector', async () => download(await exportSvgFile(app, sel), `${name()}.svg`, 'image/svg+xml')),
    item('download', 'Print or save as PDF…', () => openPrint(app), 'Through your browser’s print dialog'),
    item('download', 'Board file (.drift)', async () => download(await toDrift(app, { leaveOutWithheld: true }), `${name()}.drift`, 'application/zip'), 'Board with its sync data and pictures'),
    item('download', 'JSON snapshot', () => download(JSON.stringify(toJson(app, sel, undefined, { leaveOutWithheld: true }), null, 2), `${name()}.json`, 'application/json')),
    item('download', 'Markdown summary', () => download(app.flow.summaryMarkdown(), `${name()}-summary.md`, 'text/markdown')),
    // cards of the selected kanbans, or of every kanban (docs/kanban.md, Export and import)
    csvKanbans(app).length ? item('download', 'Cards as CSV', () => downloadCardsCsv(app), 'One row per card, for spreadsheets') : null,
    item('mermaid', 'Copy as Mermaid', () => {
      const objs = leaveOutWithheld(sel ? [...app.store.cache.values()].filter((o) => sel.includes(o.id) || o.type === 'connector') : [...app.store.cache.values()], app.flow);
      navigator.clipboard.writeText(toMermaid(objs)).then(() => toast('Mermaid copied to the clipboard'), () => toast('Clipboard is not available'));
    }),
  ];

  const themeCurrent = h('span', { class: 'board-theme-name' }, '');
  const updateThemeName = () => {
    themeCurrent.textContent = THEMES.find((t) => t.id === getStoredTheme())?.name ?? THEMES[0].name;
  };
  updateThemeName();
  const themeOptions = themeRadioGroup();
  themeOptions.classList.add('board-theme-options');
  for (const row of themeOptions.querySelectorAll<HTMLButtonElement>('.theme-item')) {
    row.dataset.menuLabel = row.textContent?.trim() ?? '';
  }

  const exportPanel = h('div', { class: 'menu board-menu-submenu board-export-submenu', hidden: true }, ...exportRows);
  const themePanel = h('div', { class: 'menu board-menu-submenu board-theme-submenu', hidden: true }, themeOptions);
  const exportTrigger = h('button', {
    class: 'menu-item board-menu-sub-trigger',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => toggleSubmenu('export', true),
  }, icon('download', 16), h('span', { class: 'board-menu-label' }, sel ? 'Export selection' : 'Export'), icon('chevron', 14));
  exportTrigger.dataset.menuLabel = sel ? 'Export selection' : 'Export';
  const themeTrigger = h('button', {
    class: 'menu-item board-menu-sub-trigger',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => toggleSubmenu('theme', true),
  }, glyph('spark', 16), h('span', { class: 'board-theme-label' }, 'Theme'), themeCurrent, icon('chevron', 14));
  themeTrigger.dataset.menuLabel = 'Theme';

  type MenuChild = HTMLElement | null | MenuChild[];
  const section = (className: string, ...children: MenuChild[]) =>
    h('section', { class: 'board-menu-group ' + className }, children);
  const boardGroup = section('board-menu-board', boardRows);
  const importGroup = section('board-menu-import', ...importRows);
  const exportGroup = section('board-menu-export', exportTrigger, exportPanel);
  const themeGroup = section('board-menu-appearance', themeTrigger, themePanel);

  const search = h('input', {
    class: 'input board-menu-search-input',
    type: 'search',
    placeholder: 'Search actions',
    'aria-label': 'Search actions',
    oninput: () => filterMenu(),
  });
  const searchField = h('label', { class: 'board-menu-search' }, icon('search', 16), search, kbdHint('/', 'board-menu-slash'));
  const guide = !DEMO && !demo
    ? item('link', 'User guide', () => { window.open('/docs/', '_blank', 'noopener'); }, 'Opens in a new tab', 'guide-item')
    : null;
  const footer = h('div', { class: 'board-menu-footer' }, guide, fileInput);
  const menu = h('div', { class: 'menu board-menu' }, searchField,
    h('div', { class: 'board-menu-groups' }, boardGroup, importGroup, exportGroup, themeGroup),
    footer);
  const panels = { export: exportPanel, theme: themePanel };
  const triggers = { export: exportTrigger, theme: themeTrigger };

  function setSubmenu(key: 'export' | 'theme' | null, moveFocus: boolean): void {
    const previous = activeSubmenu;
    activeSubmenu = key;
    for (const submenu of ['export', 'theme'] as const) {
      const active = submenu === key;
      panels[submenu].hidden = !active;
      triggers[submenu].setAttribute('aria-expanded', String(active));
      if (!active) {
        panels[submenu].style.removeProperty('left');
        panels[submenu].style.removeProperty('top');
        panels[submenu].style.removeProperty('position');
        panels[submenu].style.removeProperty('z-index');
      }
    }
    if (!key) {
      if (moveFocus) triggers[previous ?? 'export'].focus();
      return;
    }
    const panel = panels[key];
    if (isPhone()) {
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
      panel.style.removeProperty('position');
      panel.style.removeProperty('z-index');
      if (moveFocus) {
        const selected = panel.querySelector<HTMLElement>('[aria-checked="true"]');
        (selected ?? panel.querySelector<HTMLElement>('.menu-item:not(:disabled)'))?.focus();
      }
      return;
    }
    panel.style.position = 'fixed';
    panel.style.zIndex = '51';
    // attached to the menu's edge, level with the row that opened it; it flips to the left only when the right has no room
    const anchorRect = triggers[key].getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelWidth = panelRect.width || 280;
    const panelHeight = panelRect.height || 240;
    const fitsRight = menuRect.right + panelWidth + 8 <= window.innerWidth;
    const left = fitsRight ? menuRect.right + 2 : Math.max(8, menuRect.left - panelWidth - 2);
    const top = Math.max(8, Math.min(anchorRect.top - 5, window.innerHeight - panelHeight - 8));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    if (moveFocus) {
      const selected = panel.querySelector<HTMLElement>('[aria-checked="true"]');
      (selected ?? panel.querySelector<HTMLElement>('.menu-item:not(:disabled)'))?.focus();
    }
  }

  function toggleSubmenu(key: 'export' | 'theme', moveFocus: boolean): void {
    setSubmenu(activeSubmenu === key ? null : key, moveFocus);
  }

  function filterMenu(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const optionRows = (panel: HTMLElement) => Array.from(panel.querySelectorAll<HTMLButtonElement>('.menu-item[data-menu-label]'));
    const childMatches = (panel: HTMLElement) => optionRows(panel).some((row) => row.dataset.menuLabel?.toLocaleLowerCase().includes(query));
    const exportMatches = query !== '' && childMatches(exportPanel);
    const themeMatches = query !== '' && childMatches(themePanel);
    if (query) {
      if (exportTrigger.dataset.menuLabel?.toLocaleLowerCase().includes(query) || exportMatches) setSubmenu('export', false);
      else if (themeTrigger.dataset.menuLabel?.toLocaleLowerCase().includes(query) || themeMatches) setSubmenu('theme', false);
      else if (activeSubmenu) setSubmenu(null, false);
    }
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('.menu-item[data-menu-label]'));
    for (const row of rows) {
      const label = row.dataset.menuLabel?.toLocaleLowerCase() ?? '';
      const panel = row.closest<HTMLElement>('.board-menu-submenu');
      const parentMatches = panel?.classList.contains('board-export-submenu')
        ? exportTrigger.dataset.menuLabel?.toLocaleLowerCase().includes(query) === true
        : panel?.classList.contains('board-theme-submenu')
          ? themeTrigger.dataset.menuLabel?.toLocaleLowerCase().includes(query) === true
          : false;
      const childMatch = row === exportTrigger ? exportMatches
        : row === themeTrigger ? themeMatches
          : false;
      row.hidden = query !== '' && !label.includes(query) && !parentMatches && !childMatch;
    }
    for (const group of [boardGroup, importGroup, exportGroup, themeGroup]) {
      group.hidden = query !== '' && !group.querySelector('.menu-item:not([hidden])');
    }
    footer.hidden = query !== '' && !footer.querySelector('.menu-item:not([hidden])');
  }

  function menuKeyDown(event: KeyboardEvent): boolean {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === '/' && target !== search && !event.metaKey && !event.ctrlKey && !event.altKey) {
      search.focus();
      return true;
    }
    if (event.key === 'Escape') {
      if (search.value.trim()) {
        search.value = '';
        filterMenu();
        if (activeSubmenu) setSubmenu(null, false);
        search.focus();
        return true;
      }
      // the Export list opens by itself with the menu: Esc closes the menu unless focus is inside an open list
      if (activeSubmenu && target && panels[activeSubmenu].contains(target)) {
        toggleSubmenu(activeSubmenu, true);
        return true;
      }
      return false;
    }
    if (event.key === 'ArrowLeft' && activeSubmenu) {
      const submenu = activeSubmenu;
      setSubmenu(null, false);
      triggers[submenu].focus();
      return true;
    }
    if (event.key === 'ArrowRight' && target === exportTrigger) {
      setSubmenu('export', true);
      return true;
    }
    if (event.key === 'Enter' && target === exportTrigger) {
      setSubmenu('export', true);
      return true;
    }
    if (event.key === 'ArrowRight' && target === themeTrigger) {
      setSubmenu('theme', true);
      return true;
    }
    if (event.key === 'Enter' && target === themeTrigger) {
      setSubmenu('theme', true);
      return true;
    }
    if (activeSubmenu === 'theme' && target?.closest('.board-theme-options') && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return false;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return false;

    const activePanel = target?.closest<HTMLElement>('.board-menu-submenu');
    const rows = Array.from((activePanel ?? menu).querySelectorAll<HTMLButtonElement>('.menu-item[data-menu-label]:not(:disabled):not([hidden])'))
      .filter((row) => !row.closest('[hidden]') && (!!activePanel || row.closest('.board-menu-submenu') === null));
    if (!rows.length) return false;
    const current = rows.indexOf(target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
        : current < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
    return true;
  }

  pop = popover(anchor, menu, {
    side: 'bottom',
    className: 'board-menu-pop',
    label: 'Board actions',
    onKeyDown: menuKeyDown,
    onClose: () => stopTheme(),
  });
  // a mouse opens a list after a short rest on its row and closes it when the pointer rests on another row; never on open
  let hoverTimer = 0;
  menu.addEventListener('pointerover', (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || isPhone()) return;
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.menu-item') : null;
    if (!row) return;
    window.clearTimeout(hoverTimer);
    if (row.closest('.board-menu-submenu')) return;
    const key = row === exportTrigger ? 'export' : row === themeTrigger ? 'theme' : null;
    if (key === activeSubmenu) return;
    if (key === null && activeSubmenu === null) return;
    hoverTimer = window.setTimeout(() => { if (menu.isConnected) setSubmenu(key, false); }, key ? 150 : 250);
  });
  menu.addEventListener('keydown', (event: KeyboardEvent) => {
    if (activeSubmenu !== 'theme' || event.key !== 'ArrowLeft' || !(event.target instanceof HTMLElement) || !event.target.closest('.board-theme-options')) return;
    event.preventDefault();
    event.stopPropagation();
    setSubmenu(null, false);
    themeTrigger.focus();
  }, true);
  stopTheme = onThemeChange(updateThemeName);
  setSubmenu(null, false);
}

function openShare(app: BoardApp) {
  const url = location.href;
  const relay = relayUrl();
  const input = h('input', { class: 'input', value: url, readOnly: true, 'aria-label': 'Board link' });
  const live = app.conn.status === 'live';
  const auth = authState();
  const accounts = auth.mode === 'signed-in' || (auth.mode === 'offline' && auth.me !== null);
  const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
  const manage = me !== null && canManageShares(app.role, accounts);
  const canCreateJoinCode = canManageJoinCodes(me, app.role);
  dialog('Share this board', h('div', { class: 'stack' },
    h('p', null, accounts
      ? `Only people with access to this board can open this link: members of the board's team, and anyone it has been shared with. ${manage ? 'Give people or teams access below.' : 'Add people from a team on the home screen, or share the board from there.'}`
      : live
        ? 'Anyone who opens this link while connected to the same relay can edit the board with you in real time. They do not need an account.'
        : relay
          ? 'The relay is not reachable right now, so this board is only on your device. Your changes are saved and will sync when the relay is back.'
          : 'Sync is turned off, so this board is only on your device. Turn on a relay in Board settings to collaborate.'),
    h('div', { class: 'copy-row' }, input, h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => { input.select(); }) }, icon('link', 16), 'Copy link')),
    me && manage ? mountSharePeople(app.conn.id, me) : null,
    canCreateJoinCode ? mountJoinCodes(app.conn.id) : null,
    h('p', { class: 'muted small' }, relay ? `Relay: ${relay.replace(/^ws/, 'http')}` : 'Relay: off'),
  ), [{ label: 'Done', primary: true }]);
}

function openProfile(app: BoardApp) {
  openProfileDialog(app.user, (u) => {
    Object.assign(app.user, u);
    saveUser(app.user);
    app.conn.awareness.setLocalStateField('user', app.user);
  });
}

function openSettings(app: BoardApp, demo = false) {
  const m = app.store.getMeta();
  const grid = segmented<GridType>([
    { value: 'dots', label: 'Dots' }, { value: 'lines', label: 'Lines' }, { value: 'iso', label: 'Isometric' }, { value: 'none', label: 'None' },
  ], m.gridType, (v) => app.store.setMeta({ gridType: v }), 'Grid type');
  const size = h('select', { class: 'input', 'aria-label': 'Grid size', onchange: (e: Event) => app.store.setMeta({ gridSize: Number((e.target as HTMLSelectElement).value) }) },
    ...[8, 12, 16, 20, 24, 32, 40, 48].map((n) => h('option', { value: n, selected: n === m.gridSize }, `${n}`)));
  const snap = h('input', { type: 'checkbox', checked: m.snap, 'aria-label': 'Snap to grid' });
  snap.addEventListener('change', () => app.store.setMeta({ snap: snap.checked }));
  const fontBtn = (key: 'headingFont' | 'bodyFont') => {
    const b = h('button', { class: 'input font-btn', style: `font-family:"${fontName(m[key])}", system-ui` }, h('span', { class: 'font-name' }, fontName(m[key])), icon('chevron', 16));
    b.addEventListener('click', () => openFontPicker(b, app.store.getMeta()[key], (slug) => {
      app.store.setMeta({ [key]: slug });
      b.firstChild!.textContent = fontName(slug);
      b.style.fontFamily = `"${fontName(slug)}", system-ui`;
    }));
    return b;
  };
  const relay = demo ? null : h('input', { class: 'input', value: getRelaySetting(), placeholder: 'auto, off, or wss://relay.example.com/sync', 'aria-label': 'Relay' });
  dialog('Board settings', h('div', { class: 'stack' },
    field('Grid', grid),
    h('div', { class: 'row2' }, field('Grid size', size), field('Snap to grid', h('label', { class: 'check' }, snap, 'Snap while moving and resizing'))),
    h('div', { class: 'row2' }, field('Heading font', fontBtn('headingFont')), field('Body font', fontBtn('bodyFont'))),
    h('p', { class: 'muted small' }, 'New notes, shapes and frames use these fonts. Hold Alt while dragging to place things off the grid.'),
    demo ? null : field('Relay', relay!),
    demo ? null : h('p', { class: 'muted small' }, isDesktop()
      ? '“auto” and “off” keep every board on this computer only. To collaborate, enter the address of a relay. Changing it reloads the board.'
      : '“auto” uses the relay that serves this app. “off” keeps every board on this device only. Changing it reloads the board.'),
  ), [{ label: 'Close', primary: true, onClick: () => {
    const v = relay?.value.trim() || 'auto';
    if (!demo && v !== getRelaySetting()) {
      setRelaySetting(v);
      location.reload();
    }
  } }]);
}

function openShortcuts(chat: boolean) {
  // the Ask AI row only for people who have the bar, the chat row only where the board has chat
  const listed = SHORTCUTS.filter((s) => (aiBarShown() || !s.ids.includes('mod+k')) && (chat || !s.ids.includes('m')));
  const groups = [...new Set(listed.map((s) => s.group))];
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const rows = groups.flatMap((group) => [
    h('tr', null, h('td', { colspan: 2, class: 'muted small' }, group)),
    ...listed.filter((s) => s.group === group).map((s) => h('tr', null, h('td', null, h('kbd', null, formatShortcutLabel(s.keys, platform))), h('td', null, s.action))),
  ]);
  dialog('Keyboard shortcuts', h('table', { class: 'shortcuts' }, ...rows), [{ label: 'Close', primary: true }]);
}
