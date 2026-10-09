#!/usr/bin/env node
// Draws the mock screenshots of docs/groups-visual.md: one PNG per state, the five themes side by side, using the themes' own
// variables from src/themes.ts and the group tokens defined below (the same ones the spec lists). Run: node scripts/groups-visual-mock.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'groups-visual');

function readThemes() {
  const src = fs.readFileSync(path.join(root, 'src', 'themes.ts'), 'utf8');
  return src.split(/\n  \{\n    id: /).slice(1).map((b) => ({
    id: b.match(/^'(\w+)'/)[1],
    vars: Object.fromEntries([...b.matchAll(/'(--[\w-]+)': '([^']+)'/g)].map((m) => [m[1], m[2]])),
  }));
}

/** The group tokens of docs/groups-visual.md: every one is built from a theme variable. */
const TOKENS = `
  --group-line: var(--wire);
  --group-member-line: var(--graphite);
  --group-hover: var(--guide);
  --group-handle: var(--paper);
  --group-dim: color-mix(in srgb, var(--canvas) 62%, transparent);
  --group-locked: var(--graphite);
  --group-chip-bg: var(--tray);
  --group-chip-ink: var(--tray-text);
  --group-chip-line: var(--tray-line);
`;

// the scene: a sticky (A), a shape (B) and a circle (C) in one group, a connector A to B, and a sticky (D) outside it
const A = { x: 40, y: 54, w: 80, h: 64 }, B = { x: 150, y: 44, w: 92, h: 56 }, C = { x: 150, y: 124, w: 50, h: 50 }, D = { x: 268, y: 70, w: 52, h: 52 };
const union = (rs) => { const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y)), x2 = Math.max(...rs.map((r) => r.x + r.w)), y2 = Math.max(...rs.map((r) => r.y + r.h)); return { x, y, w: x2 - x, h: y2 - y }; };
const G = union([A, B, C]);
const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
const rect = (r, attrs) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" ${attrs}/>`;

const item = (id) => {
  const ink = 'var(--canvas-ink)';
  if (id === 'A') return `${rect(A, 'fill="#FFE16B"')}<path d="M52 74h50M52 86h42M52 98h34" stroke="#1D1A12" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`;
  if (id === 'B') return `${rect(B, `rx="4" fill="var(--paper)" stroke="${ink}" stroke-width="1.5"`)}<path d="M166 66h58M166 80h40" stroke="${ink}" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>`;
  if (id === 'C') return `<circle cx="175" cy="149" r="25" fill="var(--paper)" stroke="${ink}" stroke-width="1.5"/><circle cx="175" cy="149" r="8" fill="${ink}" fill-opacity=".5"/>`;
  if (id === 'D') return `${rect(D, 'fill="#9BD6FF"')}<path d="M278 90h32M278 102h24" stroke="#14202B" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`;
  return `<path d="M120 80 L150 72" stroke="${ink}" stroke-width="1.5" fill="none"/><path d="M150 72 l-8 -3 l1 7z" fill="${ink}"/>`;
};
const scene = (ids = ['D', 'A', 'B', 'C', 'conn']) => ids.map(item).join('');

const handles = (r, size = 9) => {
  const xs = [r.x, r.x + r.w / 2, r.x + r.w], ys = [r.y, r.y + r.h / 2, r.y + r.h];
  let o = '';
  for (const [i, x] of xs.entries()) for (const [j, y] of ys.entries()) if (!(i === 1 && j === 1)) o += `<rect x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" rx="2" fill="var(--group-handle)" stroke="var(--group-line)" stroke-width="1.5"/>`;
  const top = { x: r.x + r.w / 2, y: r.y };
  return o + `<path d="M${top.x} ${top.y}v-18" stroke="var(--group-line)" stroke-width="1"/><circle cx="${top.x}" cy="${top.y - 24}" r="5" fill="var(--group-handle)" stroke="var(--group-line)" stroke-width="1.5"/>`;
};

