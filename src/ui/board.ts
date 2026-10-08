import type { BoardApp, Tool } from '../app';
import type { GridType } from '../types';
import { isBox } from '../types';
import { h, icon, ICONS } from './dom';
import { dialog, field, popover, segmented, toast } from './common';
import { mountProps } from './props';
import { mountQuickbar } from './quickbar';
import { mountLibrary, openMermaidImport } from './library';
import { mountFlowBar } from './flowbar';
import { mountFocus, mutedCount, openMuted } from './focus';
import { openQuickPoll } from './polls';
import { mountComments } from './comments';
import { mountHistory } from './history';
import { canSeeHistory } from '../history';
import { openFontPicker } from './fontpicker';
import { download, exportPng, exportSvg, insertImported, readBoardFile, safeName, toDrift, toJson } from '../exporters';
import { toMermaid } from '../mermaid';
import { fontName } from '../fonts';
import { getRelaySetting, relayUrl, saveUser, setRelaySetting } from '../sync';
import { api } from '../api';
import { authState, onAuth, setSignedIn, setSignedOut, signOut } from '../auth';
import { boardAccess, workspaceOf } from '../cloud-logic';
import { CANVAS_INK, USER_COLORS, STICKY_COLORS } from '../palette';
import { boxBounds } from '../geometry';
import { UNLIMITED } from '../flow';
import { THEMES, getStoredTheme, setTheme } from '../themes';
import { stickyColorField } from './colors';
import { openTokensDialog } from './tokens';
import { openSaveTemplate } from './save-template';

type IconName = keyof typeof ICONS;

/**
 * `scratch` is a template being edited on a board that is not synced or listed: it has no sharing, sync status,
 * comments, version history or Save board as template, and its home button is whatever `nav.home` does.
 */
