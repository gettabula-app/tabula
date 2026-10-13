import type { BoardApp } from '../app';
import { copyMarkdownSource, copyTable } from './markdown-actions';
import { leaveOutWithheld } from '../private-select';
import type { BaseObj, ConnectorObj, Head, Obj, Route, ShapeKind, UmlRelation, VAlign } from '../types';
import { isBox, isConnector } from '../types';
import { isSticker } from '../stickers';
import { h, icon } from './dom';
import { field, segmented, swatches } from './common';
import { FILLS, STROKES, TEXT_COLORS, colorName } from '../palette';
import { stickyColorField } from './colors';
import { SHAPE_GROUPS, SHAPE_KINDS, HEADS, connectorHeadPreviewSvg } from '../shapes';
import { RELATIONS } from '../uml';
import { DEFAULTS, styleOf } from '../markup';
import { fontName, getCatalogue, nearestWeight } from '../fonts';
import { openFontPicker } from './fontpicker';
import { CUSTOM_SIZE, FRAME_MAX, FRAME_MIN, FRAME_PRESETS, presetFor } from './frame-sizes';
import { closeOpenCombo, combo, numberField, switchRow } from './controls';
import { CODE } from '../code-layout';
import { CODE_STRINGS } from '../code-strings';
import { rememberCodeLang } from '../code-ui-logic';
import { openCodeLangPicker } from './code-lang-picker';
import { copyCodeSource } from './markdown-actions';
import { MAX_CODE_TITLE, codeLangLabel } from '../../shared/code-langs.mjs';
import { toMermaid } from '../mermaid';
import { toast } from './common';
import { safeColor } from '../../shared/colors';
import { LABEL_COLORS, LIMITS, kanbanColor } from '../../shared/containers';
import { editCards } from '../containers';
import { cleanProposedBy } from '../safe-obj';
import { proposedLine } from '../ai-review';
import { kanbanSwatch } from '../markup';

const TYPE_LABEL: Record<string, string> = {
  shape: 'Shape', sticky: 'Sticky note', text: 'Text', markdown: 'Markdown block', code: CODE_STRINGS.heading, frame: 'Frame', group: 'Group', icon: 'Icon', image: 'Image', path: 'Drawing', connector: 'Connector', container: 'Container', lane: 'Lane', card: 'Card',
  'uml-class': 'Class', 'uml-actor': 'Actor', 'uml-usecase': 'Use case', 'uml-lifeline': 'Lifeline', 'uml-note': 'Note',
  'uml-package': 'Package', 'uml-state': 'State', 'uml-initial': 'Initial node', 'uml-final': 'Final node', 'uml-component': 'Component',
};

export const HAS_TEXT = (o: Obj) => isBox(o) && ['shape', 'sticky', 'text', 'markdown', 'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component'].includes(o.type);
export const HAS_FILL = (o: Obj) => isBox(o) && ['shape', 'markdown', 'frame', 'uml-class', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component', 'uml-final'].includes(o.type);
export const HAS_STROKE = (o: Obj) => isConnector(o) || (isBox(o) && !isSticker(o) && ['shape', 'path', 'icon', 'uml-class', 'uml-actor', 'uml-usecase', 'uml-lifeline', 'uml-note', 'uml-package', 'uml-state', 'uml-component', 'uml-initial', 'uml-final'].includes(o.type));

/** Font size steps by 1, or 10 with Shift. */
const FONT_SIZE_STEPS = { min: 6, max: 400, step: 1, big: 10 };
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extralight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black' };
const COLLAPSED_SECTIONS_KEY = 'driftboard:props-sections-collapsed';

function loadCollapsedSections(): Set<string> {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(COLLAPSED_SECTIONS_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(value) ? value.filter((item): item is string => ['Appearance', 'Text', 'Arrange'].includes(item)) : []);
  } catch { return new Set(); }
}

const collapsedSections = loadCollapsedSections();

