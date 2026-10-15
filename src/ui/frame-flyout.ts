import './frame-presets.css';
import { segmented } from './common';
import { h, icon } from './dom';
import { FRAME_PRESETS, presetChoiceId, presetSize, type FrameOrientation, type FramePreset } from './frame-presets';

const ORIENTATION_KEY = 'tabula.frame.orientation';
/** The height of a size glyph in px; its width follows the size's proportions. */
const GLYPH_HEIGHT = 14;

let orientation: FrameOrientation | null = null;

/** The orientation paper sizes are placed in: the one picked last (kept in localStorage), Portrait at first. */
export function frameOrientation(): FrameOrientation {
  if (orientation) return orientation;
  let saved: string | null = null;
  try { saved = localStorage.getItem(ORIENTATION_KEY); } catch { /* no storage: Portrait */ }
  orientation = saved === 'landscape' ? 'landscape' : 'portrait';
  return orientation;
}

function rememberOrientation(next: FrameOrientation) {
  orientation = next;
  try { localStorage.setItem(ORIENTATION_KEY, next); } catch { /* a convenience: the choice lasts this session */ }
}

/**
 * The Frame flyout's body: the draw tool, then the paper sizes with their orientation, then the screen sizes. `choose` picks a choice of
 * the Frame group (the draw tool, or a size, which places a frame in the view); picking closes the flyout.
 */
export function frameFlyoutBody(choose: (choiceId: string) => void): HTMLElement {
  const rows: { preset: FramePreset; glyph: HTMLElement; size: HTMLElement }[] = [];
  /** Shows each size in the current orientation: the glyph's proportions and the pixel size. */
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
      class: 'menu-item frame-row', type: 'button', role: 'menuitem', title: preset.hint,
      onclick: () => choose(presetChoiceId(preset)),
    }, h('span', { class: 'frame-glyph-slot', 'aria-hidden': 'true' }, glyph), h('span', null, preset.label), size);
  };
  const orient = segmented<FrameOrientation>(
    [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }],
    frameOrientation(),
    (value) => {
      rememberOrientation(value);
      paint();
    },
    'Paper orientation',
  );
  orient.classList.add('frame-orientation');
  const sectionLabel = (text: string) => h('div', { class: 'field-label frame-section-label', role: 'presentation' }, text);
  const body = h('div', { class: 'rail-tool-list frame-presets', role: 'presentation' },
    h('button', { class: 'menu-item frame-row', type: 'button', role: 'menuitem', onclick: () => choose('frame') },
      h('span', { class: 'frame-glyph-slot', 'aria-hidden': 'true' }, icon('frame', 16)), h('span', null, 'Frame'), h('span', { class: 'menu-hint' }, 'draw')),
    h('div', { class: 'frame-section', role: 'presentation' },
      sectionLabel('Paper'),
      orient,
      ...FRAME_PRESETS.filter((preset) => preset.group === 'paper').map(sizeRow)),
    h('div', { class: 'frame-section', role: 'presentation' },
      sectionLabel('Screen'),
      ...FRAME_PRESETS.filter((preset) => preset.group === 'screen').map(sizeRow)),
  );
  paint();
  return body;
}