export function mountBoardUi(app: BoardApp, root: HTMLElement, nav: { home: () => void }, opts: { scratch?: boolean } = {}) {
  const scratch = opts.scratch === true;
  const chrome = h('div', { class: 'chrome' });
  root.appendChild(chrome);
  app.notify = toast;

  // ---------------------------------------------------------------- top left
  const name = h('input', { class: 'board-name', value: app.store.getMeta().name, 'aria-label': 'Board name', spellcheck: 'false' });
  name.addEventListener('change', () => app.store.setMeta({ name: name.value.trim() || 'Untitled board' }));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
  });
  app.on('meta', () => {
    if (document.activeElement !== name) name.value = app.store.getMeta().name;
    document.title = `${app.store.getMeta().name} - Tabula`;
  });
  document.title = `${app.store.getMeta().name} - Tabula`;
  const status = h('button', { class: 'sync-status', onclick: () => openShare(app) });
  const renderStatus = () => {
    const s = app.conn.status;
    const others = app.participants().filter((p) => !p.isMe).length;
    status.dataset.state = s;
    let label = 'Local only';
    let tip = 'Sync is off. Every change is saved on this device.';
    if (s === 'live') {
      label = others ? `Live with ${others}` : 'Live';
      tip = 'Connected to the relay. Changes sync in real time.';
    } else if (s === 'connecting') {
      label = 'Saved on this device';
      tip = 'Every change is saved on this device. Waiting for the relay to sync with others.';
    } else if (s === 'denied') {
      label = app.conn.denied === 'unauthenticated' ? 'Sign in needed' : 'No access';
      tip = 'The server refused this connection. Your changes are still saved on this device.';
    }
    status.replaceChildren(icon(s === 'live' ? 'wifi' : 'cloudOff', 16), h('span', null, label));
    status.title = tip;
  };
  app.on('status', renderStatus);
  app.on('presence', renderStatus);
  renderStatus();

  const badge = h('span', { class: 'readonly-badge', role: 'status' }, 'View only');
  const homeLabel = scratch ? 'Back to templates' : 'All boards';
  const topLeft = h('div', { class: 'tray top-left' },
    h('button', { class: 'icon-btn', title: homeLabel, 'aria-label': homeLabel, onclick: nav.home }, icon('home', 18)),
    scratch ? null : name, scratch ? null : status, badge,
  );

  // ---------------------------------------------------------------- top right
  const people = h('div', { class: 'people', 'aria-label': 'People on this board' });
  const renderPeople = () => {
    const ps = app.participants().sort((a, b) => Number(b.isMe) - Number(a.isMe));
    people.replaceChildren(...ps.slice(0, 6).map((p) => h('button', {
      class: 'avatar', style: `--c:${p.user.color}`, title: p.isMe ? `${p.user.name} (you)` : `Go to ${p.user.name}`,
      'aria-label': p.isMe ? `${p.user.name} (you)` : `Go to ${p.user.name}`,
      onclick: () => (p.isMe ? openProfile(app) : app.followUser(p.clientId)),
    }, initials(p.user.name))), ...(ps.length > 6 ? [h('span', { class: 'avatar more' }, `+${ps.length - 6}`)] : []));
  };
  app.on('presence', renderPeople);
  renderPeople();
  const menuBtn = h('button', { class: 'icon-btn', title: 'Menu', 'aria-label': 'Menu' }, icon('dots', 18));
  const history = scratch ? null : mountHistory(app, chrome);
  menuBtn.addEventListener('click', () => openMenu(app, menuBtn, history?.open ?? null, scratch));
  const comments = mountComments(app, chrome);
  const topRight = h('div', { class: 'tray top-right' },
    scratch ? null : people,
    scratch ? null : comments.button,
    scratch ? null : h('button', { class: 'btn primary', onclick: () => openShare(app) }, icon('share', 16), 'Share'),
    menuBtn,
  );

  // ---------------------------------------------------------------- rail
  const library = mountLibrary(app, chrome);
  const toolBtn = (label: string, ic: IconName, tool: Tool, key: string) => {
    const b = h('button', { class: 'rail-btn', title: `${label} (${key})`, 'aria-label': label, 'aria-keyshortcuts': key, onclick: () => app.setTool(tool) }, icon(ic, 22));
    b.dataset.tool = tool.kind;
    return b;
  };
  const drawerBtn = (label: string, ic: IconName, tab: 'uml' | 'icons' | 'stickers' | 'templates') => {
    const b = h('button', { class: 'rail-btn', title: label, 'aria-label': label, onclick: () => library.open(tab) }, icon(ic, 22));
    b.dataset.drawer = tab;
    return b;
  };
  const stickyBtn = toolBtn('Sticky note', 'sticky', { kind: 'sticky' }, 'N');
  const shapesBtn = h('button', { class: 'rail-btn', title: 'Shapes', 'aria-label': 'Shapes', 'aria-haspopup': 'true', onclick: () => library.open('shapes') }, icon('shapes', 22));
  const commentBtn = toolBtn('Comment', 'comment', { kind: 'comment' }, 'C');
  const voteBtn = h('button', { class: 'rail-btn', title: 'Start a dot vote (no limit)', 'aria-label': 'Start a dot vote' }, icon('vote', 22));
  voteBtn.addEventListener('click', () => {
    if (app.flow.isVoting()) {
      toast('A dot vote is running. Change dots per person or finish it from the bar at the bottom.');
      return;
    }
    app.flow.quickVote(UNLIMITED);
    toast('Dot vote started with no limit. Click any note to add a dot.');
  });
  const syncVote = () => {
    const on = app.flow.isVoting();
    voteBtn.classList.toggle('on', on);
    voteBtn.setAttribute('aria-pressed', String(on));
  };
  app.on('flow', syncVote);
  const pollBtn = h('button', { class: 'rail-btn', title: 'Start a quick poll', 'aria-label': 'Start a quick poll' }, icon('poll', 22));
  pollBtn.addEventListener('click', () => openQuickPoll(app, pollBtn));
  const rail = h('nav', { class: 'tray rail', 'aria-label': 'Tools' },
    toolBtn('Select', 'select', { kind: 'select' }, 'V'),
    toolBtn('Hand', 'hand', { kind: 'hand' }, 'H'),
    h('hr'),
    stickyBtn,
    toolBtn('Text', 'text', { kind: 'text' }, 'T'),
    shapesBtn,
    toolBtn('Connector', 'connector', { kind: 'connector' }, 'L'),
    toolBtn('Pen', 'pen', { kind: 'pen' }, 'P'),
    toolBtn('Frame', 'frame', { kind: 'frame' }, 'F'),
    commentBtn,
    h('hr'),
    drawerBtn('UML', 'uml', 'uml'),
    drawerBtn('Icons', 'icons', 'icons'),
    drawerBtn('Stickers', 'stickers', 'stickers'),
    drawerBtn('Templates and team exercises', 'templates', 'templates'),
    voteBtn,
    pollBtn,
    h('hr'),
    h('button', { class: 'rail-btn', title: 'Undo (Ctrl/Cmd+Z)', 'aria-label': 'Undo', onclick: () => app.store.undo.undo() }, icon('undo', 22)),
    h('button', { class: 'rail-btn', title: 'Redo (Shift+Ctrl/Cmd+Z)', 'aria-label': 'Redo', onclick: () => app.store.undo.redo() }, icon('redo', 22)),
  );
  const syncRail = () => {
    rail.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => {
      const t = app.tool;
      const on = b.dataset.tool === t.kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    stickyBtn.style.setProperty('--sticky', app.stickyColor);
  };
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
  const renderStickyTray = () => {
    const show = app.tool.kind === 'sticky' && !app.readOnly;
    stickyTray.classList.toggle('show', show);
    if (!show) return;
    stickyTray.style.top = `${stickyBtn.getBoundingClientRect().top - 6}px`;
    stickyTray.replaceChildren(
      h('div', { class: 'tray-label' }, 'Note colour'),
      stickyColorField(app, app.stickyColor, (c) => {
        app.stickyColor = c;
        renderStickyTray();
      }, { label: 'Sticky note colour', size: 'lg' }),
    );
  };
  app.on('tool', renderStickyTray);
  app.on('meta', renderStickyTray);

  // Pen options appear while drawing.
  const penTray = h('div', { class: 'tray tool-tray pen-tray' });
  const penBtn = () => rail.querySelector<HTMLElement>('[data-tool="pen"]');
  const renderPen = () => {
    penTray.classList.toggle('show', app.tool.kind === 'pen' && !app.readOnly);
    const pb = penBtn();
    if (pb && app.tool.kind === 'pen') penTray.style.top = `${pb.getBoundingClientRect().top - 6}px`;
    penTray.replaceChildren(
      ...[CANVAS_INK, '#2F6FED', '#D64545', '#1E9A6A', '#C98A00', '#7A5AF8'].map((c) => h('button', { class: `swatch${app.penColor === c ? ' on' : ''}`, style: `--c:${c}`, 'aria-label': c === CANVAS_INK ? 'Pen colour ink' : `Pen colour ${c}`, onclick: () => { app.penColor = c; renderPen(); } })),
      h('hr'),
      ...[2, 4, 8].map((w) => h('button', { class: `icon-btn${app.penWidth === w ? ' on' : ''}`, 'aria-label': `Pen width ${w}`, onclick: () => { app.penWidth = w; renderPen(); } }, h('span', { class: 'pen-dot', style: `--s:${w + 2}px` }))),
    );
  };
  app.on('tool', renderPen);
  renderPen();

  // ---------------------------------------------------------------- bottom right
  const zoomLabel = h('button', { class: 'zoom-label', title: 'Reset to 100% (Shift+0)', onclick: () => app.zoomTo(1) });
  const updateZoom = () => (zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`);
  app.r.onCamera(updateZoom);
  updateZoom();
  const mini = minimap(app);
  const zoomTray = h('div', { class: 'tray zoom-tray' },
    h('button', { class: 'icon-btn', title: 'Zoom out (Ctrl/Cmd −)', 'aria-label': 'Zoom out', onclick: () => app.zoomBy(0.8) }, icon('minus', 18)),
    zoomLabel,
    h('button', { class: 'icon-btn', title: 'Zoom in (Ctrl/Cmd +)', 'aria-label': 'Zoom in', onclick: () => app.zoomBy(1.25) }, icon('plus', 18)),
    h('button', { class: 'icon-btn', title: 'Fit board (Shift+1)', 'aria-label': 'Fit board', onclick: () => app.zoomToFit() }, icon('fit', 18)),
    h('button', { class: 'icon-btn', title: 'Minimap', 'aria-label': 'Toggle minimap', onclick: (e: Event) => { mini.toggle(); (e.currentTarget as HTMLElement).classList.toggle('on', mini.visible()); } }, icon('map', 18)),
  );

  chrome.append(topLeft, topRight, rail, penTray, stickyTray, mini.el, zoomTray);
  renderStickyTray();
  const props = mountProps(app, chrome);
  mountQuickbar(app, chrome, props);
  mountFocus(app, chrome);
  mountFlowBar(app, chrome);
  if (!scratch) firstRunHint(app, chrome);

  // View-only boards keep Select and Hand; the rest of the editing chrome is disabled.
  const syncReadOnly = () => {
    const ro = app.readOnly;
    rail.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b === commentBtn) return;
      b.disabled = ro && b.dataset.tool !== 'select' && b.dataset.tool !== 'hand';
    });
    // Commenters have a read-only board but may still comment, so the tool follows the comments document.
    commentBtn.disabled = app.comments.readOnly();
    commentBtn.title = commentBtn.disabled ? 'You can\'t comment on this board' : 'Comment (C)';
    name.readOnly = ro;
    badge.textContent = boardAccess(app.role, workspaceOf(authState()), app.deleted).badge ?? 'View only';
    badge.classList.toggle('show', ro);
    if (ro && library.tab) library.open(null);
  };
  app.on('readonly', syncReadOnly);
  app.on('comments', syncReadOnly);
  app.comments.onReadOnly(syncReadOnly);
  // A hosted workspace can turn read-only (or back) while the board is open: the badge names the reason.
  app.lifetime.signal.addEventListener('abort', onAuth(syncReadOnly), { once: true });
  syncReadOnly();

  // Drop .drift / .json files onto the board to import them.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  root.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (app.readOnly) return;
    await importInto(app, file);
  });
}

async function importInto(app: BoardApp, file: File) {
  try {
    const { json } = await readBoardFile(file);
    insertImported(app, json);
    toast(`Imported ${json.objects.length} objects from ${file.name}`);
  } catch (e) {
    toast((e as Error).message);
  }
}

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function firstRunHint(app: BoardApp, chrome: HTMLElement) {
  if (app.store.cache.size || app.readOnly) return;
  const hint = h('div', { class: 'empty-hint' },
    h('p', { class: 'hint-title' }, 'An empty board'),
    h('p', null, 'Press N for a sticky note, R for a rectangle, or double-click to write. Hold Space and drag to move around.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: () => (document.querySelector('[data-drawer="templates"]') as HTMLElement)?.click() }, 'Start from a template'),
      h('button', { class: 'btn', onclick: () => openMermaidImport(app) }, 'Import Mermaid'),
    ),
  );
  chrome.appendChild(hint);
  const off = app.on('objects', () => {
    if (app.store.cache.size) {
      hint.remove();
      off();
    }
  });
}

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
    for (const o of app.store.ordered()) {
      if (!isBox(o)) continue;
      const b = boxBounds(o);
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

function openMenu(app: BoardApp, anchor: HTMLElement, openHistory: (() => void) | null, scratch: boolean) {
  const item = (ic: IconName, label: string, fn: () => void, hint?: string) =>
    h('button', { class: 'menu-item', onclick: () => { pop.close(); fn(); } }, icon(ic, 18), h('span', null, label), hint ? h('span', { class: 'menu-hint' }, hint) : null);
  // Items that change the board are disabled while it is view only.
  const writeItem = (ic: IconName, label: string, fn: () => void) => {
    const b = item(ic, label, fn);
    b.disabled = app.readOnly;
    return b;
  };
  const name = () => safeName(app.store.getMeta().name);
  const fileInput = h('input', { type: 'file', accept: '.drift,.json,application/json', hidden: true });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) importInto(app, f);
  });
  const sel = app.selection.length ? app.selection : undefined;
  const themeRows = THEMES.map((t) => {
    const check = h('span', { class: 'theme-check' });
    const row = h('button', { class: 'menu-item theme-item', role: 'menuitemradio', onclick: () => { setTheme(t.id); paintThemes(); } },
      h('div', { class: 'theme-preview', 'aria-hidden': 'true', style: `--c:${t.vars['--canvas']};--t:${t.vars['--tray']};--a:${t.vars['--signal']}` }),
      h('span', null, t.name),
      check);
    return { id: t.id, row, check };
  });
  const paintThemes = () => {
    const current = getStoredTheme();
    for (const r of themeRows) {
      const on = r.id === current;
      r.row.setAttribute('aria-checked', String(on));
      r.check.replaceChildren(on ? icon('check', 16) : '');
    }
  };
  paintThemes();
  const auth = authState();
  const account = auth.mode === 'signed-in' ? [
    h('div', { class: 'list-label' }, 'Account'),
    h('div', { style: 'display:flex;align-items:center;gap:10px;padding:8px 10px' },
      icon('user', 18),
      h('div', { style: 'min-width:0;overflow-wrap:anywhere' },
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
  ] : [];
  const showComments = item('comment', 'Show comments', () => app.setCommentsVisible(!app.commentsVisible));
  if (app.commentsVisible) showComments.append(icon('check', 16));
  const pop = popover(anchor, h('div', { class: 'menu' },
    account,
    h('div', { class: 'list-label' }, 'Board'),
    writeItem('grid', 'Board settings', () => openSettings(app)),
    scratch ? null : writeItem('templates', 'Save board as template', () => openSaveTemplate(app, 'board')),
    openHistory && canSeeHistory(app.role) ? item('history', 'Version history', openHistory) : null,
    item('user', 'Your name and colour', () => openProfile(app)),
    mutedCount(app) ? item('user', `Muted people (${mutedCount(app)})`, () => openMuted(app)) : null,
    scratch ? null : showComments,
    writeItem('upload', 'Import a board file into this board', () => fileInput.click()),
    writeItem('mermaid', 'Import Mermaid', () => openMermaidImport(app)),
    h('div', { class: 'list-label' }, 'Appearance'),
    themeRows.map((r) => r.row),
    h('div', { class: 'list-label' }, sel ? 'Export selection' : 'Export'),
    item('download', 'PNG image', async () => {
      toast('Preparing image…');
      try {
        download(await exportPng(app, sel, 2), `${name()}.png`);
      } catch (e) {
        toast((e as Error).message);
      }
    }),
    item('download', 'SVG vector', () => download(exportSvg(app, sel).svg, `${name()}.svg`, 'image/svg+xml')),
    item('download', 'Board file (.drift)', () => download(toDrift(app), `${name()}.drift`, 'application/zip'), 'Board with its sync data'),
    item('download', 'JSON snapshot', () => download(JSON.stringify(toJson(app, sel), null, 2), `${name()}.json`, 'application/json')),
    item('download', 'Markdown summary', () => download(app.flow.summaryMarkdown(), `${name()}-summary.md`, 'text/markdown')),
    item('mermaid', 'Copy as Mermaid', () => {
      const objs = sel ? [...app.store.cache.values()].filter((o) => sel.includes(o.id) || o.type === 'connector') : [...app.store.cache.values()];
      navigator.clipboard.writeText(toMermaid(objs)).then(() => toast('Mermaid copied to the clipboard'), () => toast('Clipboard is not available'));
    }),
    h('div', { class: 'list-label' }, 'Help'),
    item('menu', 'Keyboard shortcuts', () => openShortcuts()),
    fileInput,
  ), { side: 'bottom' });
}

function openShare(app: BoardApp) {
  const url = location.href;
  const relay = relayUrl();
  const input = h('input', { class: 'input', value: url, readOnly: true, 'aria-label': 'Board link' });
  const live = app.conn.status === 'live';
  const auth = authState();
  const accounts = auth.mode === 'signed-in' || (auth.mode === 'offline' && auth.me !== null);
  dialog('Share this board', h('div', { class: 'stack' },
    h('p', null, accounts
      ? 'Only people with access to this board can open this link: members of the board\'s team, and anyone it has been shared with. Add people from a team on the home screen, or share the board from there.'
      : live
        ? 'Anyone who opens this link while connected to the same relay can edit the board with you in real time. They do not need an account.'
        : relay
          ? 'The relay is not reachable right now, so this board is only on your device. Your changes are saved and will sync when the relay is back.'
          : 'Sync is turned off, so this board is only on your device. Turn on a relay in Board settings to collaborate.'),
    h('div', { class: 'copy-row' }, input, h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => { input.select(); }) }, icon('link', 16), 'Copy link')),
    h('p', { class: 'muted small' }, relay ? `Relay: ${relay.replace(/^ws/, 'http')}` : 'Relay: off'),
  ), [{ label: 'Done', primary: true }]);
}

function openProfile(app: BoardApp) {
  const u = { ...app.user };
  const name = h('input', { class: 'input', value: u.name, 'aria-label': 'Your name', maxlength: '40' });
  const colors = h('div', { class: 'swatches' }, ...USER_COLORS.map((c) => {
    const b = h('button', { class: `swatch${c === u.color ? ' on' : ''}`, style: `--c:${c}`, 'aria-label': c, onclick: () => {
      u.color = c;
      colors.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    } });
    return b;
  }));
  const accountName = authState().mode === 'signed-in';
  dialog('Your name and colour', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, accountName
      ? 'Your name comes from your account and is shown next to your cursor and on the notes you write. The colour is stored on this device.'
      : 'Shown next to your cursor and on the notes you write.'),
    field('Name', name), field('Colour', colors),
  ), [{ label: 'Cancel' }, {
    label: 'Save', primary: true, onClick: async () => {
      const auth = authState();
      const typed = name.value.trim();
      if (auth.mode === 'signed-in' && typed && typed !== u.name) {
        try {
          const updated = await api.updateMe(typed);
          setSignedIn({ ...auth.me, user: updated });
          u.name = updated.name;
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not save your name.');
          return false;
        }
      } else {
        u.name = typed || u.name;
      }
      Object.assign(app.user, u);
      saveUser(app.user);
      app.conn.awareness.setLocalStateField('user', app.user);
    },
  }]);
}

function openSettings(app: BoardApp) {
  const m = app.store.getMeta();
  const grid = segmented<GridType>([
    { value: 'dots', label: 'Dots' }, { value: 'lines', label: 'Lines' }, { value: 'iso', label: 'Isometric' }, { value: 'none', label: 'None' },
  ], m.gridType, (v) => app.store.setMeta({ gridType: v }), 'Grid type');
  const size = h('select', { class: 'input', 'aria-label': 'Grid size', onchange: (e: Event) => app.store.setMeta({ gridSize: Number((e.target as HTMLSelectElement).value) }) },
    ...[8, 12, 16, 20, 24, 32, 40, 48].map((n) => h('option', { value: n, selected: n === m.gridSize }, `${n}`)));
  const snap = h('input', { type: 'checkbox', checked: m.snap, 'aria-label': 'Snap to grid' });
  snap.addEventListener('change', () => app.store.setMeta({ snap: snap.checked }));
  const fontBtn = (key: 'headingFont' | 'bodyFont') => {
    const b = h('button', { class: 'input font-btn', style: `font-family:"${fontName(m[key])}", system-ui` }, fontName(m[key]), icon('chevron', 16));
    b.addEventListener('click', () => openFontPicker(b, app.store.getMeta()[key], (slug) => {
      app.store.setMeta({ [key]: slug });
      b.firstChild!.textContent = fontName(slug);
      b.style.fontFamily = `"${fontName(slug)}", system-ui`;
    }));
    return b;
  };
  const relay = h('input', { class: 'input', value: getRelaySetting(), placeholder: 'auto, off, or wss://relay.example.com/sync', 'aria-label': 'Relay' });
  dialog('Board settings', h('div', { class: 'stack' },
    field('Grid', grid),
    h('div', { class: 'row2' }, field('Grid size', size), field('Snap to grid', h('label', { class: 'check' }, snap, 'Snap while moving and resizing'))),
    h('div', { class: 'row2' }, field('Heading font', fontBtn('headingFont')), field('Body font', fontBtn('bodyFont'))),
    h('p', { class: 'muted small' }, 'New notes, shapes and frames use these fonts. Hold Alt while dragging to place things off the grid.'),
    field('Relay', relay),
    h('p', { class: 'muted small' }, '“auto” uses the relay that serves this app. “off” keeps every board on this device only. Changing it reloads the board.'),
  ), [{ label: 'Close', primary: true, onClick: () => {
    const v = relay.value.trim() || 'auto';
    if (v !== getRelaySetting()) {
      setRelaySetting(v);
      location.reload();
    }
  } }]);
}

function openShortcuts() {
  const rows: [string, string][] = [
    ['V', 'Select'], ['H or hold Space', 'Pan'], ['N', 'Sticky note'], ['T', 'Text'], ['R / O / D', 'Rectangle / ellipse / diamond'],
    ['L', 'Connector'], ['P', 'Pen'], ['F', 'Frame'], ['Double-click', 'Edit text, or add text on empty canvas'],
    ['Ctrl/Cmd + scroll, pinch', 'Zoom'], ['Shift+1 / Shift+2 / Shift+0', 'Fit board / fit selection / 100%'],
    ['Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z', 'Undo, redo'], ['Ctrl/Cmd+C / V / D', 'Copy, paste, duplicate'],
    ['Delete', 'Delete selection'], ['Arrows (Shift for grid steps)', 'Nudge'], ['[ and ]', 'Send back, bring forward'],
    ['Alt while dragging', 'Ignore grid and guides'], ['Shift while resizing', 'Keep proportions'], ['Shift-click while voting', 'Remove a vote'],
  ];
  dialog('Keyboard shortcuts', h('table', { class: 'shortcuts' }, ...rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, v)))), [{ label: 'Close', primary: true }]);
}
