/**
 * The one list of frame sizes, read by the Frame tool's flyout (frame-flyout.ts), the inspector's Frame size control (props.ts, via
 * frame-sizes.ts) and the placement on the board. Pure except for the remembered orientation, which is a localStorage convenience.
 * Sizes are board units: 1 unit is 1 CSS pixel, and paper is at 96 dpi.
 */
export type FramePresetGroup = 'paper' | 'screen' | 'social';
/** The Portrait | Landscape toggle. Portrait keeps each row as its natural orientation; Landscape flips every row that is not square. */
export type FrameOrientation = 'portrait' | 'landscape';

export interface FramePreset {
  id: string;
  label: string;
  group: FramePresetGroup;
  /** Width and height in px in the row's natural orientation (the one the toggle's Portrait shows). */
  w: number;
  h: number;
  /** The physical size of a paper preset, shown as the row's tooltip. */
  hint?: string;
}

export const FRAME_GROUP_LABELS: Record<FramePresetGroup, string> = { paper: 'Paper', screen: 'Screens', social: 'Social' };

export const FRAME_PRESETS: readonly FramePreset[] = [
  { id: 'a5', label: 'A5', group: 'paper', w: 559, h: 794, hint: '148 x 210 mm' },
  { id: 'a4', label: 'A4', group: 'paper', w: 794, h: 1123, hint: '210 x 297 mm' },
  { id: 'a3', label: 'A3', group: 'paper', w: 1123, h: 1587, hint: '297 x 420 mm' },
  { id: 'letter', label: 'US Letter', group: 'paper', w: 816, h: 1056, hint: '216 x 279 mm' },
  { id: 'full-hd', label: 'Full HD', group: 'screen', w: 1920, h: 1080 },
  { id: 'hd', label: 'HD', group: 'screen', w: 1280, h: 720 },
  { id: 'tablet', label: 'Tablet', group: 'screen', w: 1024, h: 768 },
  { id: 'phone', label: 'Phone', group: 'screen', w: 390, h: 844 },
  { id: 'square-post', label: 'Square post', group: 'social', w: 1080, h: 1080 },
  { id: 'story', label: 'Story', group: 'social', w: 1080, h: 1920 },
];

const ORIENTATION_KEY = 'tabula.frame.orientation';
/** The orientation when nothing is remembered: Portrait, which shows every row in its natural orientation. */
const DEFAULT_ORIENTATION: FrameOrientation = 'portrait';
/** The choice made this session, used when storage is missing or refuses to work. */
let sessionOrientation: FrameOrientation = DEFAULT_ORIENTATION;

/** The toggle's remembered choice, read from localStorage on every call (the page works without storage). */
export function frameOrientation(): FrameOrientation {
  try {
    const saved = globalThis.localStorage?.getItem(ORIENTATION_KEY);
    if (saved === 'portrait' || saved === 'landscape') return saved;
  } catch { /* no storage: the session's choice below */ }
  return sessionOrientation;
}

/** Remembers the toggle's choice for this person, and for this session if storage does not keep it. */
export function rememberFrameOrientation(next: FrameOrientation): void {
  sessionOrientation = next;
  try { globalThis.localStorage?.setItem(ORIENTATION_KEY, next); } catch { /* a convenience: the session keeps it */ }
}

/** The choice id a preset has in the Frame group (its flyout rows are choices of the group). */
export function presetChoiceId(preset: FramePreset): string {
  return `preset:${preset.id}`;
}

/** The preset a group choice id stands for, or undefined for any other choice. */
export function presetForChoice(choiceId: string): FramePreset | undefined {
  return FRAME_PRESETS.find((preset) => presetChoiceId(preset) === choiceId);
}

/** Whether a preset is square, so the toggle leaves it alone. */
export function isSquarePreset(preset: FramePreset): boolean {
  return preset.w === preset.h;
}

/** Width and height of a preset under the toggle: its natural orientation for Portrait, every non-square row turned for Landscape. */
export function presetSize(preset: FramePreset, orientation: FrameOrientation): { w: number; h: number } {
  if (orientation === 'portrait' || isSquarePreset(preset)) return { w: preset.w, h: preset.h };
  return { w: preset.h, h: preset.w };
}

/** The name a frame made from a preset gets: its label, plus the shape when the toggle turned it ("A4 landscape", "Full HD portrait"). */
export function presetFrameName(preset: FramePreset, orientation: FrameOrientation): string {
  const size = presetSize(preset, orientation);
  if (isSquarePreset(preset) || (size.w === preset.w && size.h === preset.h)) return preset.label;
  return `${preset.label} ${size.w > size.h ? 'landscape' : 'portrait'}`;
}

/** The box of a frame of this size centred on a world point. */
export function presetFrameBox(size: { w: number; h: number }, viewCenter: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return { x: viewCenter.x - size.w / 2, y: viewCenter.y - size.h / 2, w: size.w, h: size.h };
}
