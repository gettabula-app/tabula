// Accessibility audit probes in headless Chromium (TAB-149; results and method in docs/accessibility-audit.md).
// No dependency beyond the pinned playwright: it checks accessible names, keyboard order and focus visibility, dialogs,
// computed colour contrast, motion and 200% / 400% zoom on named screens of the built app, in every theme, and prints JSON.
//   npm run build:app && node scripts/a11y-audit.mjs --out /tmp/a11y.json [--only names,keyboard,contrast,dialogs,motion,zoom,axe] [--axe path/to/axe.min.js]
// axe-core is not a dependency of this project. With --axe (a copy of axe.min.js from anywhere on the machine) it is
// injected into each screen and its WCAG 2.x A and AA and best-practice rules are reported next to the probes below.
// It starts its own throwaway relay (open mode) and stops it at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, axe: { type: 'string' } } });
const only = opts.only ? new Set(opts.only.split(',')) : null;
const want = (k) => !only || only.has(k);
const THEMES = ['default', 'ayu', 'kanagawa', 'matrix', 'evergreen'];

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

async function startRelay() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-a11y-'));
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TABULA_|MIRA_|PORT$|HOST$|DATA_DIR$|DIST_DIR$|QUIET$)/.test(k)));
  Object.assign(env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(root, 'dist'), QUIET: '1' });
  const child = spawn(process.execPath, [path.join(root, 'server', 'relay.mjs')], { cwd: dataDir, env, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) return { base: `http://127.0.0.1:${port}`, dataDir, child };
    await sleep(100);
  }
  throw new Error('relay did not start');
}
async function stopRelay(r) {
  r.child.kill();
  await sleep(500);
  fs.rmSync(r.dataDir, { recursive: true, force: true, maxRetries: 5 });
}

// ---------------------------------------------------------------- page-side helpers (serialised into the page)

const PAGE = {
  // The accessible name of an element, in the order the accessible name computation uses, and how weak it is.
  nameOf: `(el) => {
    const text = (n) => (n.textContent || '').replace(/\\s+/g, ' ').trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim(); if (t) return { name: t, via: 'labelledby' }; }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return { name: al.trim(), via: 'aria-label' };
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(' ').trim(); if (t) return { name: t, via: 'label' }; }
    if (el.tagName === 'INPUT' && ['button','submit'].includes(el.type) && el.value) return { name: el.value, via: 'value' };
    const own = text(el);
    const visible = [...el.querySelectorAll('[aria-hidden="true"]')].reduce((s, n) => s.replace(text(n), ''), own).trim();
    if (visible) return { name: visible, via: 'content' };
    const img = el.querySelector('img[alt]'); if (img && img.alt.trim()) return { name: img.alt.trim(), via: 'img-alt' };
    const svgt = el.querySelector('svg title'); if (svgt && text(svgt)) return { name: text(svgt), via: 'svg-title' };
    if (el.title && el.title.trim()) return { name: el.title.trim(), via: 'title' };
    const tip = el.getAttribute('data-tip'); if (tip) return { name: tip, via: 'data-tip' };
    if (el.placeholder) return { name: el.placeholder, via: 'placeholder' };
    return { name: '', via: 'none' };
  }`,
  visible: `(el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; }`,
  describe: `(el) => { const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''; return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''); }`,
};

const INTERACTIVE = `button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [role=radio], [role=slider], [role=combobox], [role=option], [role=link], [tabindex]:not([tabindex="-1"])`;