export function mountProps(app: BoardApp, parent: HTMLElement) {
  const panel = h('aside', { class: 'props tray', 'aria-label': 'Selection properties' });
  parent.appendChild(panel);
  let open = false;
  // phones only (styles.css shows the button below 860px): the panel folds to its title row and stays folded across selections
  let folded = false;
  const toggled: (() => void)[] = [];
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(render, 30);
  };
  app.on('selection', schedule);
  app.on('meta', schedule);
  app.on('objects', () => {
    // never rebuild while the user is typing in the panel, or while a control previews a value (it would close)
    if (app.styleEdit.active) return;
    if (panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    schedule();
  });
  app.styleEdit.onEnd(schedule);

  let generation = 0;

  function render() {
    // never rebuild under a live preview (a list, the font picker, a wheel burst): the control would vanish and its
    // preview with it. The preview's end (commit or revert) schedules the rebuild that was skipped.
    if (app.styleEdit.active) return;
    closeOpenCombo();
    const gen = ++generation;
    const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute('aria-label') : null;
    const sel = app.selected();
    const show = open && sel.length > 0 && !app.readOnly;
    panel.classList.toggle('show', show);
    if (!show) {
      panel.replaceChildren();
      return;
    }
    const first = sel[0];
    const same = sel.every((o) => o.type === first.type);
    const title = sel.length === 1 ? (isSticker(first) ? 'Sticker' : TYPE_LABEL[first.type] ?? 'Object') : `${sel.length} selected`;
    const styleSel = app.selectedLeaves();
    const styleFirst = styleSel[0] ?? first;
    const styleSame = styleSel.length > 0 && styleSel.every((o) => o.type === styleFirst.type);
    const s = styleOf(styleFirst);
    const up = (patch: Record<string, unknown>, filter?: (o: Obj) => boolean) => app.updateSelected(patch, filter);
    const upLeaves = (patch: Record<string, unknown>, filter?: (o: Obj) => boolean) => app.updateSelectedLeaves(patch, filter);
    const edit = app.styleEdit;
    /** Live preview, revert and commit of one patch shape, for a control. */
    // a control from an earlier render (a stray timer) must not write to whatever is selected now
    const current = () => gen === generation;
    const live = <T,>(toPatch: (v: T) => Record<string, unknown>, filter?: (o: Obj) => boolean) => ({
      onPreview: (v: T) => current() && edit.preview(toPatch(v), filter),
      onCommit: (v: T) => current() && edit.commit(toPatch(v), filter),
      onRevert: () => current() && edit.revert(),
    });
    /** The value every matching selected object shares, or null when they differ (shown as "Mixed"). */
    const shared = <T,>(read: (o: Obj) => T, filter: (o: Obj) => boolean = () => true): T | null => {
      const vals = sel.filter(filter).map(read);
      return vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null;
    };
    const sharedLeaves = <T,>(read: (o: Obj) => T, filter: (o: Obj) => boolean = () => true): T | null => {
      const vals = styleSel.filter(filter).map(read);
      return vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null;
    };
    const appearance: (HTMLElement | null)[] = [];
    const text: (HTMLElement | null)[] = [];
    const arrange: (HTMLElement | null)[] = [];

    // ---- type-specific
    if (styleSame && styleFirst.type === 'sticky') {
      const isSticky = (o: Obj) => o.type === 'sticky';
      appearance.push(field('Colour', stickyColorField(app, (styleFirst as BaseObj).fill ?? DEFAULTS.sticky.fill, (v) => {
        app.stickyColor = v;
        upLeaves({ fill: v }, isSticky);
      }, {
        // live preview while the colour picker is open
        onLive: (v) => app.store.transact(() => app.selectedLeaves().filter(isSticky).forEach((o) => app.store.update(o.id, { fill: v }))),
      })));
    }
    if (same && first.type === 'shape') {
      const kinds = SHAPE_GROUPS.flatMap(([group, label]) => SHAPE_KINDS.filter((k) => k.group === group).map((k) => ({ value: k.kind, label: k.label, group: label })));
      appearance.push(field('Shape', combo<ShapeKind>({
        label: 'Shape', options: kinds, value: shared((o) => (o as BaseObj).kind ?? 'rect'),
        ...live((v) => ({ kind: v }), (o) => o.type === 'shape'),
      })));
    }
    if (same && first.type === 'code' && sel.length === 1) {
      // Language (a searchable list), Title, then the two switches; the theme is not a setting (docs/code-blocks.md)
      const code = first as BaseObj;
      const lang = typeof code.lang === 'string' ? code.lang : 'plaintext';
      const langBtn = h('button', { class: 'input combo code-lang-btn', type: 'button', 'aria-label': `${CODE_STRINGS.language}: ${codeLangLabel(lang)}`, 'aria-haspopup': 'dialog' },
        h('span', { class: 'combo-value' }, codeLangLabel(lang)), icon('chevron', 16));
      langBtn.addEventListener('click', () => openCodeLangPicker(langBtn, lang, (id) => {
        rememberCodeLang(app.conn.id, id);
        up({ lang: id });
      }));
      appearance.push(field(CODE_STRINGS.language, langBtn));
      const title = h('input', { class: 'input', value: code.title ?? '', 'aria-label': CODE_STRINGS.title, placeholder: CODE_STRINGS.untitled, maxlength: String(MAX_CODE_TITLE), autocomplete: 'off', spellcheck: 'false' });
      title.addEventListener('change', () => up({ title: title.value.trim() ? title.value.slice(0, MAX_CODE_TITLE) : undefined }));
      appearance.push(field(CODE_STRINGS.title, title));
      appearance.push(switchRow(CODE_STRINGS.lines, code.lines === true, (on) => up({ lines: on })));
      appearance.push(switchRow(CODE_STRINGS.wrap, code.wrap === true, (on) => up({ wrap: on })));
      arrange.push(field('Width', numberField({
        label: 'Width', value: Math.round(code.w), min: CODE.MIN_W, max: 2400, step: 1, big: 10,
        ...live((v: number) => ({ w: v }), (o) => o.type === 'code'),
      })));
    }
    if (same && first.type === 'frame' && sel.length === 1) {
      const name = h('input', { class: 'input', value: (first as BaseObj).name ?? '', 'aria-label': 'Frame name' });
      name.addEventListener('change', () => up({ name: name.value }));
      appearance.push(field('Name', name));
      arrange.push(frameSizeFields(app, first as BaseObj));
    }
    if (same && first.type === 'uml-class') {
      const kinds = [['', 'Class'], ['interface', 'Interface'], ['abstract', 'Abstract'], ['enumeration', 'Enumeration'], ['entity', 'Entity'], ['service', 'Service']]
        .map(([value, label]) => ({ value, label }));
      appearance.push(field('Kind', combo<string>({
        label: 'Stereotype', options: kinds, value: shared((o) => (o as BaseObj).stereotype ?? ''),
        ...live((v) => ({ stereotype: v || undefined }), (o) => o.type === 'uml-class'),
      })));
      if (sel.length === 1) appearance.push(h('button', { class: 'btn wide', onclick: () => app.editor.start(first.id) }, 'Edit name and members'));
    }

    if (sel.every(isConnector)) appearance.push(...connectorFields(app, sel as ConnectorObj[]));
    appearance.push(...kanbanFields(app, sel));

    // ---- fill & stroke
    if (styleSel.some(HAS_FILL)) {
      appearance.push(field('Fill', swatches(FILLS, s.fill, (v) => upLeaves({ fill: v }, HAS_FILL), { label: 'Fill colour' })));
    }
    if (styleSel.some(HAS_STROKE)) {
      const isIcon = styleSame && styleFirst.type === 'icon';
      const lineValue = isIcon ? safeColor((styleFirst as BaseObj).textColor, s.stroke) : s.stroke;
      const setLine = (v: string) => {
        if (isIcon) return upLeaves({ textColor: v });
        app.store.undo.stopCapturing();
        app.store.transact(() => styleSel.filter(HAS_STROKE).forEach((o) => app.store.update(o.id, o.type === 'icon' ? { textColor: v } : { stroke: v })));
        app.store.undo.stopCapturing();
      };
      appearance.push(field(isIcon ? 'Colour' : 'Line', swatches(STROKES.filter((c) => !isIcon || c.value !== 'none'), lineValue, (v) => {
        setLine(v);
      }, { label: 'Line colour' })));
      if (!isIcon) {
        appearance.push(h('div', { class: 'row2' },
          field('Width', segmented([1, 2, 3, 4, 6].map((w) => ({ value: w, label: `${w}px`, icon: h('span', { class: 'line-sample', style: `--w:${w}px` }) })), (styleFirst as BaseObj).strokeWidth ?? s.strokeWidth, (v) => upLeaves({ strokeWidth: v }, HAS_STROKE), 'Line width')),
        ));
        if (!styleSel.every((o) => o.type === 'path')) {
          appearance.push(field('Style', segmented([
            { value: 'solid', label: 'Solid', icon: h('span', { class: 'dash-sample solid' }) },
            { value: 'dashed', label: 'Dashed', icon: h('span', { class: 'dash-sample dashed' }) },
            { value: 'dotted', label: 'Dotted', icon: h('span', { class: 'dash-sample dotted' }) },
          ], (styleFirst as BaseObj).dash ?? 'solid', (v) => upLeaves({ dash: v }, HAS_STROKE), 'Line style')));
        }
      }
    }

    // ---- text
    if (styleSel.some(HAS_TEXT)) {
      const fb = h('button', { class: 'input font-btn', style: `font-family:"${fontName(s.font)}", system-ui`, 'aria-label': `Font: ${fontName(s.font)}` }, h('span', { class: 'font-name' }, fontName(s.font)), icon('chevron', 16));
      fb.addEventListener('click', () => {
        const used = [...new Set([...app.store.cache.values()].map((o) => (o as BaseObj).font).filter(Boolean))] as string[];
        const fontPatch = (slug: string) => ({ font: slug, fontWeight: nearestWeight(slug, s.fontWeight) });
        openFontPicker(fb, s.font, (slug) => edit.commit(fontPatch(slug), HAS_TEXT), {
          pinned: used,
          onPreview: (slug) => edit.preview(fontPatch(slug), HAS_TEXT),
          onRevert: () => edit.revert(),
        });
      });
      text.push(field('Font', fb));
      const entry = getCatalogue().find((f) => f.slug === s.font);
      const weights = entry?.weights ?? [400, 500, 700];
      const size = numberField({
        label: 'Font size', value: sharedLeaves((o) => styleOf(o).fontSize, HAS_TEXT), ...FONT_SIZE_STEPS,
        ...live((v: number) => ({ fontSize: v }), HAS_TEXT),
      });
      const weight = combo<number>({
        label: 'Font weight', value: sharedLeaves((o) => nearestWeight(s.font, styleOf(o).fontWeight), HAS_TEXT),
        options: weights.map((w) => ({ value: w, label: WEIGHT_NAMES[w] ?? String(w), style: `font-family:"${fontName(s.font)}", system-ui;font-weight:${w}` })),
        ...live((v) => ({ fontWeight: v }), HAS_TEXT),
      });
      text.push(h('div', { class: 'row2' }, field('Size', size), field('Weight', weight)));
      // a Markdown block always reads from the left: its alignment is not a choice
      if (styleSel.some((o) => o.type !== 'markdown')) {
        text.push(field('Align', segmented([
          { value: 'left', label: 'Align left', icon: icon('alignLeft', 16) },
          { value: 'center', label: 'Align centre', icon: icon('alignCenterH', 16) },
          { value: 'right', label: 'Align right', icon: icon('alignRight', 16) },
        ], s.align, (v) => upLeaves({ align: v }, (o) => HAS_TEXT(o) && o.type !== 'markdown'), 'Text alignment')));
      }
      if (styleSel.some((o) => o.type === 'shape' || o.type === 'sticky')) {
        text.push(field('Vertical', segmented<VAlign>([
          { value: 'top', label: 'Align top', icon: icon('alignTop', 16) },
          { value: 'middle', label: 'Align middle', icon: icon('alignMiddleV', 16) },
          { value: 'bottom', label: 'Align bottom', icon: icon('alignBottom', 16) },
        ], s.valign, (v) => upLeaves({ valign: v }, (o) => o.type === 'shape' || o.type === 'sticky'), 'Vertical alignment')));
      }
      text.push(field('Text colour', swatches(TEXT_COLORS.map((c) => ({ name: colorName(c), value: c })), s.textColor, (v) => upLeaves({ textColor: v }, HAS_TEXT), { label: 'Text colour' })));
    }

    // ---- opacity
    if (styleSel.length) appearance.push(field('Opacity', numberField({
      label: 'Opacity', unit: '%', min: 10, max: 100, step: 1, big: 10,
      value: sharedLeaves((o) => Math.round((o.opacity ?? 1) * 100)),
      ...live((v: number) => ({ opacity: v >= 100 ? undefined : v / 100 })),
    })));

    // ---- arrange
    const boxes = sel.filter(isBox).length;
    if (boxes >= 2) {
      arrange.push(field('Align', h('div', { class: 'btn-row' },
        btn('alignLeft', 'Align left edges', () => app.align('left')),
        btn('alignCenterH', 'Align centres horizontally', () => app.align('centerH')),
        btn('alignRight', 'Align right edges', () => app.align('right')),
        btn('alignTop', 'Align top edges', () => app.align('top')),
        btn('alignMiddleV', 'Align centres vertically', () => app.align('middleV')),
        btn('alignBottom', 'Align bottom edges', () => app.align('bottom')),
        boxes >= 3 ? btn('distributeH', 'Distribute horizontally', () => app.distribute('h')) : null,
        boxes >= 3 ? btn('distributeV', 'Distribute vertically', () => app.distribute('v')) : null,
      )));
    }
    const locked = sel.every((o) => o.locked);
    const groupReason = app.groupReason();
    const canUngroup = app.canUngroupSelection();
    arrange.push(h('div', { class: 'btn-row arrange' },
      h('button', {
        class: 'icon-btn', 'aria-label': 'Group', 'data-tip': groupReason ?? 'Group', 'data-tip-key': 'mod+g', disabled: groupReason !== null,
        onclick: () => app.groupSelection(),
      }, icon('group', 18)),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Ungroup', 'data-tip': canUngroup ? 'Ungroup' : 'Select one or more groups to ungroup', 'data-tip-key': 'mod+shift+g', disabled: !canUngroup,
        onclick: () => app.ungroupSelection(),
      }, icon('ungroup', 18)),
      btn('front', 'Bring to front', () => app.bringToFront(), '', ']'),
      btn('forward', 'Bring forward', () => void app.bringForward(), '', 'mod+]'),
      btn('backward', 'Send backward', () => void app.sendBackward(), '', 'mod+['),
      btn('back', 'Send to back', () => app.sendToBack(), '', '['),
      sel.length === 1 && sel[0].type === 'markdown' ? btn('copy', 'Copy as Markdown', () => copyMarkdownSource((sel[0] as BaseObj).text ?? '')) : null,
      sel.length === 1 && sel[0].type === 'code' ? btn('copy', CODE_STRINGS.copy, () => copyCodeSource((sel[0] as BaseObj).text ?? '')) : null,
      sel.length === 1 && sel[0].type === 'table' ? btn('copy', 'Copy for a spreadsheet', () => copyTable(sel[0] as unknown as Record<string, unknown>, 'tsv')) : null,
      sel.length === 1 && sel[0].type === 'table' ? btn('copy', 'Copy as Markdown', () => copyTable(sel[0] as unknown as Record<string, unknown>, 'markdown')) : null,
      btn('dup', 'Duplicate', () => app.duplicate(), '', 'mod+d'),
      btn(locked ? 'unlock' : 'lock', locked ? 'Unlock' : 'Lock', () => app.toggleLock()),
      sel.some((o) => o.type === 'uml-class' || o.type === 'shape') ? btn('mermaid', 'Copy as Mermaid', () => {
        const ids = new Set(app.selection);
        const objs = leaveOutWithheld([...app.store.cache.values()].filter((o) => ids.has(o.id) || (isConnector(o) && o.from.kind === 'bound' && o.to.kind === 'bound' && ids.has(o.from.id) && ids.has(o.to.id))), app.flow);
        navigator.clipboard.writeText(toMermaid(objs)).then(() => toast('Mermaid copied to the clipboard'), () => toast('Clipboard is not available'));
      }) : null,
      btn('trash', 'Delete', () => app.deleteSelection(), 'danger', 'delete'),
    ));

    const fold = h('button', {
      class: 'icon-btn props-fold', 'data-tip': folded ? 'Show properties' : 'Fold properties', 'aria-label': folded ? 'Show properties' : 'Fold properties', 'aria-expanded': String(!folded),
      style: folded ? 'transform: rotate(180deg)' : '',
      onclick: () => {
        folded = !folded;
        panel.classList.toggle('folded', folded);
        render();
        panel.querySelector<HTMLElement>('.props-fold')?.focus();
        toggled.forEach((f) => f());
      },
    }, icon('chevron', 18));
    // where an object an AI run proposed came from (TAB-160): stored data, cleaned, and set as text
    const origin = sel.length === 1 ? proposedLine(cleanProposedBy((first as BaseObj).proposedBy)) : null;
    if (origin) appearance.push(h('p', { class: 'props-origin' }, origin));
    const section = (label: 'Appearance' | 'Text' | 'Arrange', controls: (HTMLElement | null)[]) => {
      const contents = controls.filter(Boolean) as HTMLElement[];
      if (!contents.length) return null;
      const closed = collapsedSections.has(label);
      const body = h('div', { class: 'props-section-body', hidden: closed }, ...contents);
      const head = h('button', {
        class: 'props-section-toggle', type: 'button', 'aria-expanded': String(!closed),
        onclick: () => {
          if (collapsedSections.has(label)) collapsedSections.delete(label);
          else collapsedSections.add(label);
          try { sessionStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsedSections])); } catch { /* collapse state is a convenience */ }
          const expanded = !collapsedSections.has(label);
          head.setAttribute('aria-expanded', String(expanded));
          body.hidden = !expanded;
        },
      }, h('span', null, label), icon('chevron', 14));
      return h('section', { class: 'props-section', 'aria-label': `${label} properties` }, head, body);
    };
    const sections = [section('Appearance', appearance), section('Text', text), section('Arrange', arrange)].filter((item): item is HTMLElement => item !== null);
    panel.replaceChildren(
      h('div', { class: 'props-head' }, h('span', { class: 'panel-grabber', 'aria-hidden': 'true' }), h('h2', null, title), h('div', null, fold, h('button', { class: 'icon-btn', 'data-tip': 'Close', 'aria-label': 'Close properties', onclick: () => toggle() }, icon('close', 18)))),
      ...sections,
    );
    panel.classList.toggle('folded', folded);
    // keep keyboard focus on the same control across the rebuild that follows each change
    if (focused) panel.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`)?.focus();
  }
  function toggle() {
    open = !open;
    render();
    toggled.forEach((f) => f());
  }
  render();
  return { el: panel, toggle, isOpen: () => open, onToggle: (fn: () => void) => { toggled.push(fn); } };
}

function btn(name: Parameters<typeof icon>[0], label: string, onClick: () => void, cls = '', key?: string) {
  return h('button', { class: `icon-btn ${cls}`, 'aria-label': label, 'data-tip-key': key, onclick: onClick }, icon(name, 18));
}

/** Size of a frame: a preset list (screens, tablets, phone, paper, square) and exact width and height. */
function frameSizeFields(app: BoardApp, frame: BaseObj): HTMLElement {
  const id = frame.id;
  const edit = app.styleEdit;
  const only = (o: Obj) => o.id === id;
  const size = () => {
    const o = app.store.get(id) as BaseObj | undefined;
    return { w: o?.w ?? frame.w, h: o?.h ?? frame.h };
  };
  const live = <T,>(toPatch: (v: T) => Record<string, unknown> | null) => ({
    onPreview: (v: T) => { const p = toPatch(v); if (p) edit.preview(p, only); },
    onCommit: (v: T) => { const p = toPatch(v); if (p) edit.commit(p, only); },
    onRevert: () => edit.revert(),
  });
  const preset = (v: string) => {
    const p = FRAME_PRESETS.find((x) => x.id === v);
    return p ? { w: p.w, h: p.h } : null;
  };
  const options = [
    ...FRAME_PRESETS.map((p) => ({ value: p.id, label: p.label, group: p.group })),
    { value: CUSTOM_SIZE, label: 'Custom', group: 'Custom' },
  ];
  const dim = (key: 'w' | 'h', label: string) => numberField({
    label, value: size()[key], min: FRAME_MIN, max: FRAME_MAX, step: 1, ...live((v: number) => ({ [key]: v })),
  } as Parameters<typeof numberField>[0]);
  const wrap = h('div', { class: 'frame-size' });
  const sizeCombo = combo<string>({
    label: 'Frame size', options, value: presetFor(size().w, size().h),
    ...live(preset),
    onCommit: (v) => {
      const p = preset(v);
      if (p) edit.commit(p, only);
      else wrap.querySelector<HTMLInputElement>('.num-field')?.focus();
    },
  });
  wrap.append(
    field('Size', sizeCombo),
    h('div', { class: 'row2' }, field('Width', dim('w', 'Frame width')), field('Height', dim('h', 'Frame height'))),
  );
  return wrap;
}

function connectorFields(app: BoardApp, sel: ConnectorObj[]): HTMLElement[] {
  const c = sel[0];
  const up = (p: Partial<ConnectorObj>) => app.updateSelected(p, isConnector);
  const out: HTMLElement[] = [];
  out.push(field('Route', segmented<Route>([
    { value: 'straight', label: 'Straight' }, { value: 'elbow', label: 'Elbow' }, { value: 'curved', label: 'Curved' },
  ], c.route, (v) => {
    up({ route: v });
    app.connectorDefaults.route = v;
  }, 'Connector route')));
  const edit = app.styleEdit;
  const same = <T,>(read: (x: ConnectorObj) => T): T | null => (sel.every((x) => read(x) === read(c)) ? read(c) : null);
  const headSel = (key: 'startHead' | 'endHead', label: string) => combo<Head>({
    label, options: HEADS.map((x) => ({
      value: x.head, label: x.label,
      icon: h('span', { class: 'connector-head-preview', 'aria-hidden': 'true', html: connectorHeadPreviewSvg(x.head, key === 'startHead' ? 'start' : 'end') }),
    })), value: same((x) => x[key]),
    onPreview: (v) => edit.preview({ [key]: v, relation: undefined }, isConnector),
    onRevert: () => edit.revert(),
    onCommit: (v) => {
      edit.commit({ [key]: v, relation: undefined }, isConnector);
      app.connectorDefaults[key] = v;
    },
  });
  out.push(h('div', { class: 'row2' }, field('Start', headSel('startHead', 'Start arrowhead')), field('End', headSel('endHead', 'End arrowhead'))));
  const relPatch = (v: UmlRelation | '') => {
    if (!v) return { relation: undefined };
    const r = RELATIONS[v];
    return { relation: v, startHead: r.startHead, endHead: r.endHead, dash: r.dash };
  };
  out.push(field('UML relationship', combo<UmlRelation | ''>({
    label: 'UML relationship', value: same((x) => x.relation ?? ''),
    options: [{ value: '', label: 'None' }, ...Object.entries(RELATIONS).map(([k, r]) => ({ value: k as UmlRelation, label: r.label }))],
    onPreview: (v) => edit.preview(relPatch(v), isConnector),
    onRevert: () => edit.revert(),
    onCommit: (v) => edit.commit(relPatch(v), isConnector),
  })));
  if (sel.length === 1) {
    const lab = h('input', { class: 'input', value: c.label ?? '', placeholder: 'Add a label', 'aria-label': 'Connector label' });
    lab.addEventListener('change', () => up({ label: lab.value || undefined }));
    out.push(field('Label', lab));
  }
  out.push(h('button', { class: 'btn wide', onclick: () => {
    app.store.transact(() => {
      for (const o of sel) app.store.update(o.id, { from: o.to, to: o.from, startHead: o.endHead, endHead: o.startHead });
    });
  } }, 'Reverse direction'));
  return out;
}

/**
 * Kanban entries (docs/kanban.md): a card's Open and accent colour and Turn into sticky; stickies' Turn into card and
 * Make kanban; a kanban's name and its Labels. Accent colours are palette keys, written through kanbanColor.
 */
function kanbanFields(app: BoardApp, sel: Obj[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const cards = sel.filter((o): o is BaseObj => o.type === 'card');
  const stickies = sel.filter((o) => o.type === 'sticky');
  if (cards.length === sel.length && cards.length) {
    if (cards.length === 1) out.push(h('button', { class: 'btn wide', onclick: () => app.openCardDialog(cards[0].id) }, 'Open card'));
    const cur = cards.every((c) => kanbanColor(c.fill) === kanbanColor(cards[0].fill)) ? kanbanColor(cards[0].fill) ?? 'none' : undefined;
    const colours = [{ name: 'None', value: 'none' }, ...LABEL_COLORS.map((k) => ({ name: k[0].toUpperCase() + k.slice(1), value: kanbanSwatch(k)! }))];
    out.push(field('Accent', swatches(colours, cur === undefined ? undefined : cur === 'none' ? 'none' : kanbanSwatch(cur), (v) => {
      const key = v === 'none' ? null : LABEL_COLORS.find((k) => kanbanSwatch(k) === v) ?? null;
      editCards(app.store, cards.map((c) => c.id), { fill: key });
    }, { label: 'Card accent colour' })));
    out.push(h('button', { class: 'btn wide', onclick: () => app.turnIntoStickies() }, cards.length === 1 ? 'Turn into sticky' : 'Turn into stickies'));
  }
  if (stickies.length && stickies.length === sel.length) {
    if (app.canTurnIntoCards()) out.push(h('button', { class: 'btn wide', onclick: () => app.turnIntoCards() }, stickies.length === 1 ? 'Turn into card' : 'Turn into cards'));
    if (stickies.length >= 2 && !app.readOnly) out.push(h('button', { class: 'btn wide', onclick: () => app.makeKanbanFromSelection() }, 'Make kanban from selection'));
  }
  if (sel.length === 1 && sel[0].type === 'container') {
    const c = sel[0] as BaseObj;
    const name = h('input', { class: 'input', maxlength: LIMITS.containerName, 'aria-label': 'Kanban name' });
    name.value = c.name ?? '';
    name.addEventListener('change', () => {
      const v = name.value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.containerName);
      if (v && !c.locked) app.updateSelected({ name: v }, (o) => o.type === 'container');
      else name.value = c.name ?? '';
    });
    out.push(field('Name', name));
    out.push(h('button', { class: 'btn wide', onclick: () => app.openLabels?.() }, 'Labels…'));
  }
  return out;
}
