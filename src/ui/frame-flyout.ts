import './frame-presets.css';
import { segmented } from './common';
import { h, icon } from './dom';
import { FRAME_GROUP_LABELS, FRAME_PRESETS, frameOrientation, presetChoiceId, presetSize, rememberFrameOrientation, type FrameOrientation, type FramePreset, type FramePresetGroup } from './frame-presets';
import { FRAME_MAX, FRAME_MIN } from './frame-sizes';

/** The height of a size glyph in px; its width follows the size's proportions. */
const GLYPH_HEIGHT = 14;
const GROUPS: FramePresetGroup[] = ['paper', 'screen', 'social'];

/** A whole number of units within the frame limits, or undefined. */
function parseSide(raw: string): number | undefined {
  const n = Math.round(Number(raw));
  return raw.trim() !== '' && Number.isFinite(n) && n >= FRAME_MIN && n <= FRAME_MAX ? n : undefined;
}

/**
 * The Frame flyout's body: the Portrait | Landscape toggle, the draw tool, the Paper, Screens and Social sizes, and Custom W x H inputs.
 * `choose` picks a choice of the Frame group (the draw tool, or a size, which places a frame in the view); picking closes the flyout.
 * `placeCustom` places a frame of a typed size (Enter in the inputs); it is only called with both sides in range.
 */
export function frameFlyoutBody(choose: (choiceId: string) => void, placeCustom: (size: { w: number; h: number }) => void): HTMLElement {
  const rows: { preset: FramePreset; glyph: HTMLElement; size: HTMLElement }[] = [];
  /** Shows each size under the toggle: the glyph's proportions and the pixel size. */
  const paint = () => {
    for (const row of rows) {
      const size = presetSize(row.preset, frameOrientation());
      row.glyph.style.width = `${Math.round(GLYPH_HEIGHT * size.w / size.h)}px`;
      row.size.textContent = `${size.w} x ${size.h}`;
    }
  };
  const sizeRow = (preset: FramePreset) => {
    const glyph = h('span', { class: 'frame-glyph' });
    const size = h('span', { class: 'menu-hint' });
    rows.push({ preset, glyph, size });
    return h('button', {
      class: 'menu-item frame-row', type: 'button', role: 'menuitem', 'data-tip': preset.hint,
      onclick: () => choose(presetChoiceId(preset)),
    }, h('span', { class: 'frame-glyph-slot', 'aria-hidden': 'true' }, glyph), h('span', null, preset.label), size);
  };
  const orient = segmented<FrameOrientation>(
    [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }],
    frameOrientation(),
    (value) => {
      rememberFrameOrientation(value);
      paint();
    },
    'Frame orientation',
  );
  orient.classList.add('frame-orientation');

  const sectionLabel = (text: string) => h('div', { class: 'field-label frame-section-label', role: 'presentation' }, text);
  const customW = h('input', { class: 'frame-custom-input', type: 'number', inputmode: 'numeric', min: String(FRAME_MIN), max: String(FRAME_MAX), step: '1', placeholder: 'W', 'aria-label': 'Custom width' }) as HTMLInputElement;
  const customH = h('input', { class: 'frame-custom-input', type: 'number', inputmode: 'numeric', min: String(FRAME_MIN), max: String(FRAME_MAX), step: '1', placeholder: 'H', 'aria-label': 'Custom height' }) as HTMLInputElement;
  const onCustomKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const w = parseSide(customW.value);
    const hh = parseSide(customH.value);
    if (w === undefined || hh === undefined) return;
    e.preventDefault();
    placeCustom({ w, h: hh });
  };
  customW.addEventListener('keydown', onCustomKey);
  customH.addEventListener('keydown', onCustomKey);

  const body = h('div', { class: 'rail-tool-list frame-presets', role: 'presentation' },
    orient,
    h('button', { class: 'menu-item frame-row', type: 'button', role: 'menuitem', onclick: () => choose('frame') },
      h('span', { class: 'frame-glyph-slot', 'aria-hidden': 'true' }, icon('frame', 16)), h('span', null, 'Frame'), h('span', { class: 'menu-hint' }, 'draw')),
    ...GROUPS.map((group) => h('div', { class: 'frame-section', role: 'presentation' },
      sectionLabel(FRAME_GROUP_LABELS[group]),
      ...FRAME_PRESETS.filter((preset) => preset.group === group).map(sizeRow))),
    h('div', { class: 'frame-section', role: 'presentation' },
      sectionLabel('Custom'),
      h('div', { class: 'frame-custom', role: 'presentation' }, customW, h('span', { class: 'frame-custom-x', 'aria-hidden': 'true' }, '×'), customH)),
  );
  paint();
  return body;
}