/** Interactive elements without a real accessible name, wrong roles, and click handlers on plain elements. */
async function probeNames(page) {
  return page.evaluate(({ INTERACTIVE, nameOf, visible, describe }) => {
    const nameFn = eval(nameOf), vis = eval(visible), desc = eval(describe);
    const out = { unnamed: [], weakName: [], duplicateNames: [], inputsWithoutLabel: [], imgsWithoutAlt: [], landmarks: {}, headings: [], title: document.title, lang: document.documentElement.lang, viewport: document.querySelector('meta[name=viewport]')?.content ?? null };
    const seen = new Map();
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!vis(el) || el.closest('[aria-hidden="true"]') || el.disabled) continue;
      const { name, via } = nameFn(el);
      const item = { el: desc(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), name, via };
      if (!name) out.unnamed.push(item);
      else if (['title', 'data-tip', 'placeholder'].includes(via)) out.weakName.push(item);
      const key = `${item.role}|${name}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !['aria-label', 'labelledby', 'label'].includes(via) && el.type !== 'hidden' && el.type !== 'file') out.inputsWithoutLabel.push(item);
    }
    for (const [k, n] of seen) if (n > 1) out.duplicateNames.push({ key: k, count: n });
    for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) out.imgsWithoutAlt.push(desc(img));
    for (const sel of ['main', 'nav', 'header', 'footer', 'aside', '[role=main]', '[role=navigation]', '[role=banner]', '[role=complementary]', '[role=region]', '[role=application]', 'section[aria-label]']) {
      const n = [...document.querySelectorAll(sel)].filter(vis).length;
      if (n) out.landmarks[sel] = n;
    }
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')) if (vis(h)) out.headings.push(`${h.tagName.toLowerCase()}: ${(h.textContent || '').trim().slice(0, 40)}`);
    out.clickOnPlain = [...document.querySelectorAll('div,span,li,svg,p')].filter((e) => e.onclick && vis(e) && !e.closest('button,a,[role=button]') && !e.getAttribute('role') && e.tabIndex < 0).map(desc).slice(0, 20);
    out.liveRegions = [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')].map((e) => `${desc(e)} live=${e.getAttribute('aria-live') ?? e.getAttribute('role')}`);
    return out;
  }, { INTERACTIVE, ...PAGE });
}

/** Tab through the page: the order, what has no visible focus change (pixel comparison), what is never reached. */
async function probeKeyboard(page, { max = 140, pixelCheck = true } = {}) {
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  const reached = [];
  const noFocusRing = [];
  let stuck = 0;
  let previous = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(({ nameOf, describe }) => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const nm = eval(nameOf)(el);
      return { el: eval(describe)(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), name: nm.name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth, id: el.id || null };
    }, PAGE);
    if (!info) { reached.push(null); if (reached.slice(-3).every((x) => x === null) && reached.length > 5) break; continue; }
    const key = `${info.el}|${info.name}|${info.rect.join(',')}`;
    if (key === previous) { stuck++; if (stuck > 2) { reached.push({ ...info, trap: true }); break; } } else stuck = 0;
    previous = key;
    if (reached.some((r) => r && `${r.el}|${r.name}|${r.rect.join(',')}` === key)) { reached.push({ ...info, wrapped: true }); break; }
    reached.push(info);
    if (pixelCheck && info.rect[2] > 0 && info.rect[3] > 0) {
      const pad = 6;
      const clip = { x: Math.max(0, info.rect[0] - pad), y: Math.max(0, info.rect[1] - pad), width: Math.min(info.rect[2] + pad * 2, 600), height: Math.min(info.rect[3] + pad * 2, 200) };
      if (clip.width > 0 && clip.height > 0 && info.inView) {
        const withFocus = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
        await page.evaluate(() => document.activeElement?.blur?.());
        const without = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
        await page.evaluate((id) => { const els = [...document.querySelectorAll('*')]; void els; }, null);
        if (withFocus && without && withFocus.equals(without)) noFocusRing.push({ el: info.el, name: info.name });
        // put the focus back where it was by tabbing from the element before it
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
      }
    }
  }
  // interactive elements that are visible and never got focus
  const reachedKeys = new Set(reached.filter(Boolean).map((r) => `${r.el}|${r.rect.join(',')}`));
  const all = await page.evaluate(({ INTERACTIVE, nameOf, visible, describe }) => {
    const nameFn = eval(nameOf), vis = eval(visible), desc = eval(describe);
    return [...document.querySelectorAll(INTERACTIVE)].filter((e) => vis(e) && !e.disabled && e.tabIndex >= 0 && !e.closest('[aria-hidden="true"]') && !e.closest('[inert]')).map((e) => { const r = e.getBoundingClientRect(); return { el: desc(e), name: nameFn(e).name, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; });
  }, { INTERACTIVE, ...PAGE });
  const missed = all.filter((a) => !reachedKeys.has(`${a.el}|${a.rect.join(',')}`));
  return { tabStops: reached.filter(Boolean).length, trap: reached.find((r) => r?.trap) ?? null, noFocusRing, missed: missed.slice(0, 40), missedCount: missed.length, sequence: reached.filter(Boolean).slice(0, 80).map((r) => `${r.role}:${r.name || '(no name)'}`) };
}

/** Computed text contrast of every visible text leaf against its effective background. */
async function probeContrast(page) {
  return page.evaluate(({ describe, visible }) => {
    const desc = eval(describe), vis = eval(visible);
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const bgOf = (el) => {
      const stack = [];
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e); const c = parse(cs.backgroundColor);
        if (cs.backgroundImage !== 'none' && !/^linear-gradient\(.*transparent/.test(cs.backgroundImage)) stack.push({ image: cs.backgroundImage.slice(0, 40) });
        if (c && c.a > 0) { stack.push(c); if (c.a === 1) break; }
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (const c of stack.reverse()) if (c.r !== undefined) base = over(c, base);
      return { color: base, image: stack.some((s) => s.image) };
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent || '').trim();
      if (!text) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || !vis(el) || el.closest('svg') || el.closest('[aria-hidden="true"]')) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      let fg = parse(cs.color); if (!fg) continue;
      let opacity = 1; for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      const { color: bg, image } = bgOf(el);
      fg = over({ ...fg, a: fg.a * opacity }, bg);
      const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (ratio < need) out.push({ el: desc(el), text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need, size: Math.round(size), image });
    }
    return out;
  }, PAGE);
}

/** axe-core (injected from a file outside the project) on the current page. */
async function probeAxe(page, rules) {
  if (!(await page.evaluate(() => typeof window.axe)).includes('object')) await page.addScriptTag({ path: path.resolve(opts.axe) });
  return page.evaluate(async (only) => {
    const cfg = only ? { runOnly: { type: 'rule', values: only } } : { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } };
    const r = await window.axe.run(document, { ...cfg, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')), summary: v.nodes[0]?.failureSummary?.split('\n').slice(1, 3).join(' ') }));
  }, rules ?? null);
}

/** Running animations and transitions with a duration: what reduced motion has not switched off. */
async function probeMotion(page) {
  return page.evaluate(() => document.getAnimations().map((a) => ({ type: a.constructor.name, name: a.animationName ?? a.transitionProperty ?? '', target: a.effect?.target?.tagName?.toLowerCase() + '.' + String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '').split(/\s+/)[0], duration: a.effect?.getTiming().duration, iterations: a.effect?.getTiming().iterations })).filter((a) => a.duration > 1));
}

/** Layout at a zoomed-in viewport: horizontal overflow, controls outside the window, overlapping chrome. */
async function probeZoom(page) {
  return page.evaluate(({ describe, visible }) => {
    const desc = eval(describe), vis = eval(visible);
    const iw = innerWidth, ih = innerHeight;
    const overflowX = document.documentElement.scrollWidth - iw;
    const offscreen = [];
    const rects = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=menuitem]')) {
      if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      const fixed = (() => { for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true; return false; })();
      if (r.right < 0 || r.left > iw || (fixed && (r.bottom > ih + 1 || r.right > iw + 1))) offscreen.push({ el: desc(el), fixed, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      if (fixed && r.width > 8 && r.height > 8) rects.push({ el, r });
    }
    const overlaps = [];
    const groups = [...document.querySelectorAll('.chrome > *')].filter(vis).map((e) => ({ el: e, r: e.getBoundingClientRect() }));
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i].r, b = groups[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 4 && h > 4) overlaps.push(`${desc(groups[i].el)} x ${desc(groups[j].el)} (${Math.round(w)}x${Math.round(h)})`);
    }
    const clipped = [...document.querySelectorAll('button, a, label, h1, h2, h3, .tab')].filter((e) => vis(e) && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible' && getComputedStyle(e).textOverflow !== 'ellipsis').map(desc).slice(0, 10);
    return { overflowX, offscreen: offscreen.slice(0, 20), offscreenCount: offscreen.length, overlaps, clipped, innerWidth: iw, innerHeight: ih };
  }, PAGE);
}

// ---------------------------------------------------------------- screens

async function seedBoard(page) {
  await page.waitForFunction(() => window.__board && (!window.__board.conn.provider || window.__board.conn.provider.synced), null, { timeout: 15000 });
  await page.evaluate(() => {
    const app = window.__board;
    if (app.store.get('a11y-note')) return;
    const z = app.store.topZs(6);
    app.store.transact(() => {
      app.store.create({ id: 'a11y-frame', type: 'frame', x: 0, y: 0, w: 520, h: 360, rotation: 0, z: z[0], name: 'Ideas', fill: '#E6F7EF' });
      app.store.create({ id: 'a11y-note', type: 'sticky', x: 40, y: 60, w: 160, h: 160, rotation: 0, z: z[1], fill: '#FFE16B', text: 'Reviews were fast', parent: 'a11y-frame', fontSize: 18 });
      app.store.create({ id: 'a11y-note2', type: 'sticky', x: 240, y: 60, w: 160, h: 160, rotation: 0, z: z[2], fill: '#8FE3CA', text: 'Flaky tests', parent: 'a11y-frame', fontSize: 18 });
      app.store.create({ id: 'a11y-shape', type: 'shape', kind: 'rect', x: 600, y: 80, w: 160, h: 80, rotation: 0, z: z[3], fill: '#FFFFFF', text: 'Backlog' });
      app.store.create({ id: 'a11y-link', type: 'connector', z: z[4], from: { kind: 'bound', id: 'a11y-note2', anchor: 'right' }, to: { kind: 'bound', id: 'a11y-shape', anchor: 'left' }, route: 'elbow', startHead: 'none', endHead: 'arrow' });
      app.store.create({ id: 'a11y-text', type: 'text', x: 0, y: -60, w: 320, h: 32, rotation: 0, z: z[5], text: 'Sprint retro', fontSize: 28 });
    });
    app.comments.addThread({ id: 'u1', name: 'Ana', color: '#2F6FED' }, { x: 200, y: 60, obj: 'a11y-note', fx: 1, fy: 0 }, 'Keep this one?');
    app.zoomToFit();
  });
}

async function menuItem(page, name) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name }).click();
}

const SCREENS = [
  { id: 'home', hash: '#/', ready: async (p) => { await p.locator('.home-title, .home').first().waitFor(); } },
  { id: 'templates', hash: '#/templates', ready: async (p) => { await p.locator('.tpl-card').first().waitFor(); } },
  { id: 'board', hash: '#/b/a11y', board: true },
  { id: 'board-selected', hash: '#/b/a11y', board: true, after: async (p) => { await p.evaluate(() => window.__board.setSelection(['a11y-note'])); await p.locator('.quickbar.show').waitFor(); } },
  { id: 'board-menu', hash: '#/b/a11y', board: true, after: async (p) => { await p.getByRole('button', { name: 'Menu', exact: true }).click(); await p.locator('.menu').waitFor(); } },
  { id: 'shapes-drawer', hash: '#/b/a11y', board: true, after: async (p) => { await p.getByRole('button', { name: 'Shapes', exact: true }).click(); await p.locator('.drawer.show').waitFor(); } },
  { id: 'comments-panel', hash: '#/b/a11y', board: true, after: async (p) => { await p.getByRole('button', { name: 'Comments', exact: true }).click(); await p.waitForTimeout(300); } },
  { id: 'share-dialog', hash: '#/b/a11y', board: true, after: async (p) => { await p.getByRole('button', { name: 'Share', exact: true }).click(); await p.getByRole('dialog').waitFor(); } },
  { id: 'settings-dialog', hash: '#/b/a11y', board: true, after: async (p) => { await menuItem(p, 'Board settings'); await p.getByRole('dialog').waitFor(); } },
];

async function open(browser, base, screen, { theme = 'default', width = 1280, height = 800, reduced = false, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'en-US', serviceWorkers: 'block', bypassCSP: Boolean(opts.axe), reducedMotion: reduced ? 'reduce' : 'no-preference', ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.route((u) => /^https?:$/.test(u.protocol) && u.hostname !== '127.0.0.1', (r) => r.abort());
  await ctx.addInitScript(({ themeId }) => { try { localStorage.setItem('driftboard:theme', themeId); localStorage.setItem('driftboard:user', JSON.stringify({ id: 'a11y-user', name: 'Audit', color: '#2F6FED' })); } catch { /* none */ } }, { themeId: theme });
  const page = await ctx.newPage();
  await page.goto(`${base}/${screen.board ? '?debug' : ''}${screen.hash}`);
  if (screen.board) await seedBoard(page);
  if (screen.ready) await screen.ready(page);
  if (screen.after) await screen.after(page);
  await page.waitForTimeout(350);
  return { ctx, page };
}

// dialogs and popovers: role, modality, where focus goes, trap, Escape, focus return
const DIALOGS = [
  { id: 'share', opener: (p) => p.getByRole('button', { name: 'Share', exact: true }), kind: 'dialog' },
  { id: 'board-settings', opener: (p) => p.getByRole('button', { name: 'Menu', exact: true }), then: (p) => p.getByRole('button', { name: 'Board settings' }), kind: 'dialog' },
  { id: 'keyboard-shortcuts', opener: (p) => p.getByRole('button', { name: 'Menu', exact: true }), then: (p) => p.getByRole('button', { name: 'Keyboard shortcuts' }), kind: 'dialog' },
  { id: 'save-as-template', opener: (p) => p.getByRole('button', { name: 'Menu', exact: true }), then: (p) => p.getByRole('button', { name: 'Save board as template' }), kind: 'dialog' },
  { id: 'board-menu', opener: (p) => p.getByRole('button', { name: 'Menu', exact: true }), kind: 'popover' },
  { id: 'dot-vote-poll', opener: (p) => p.getByRole('button', { name: 'Start a quick poll' }), kind: 'popover' },
];

async function probeDialog(page, d) {
  const opener = d.opener(page);
  await opener.focus();
  await opener.click();
  if (d.then) await d.then(page).click();
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog], .modal, .popover, .menu');
    if (!dlg) return null;
    const a = document.activeElement;
    return { role: dlg.getAttribute('role'), modal: dlg.getAttribute('aria-modal'), label: dlg.getAttribute('aria-label') || dlg.getAttribute('aria-labelledby'), focusInside: dlg.contains(a), focusOn: a ? `${a.tagName.toLowerCase()}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}` : null };
  });
  if (!state) return { id: d.id, opened: false };
  // does Tab stay inside?
  let leaked = null;
  for (let i = 0; i < 25 && !leaked; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => { const dlg = document.querySelector('[role=dialog], .modal, .popover, .menu'); return !dlg || dlg.contains(document.activeElement); });
    if (!inside) leaked = i + 1;
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ stillOpen: !!document.querySelector('[role=dialog], .modal, .popover'), focusOn: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName.toLowerCase() }));
  const returned = await opener.evaluate((el) => el === document.activeElement).catch(() => false);
  return { id: d.id, opened: true, ...state, tabLeavesAfter: leaked, closesOnEscape: !after.stillOpen, focusReturnsToOpener: returned, focusAfterClose: after.focusOn };
}

// what a keyboard can do on the canvas
async function probeCanvasKeyboard(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg.canvas');
    return { svgTabIndex: svg?.getAttribute('tabindex'), svgRole: svg?.getAttribute('role'), svgLabel: svg?.getAttribute('aria-label'), objectsFocusable: [...document.querySelectorAll('svg.canvas g[tabindex], svg.canvas [role=button]')].length, objectCount: window.__board?.store.cache.size ?? 0, activeAfterLoad: document.activeElement?.tagName.toLowerCase() };
  });
}

async function main() {
  const relay = await startRelay();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const result = { startedAt: new Date().toISOString(), screens: {}, dialogs: [], canvas: null, zoom: {}, motion: {}, themes: THEMES };
  try {
    // names, keyboard, contrast in every theme
    for (const screen of SCREENS) {
      result.screens[screen.id] = {};
      for (const theme of THEMES) {
        const { ctx, page } = await open(browser, relay.base, screen, { theme });
        const cell = {};
        if (want('names') && theme === 'default') cell.names = await probeNames(page);
        if (opts.axe && want('axe')) cell.axe = await probeAxe(page, theme === 'default' ? null : ['color-contrast']);
        if (want('contrast')) cell.contrast = await probeContrast(page);
        if (want('keyboard') && (theme === 'default' || theme === 'matrix') && ['home', 'board', 'board-selected', 'board-menu', 'templates', 'comments-panel'].includes(screen.id)) cell.keyboard = await probeKeyboard(page, { pixelCheck: true });
        result.screens[screen.id][theme] = cell;
        await ctx.close();
      }
      console.error('screen', screen.id);
    }
    if (want('dialogs')) {
      for (const d of DIALOGS) {
        const { ctx, page } = await open(browser, relay.base, { id: 'board', hash: '#/b/a11y', board: true });
        result.dialogs.push(await probeDialog(page, d).catch((e) => ({ id: d.id, error: String(e.message).split('\n')[0] })));
        if (d.id === 'share') result.canvas = await probeCanvasKeyboard(page);
        await ctx.close();
      }
    }
    if (want('motion')) {
      for (const reduced of [false, true]) {
        for (const id of ['home', 'board-selected', 'board-menu', 'shapes-drawer', 'share-dialog', 'comments-panel']) {
          const screen = SCREENS.find((s) => s.id === id);
          const { ctx, page } = await open(browser, relay.base, screen, { reduced });
          await page.waitForTimeout(100);
          (result.motion[reduced ? 'reduced' : 'normal'] ??= {})[id] = await probeMotion(page);
          await ctx.close();
        }
      }
    }
    if (want('zoom')) {
      for (const [label, w, h] of [['200%', 640, 360], ['400%', 320, 256]]) {
        for (const id of ['home', 'templates', 'board', 'board-menu', 'share-dialog', 'settings-dialog', 'comments-panel']) {
          const screen = SCREENS.find((s) => s.id === id);
          const { ctx, page } = await open(browser, relay.base, screen, { width: w, height: h });
          (result.zoom[label] ??= {})[id] = await probeZoom(page);
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
    await stopRelay(relay);
  }
  const text = JSON.stringify(result, null, 1);
  if (opts.out) fs.writeFileSync(opts.out, text);
  else console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