/** A tray chip (the Done chip, the group's name) as SVG: tray colours, 11px Switzer-like text. */
const chip = (x, y, text, w) => `<g><rect x="${x}" y="${y}" width="${w}" height="20" fill="var(--group-chip-bg)" stroke="var(--group-chip-line)"/><text x="${x + 8}" y="${y + 14}" font-size="11" font-weight="600" fill="var(--group-chip-ink)" font-family="Switzer, system-ui, sans-serif">${text}</text></g>`;
const lockBadge = (x, y) => `<g transform="translate(${x} ${y})"><circle r="11" fill="var(--group-chip-bg)" stroke="var(--group-chip-ink)" stroke-width="1.5"/><g transform="translate(-7 -7) scale(.583)" fill="none" stroke="var(--group-chip-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></g></g>`;
const cursor = (x, y) => `<path d="M${x} ${y}l0 16 4-4 3 7 3-1.5-3-6.5h6z" fill="var(--canvas-ink)" stroke="var(--canvas)" stroke-width="1"/>`;

const single = () => scene() + rect(pad(B, 0), 'fill="none" stroke="var(--group-line)" stroke-width="1.5"') + handles(B);
const multi = () => scene() + [A, B, C].map((r) => rect(r, 'fill="none" stroke="var(--group-line)" stroke-width="1.5"')).join('') + rect(pad(G, 6), 'fill="none" stroke="var(--group-line)" stroke-width="1" stroke-dasharray="5 4"') + handles(pad(G, 6)).replace(/<path d="M[^"]*v-18[^>]*>|<circle[^>]*r="5"[^>]*>/g, '');
const groupSel = () => scene() + [A, B, C].map((r) => rect(r, 'fill="none" stroke="var(--group-member-line)" stroke-width="1"')).join('') + rect(pad(G, 6), 'fill="none" stroke="var(--group-line)" stroke-width="1.5"') + handles(pad(G, 6)) + chip(pad(G, 6).x, pad(G, 6).y - 26 + 0, 'Group · 3', 62).replace(/y="(\d+)"/, (m, y) => `y="${+y + 0}"`);
const hoverSingle = () => scene() + rect(B, 'fill="none" stroke="var(--group-hover)" stroke-width="1.5"') + cursor(206, 82);
const hoverGroup = () => scene() + rect(pad(G, 6), 'fill="none" stroke="var(--group-hover)" stroke-width="1.5"') + cursor(206, 82);
const dim = (members, scope, label, labelW) => {
  const nonMembers = ['D', 'A', 'B', 'C', 'conn'].filter((k) => !members.includes(k));
  return scene(nonMembers) + `<rect width="340" height="250" fill="var(--group-dim)"/>` + scene(members) +
    rect(pad(scope, 6), 'fill="none" stroke="var(--group-line)" stroke-width="1.5" stroke-dasharray="6 4"') +
    chip(pad(scope, 6).x, pad(scope, 6).y - 26, label, labelW) + chip(pad(scope, 6).x + pad(scope, 6).w - 74, pad(scope, 6).y - 26, 'Done · Esc', 74);
};
const inside1 = () => dim(['A', 'B', 'C', 'conn'], G, 'Header', 54);
const inside2 = () => dim(['A', 'B', 'conn'], union([A, B]), 'Header › Notes', 92);
const lockedHover = () => scene() + rect(pad(G, 6), 'fill="none" stroke="var(--group-locked)" stroke-width="1.5"') + lockBadge(pad(G, 6).x + pad(G, 6).w, pad(G, 6).y) + cursor(206, 82);
const lockedIdle = () => scene();

/** The quick-action bar on touch: Group with three notes selected, Ungroup with a group selected. 44 px targets. */
const GROUP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" stroke-dasharray="0"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>';
const UNGROUP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M14 6h4a2 2 0 012 2v2M10 18H6a2 2 0 01-2-2v-2" stroke-dasharray="2 3"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></svg>';
const COPY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const bar = (grouped) => `<div class="qbar" style="top:192px"><span class="sw"></span><span class="sep"></span><button class="b txt${grouped ? '' : ' hot'}">${grouped ? UNGROUP_ICON + 'Ungroup' : GROUP_ICON + 'Group'}</button><span class="sep"></span><button class="b">${LOCK}</button><button class="b">${COPY}</button><button class="b">${TRASH}</button></div>`;
const touchMulti = () => ({ svg: scene() + [A, B, C].map((r) => rect(r, 'fill="none" stroke="var(--group-line)" stroke-width="1.5"')).join('') + rect(pad(G, 6), 'fill="none" stroke="var(--group-line)" stroke-width="1" stroke-dasharray="5 4"') + handles(pad(G, 6), 16).replace(/<path d="M[^"]*v-18[^>]*>|<circle[^>]*r="5"[^>]*>/g, ''), html: bar(false) });
const touchGroup = () => ({ svg: scene() + [A, B, C].map((r) => rect(r, 'fill="none" stroke="var(--group-member-line)" stroke-width="1"')).join('') + rect(pad(G, 6), 'fill="none" stroke="var(--group-line)" stroke-width="1.5"') + handles(pad(G, 6), 16), html: bar(true) });

const STATES = {
  'selected': { title: 'Selected: one item, several items today, a group', rows: [['One item', single], ['Several items (today)', multi], ['A group', groupSel]] },
  'hover': { title: 'Hover before the click', rows: [['An item (today)', hoverSingle], ['A member of an unselected group', hoverGroup]] },
  'inside': { title: 'Inside a group', rows: [['Entered a group', inside1], ['Entered a group within it', inside2]] },
  'locked': { title: 'A locked group', rows: [['At rest: nothing shows (as for any locked item)', lockedIdle], ['Pointer over it', lockedHover]] },
  'touch': { title: 'Quick-action bar on touch (44 px targets, 16 px handles)', rows: [['Three notes selected: Group', touchMulti], ['A group selected: Ungroup', touchGroup]] },
};

const page = (themes, state) => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 20px; background: #fff; font: 13px system-ui, sans-serif; color: #18212B; }
  h1 { font-size: 15px; margin: 0 0 14px; }
  .row-label { font-weight: 600; margin: 14px 0 6px; }
  .row { display: flex; gap: 12px; }
  .cell { width: 340px; }
  .cell small { display: block; margin: 0 0 4px; color: #5B6672; }
  .panel { position: relative; width: 340px; height: 250px; overflow: hidden; background: var(--canvas); background-image: radial-gradient(var(--grid-dot) 1px, transparent 1px); background-size: 20px 20px; ${TOKENS} }
  .panel > svg { position: absolute; inset: 0; }
  .qbar { position: absolute; left: 24px; display: flex; align-items: center; gap: 2px; padding: 4px; background: var(--tray); color: var(--tray-text); box-shadow: 0 0 0 1px var(--tray-line); }
  .qbar .b { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 44px; height: 44px; padding: 0; border: 0; background: transparent; color: inherit; font: 600 13px system-ui, sans-serif; }
  .qbar .b.txt { padding: 0 12px; }
  .qbar .b.hot { background: var(--signal); color: var(--on-signal); }
  .qbar .sw { width: 22px; height: 22px; margin: 0 11px; background: #FFE16B; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--tray-text) 35%, transparent); }
  .qbar .sep { width: 1px; height: 20px; margin: 0 4px; background: var(--tray-line); }
</style><h1>${state.title}</h1>${state.rows.map(([label, fn]) => {
  const r = fn();
  const svg = typeof r === 'string' ? r : r.svg;
  const html = typeof r === 'string' ? '' : r.html;
  return `<div class="row-label">${label}</div><div class="row">${themes.map((t) => `<div class="cell"><small>${t.id}</small><div class="panel" style="${Object.entries(t.vars).map(([k, v]) => `${k}:${v}`).join(';')}"><svg viewBox="0 0 340 250" width="340" height="250">${svg}</svg>${html}</div></div>`).join('')}</div>`;
}).join('')}`;

const themes = readThemes();
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1800, height: 600 }, deviceScaleFactor: 2 });
for (const [name, state] of Object.entries(STATES)) {
  const p = await ctx.newPage();
  await p.setContent(page(themes, state));
  await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  await p.close();
  console.log(`docs/groups-visual/${name}.png`);
}
await browser.close();
