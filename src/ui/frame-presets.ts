/**
 * Page and screen sizes for the Frame tool's flyout. Pure: no DOM, so the sizes and the placement sums can be tested on their own.
 * Sizes are board units: 1 unit is 1 CSS pixel, and paper is at 96 dpi.
 */
export type FramePresetGroup = 'paper' | 'screen';
export type FrameOrientation = 'portrait' | 'landscape';

export interface FramePreset {
  id: string;
  label: string;
  group: FramePresetGroup;
  /** Width and height in px; a paper preset is stored in portrait. */
  w: number;
  h: number;
  /** The physical size of a paper preset, shown as the row's tooltip. */
  hint?: string;
}

export const FRAME_PRESETS: readonly FramePreset[] = [
  { id: 'a5', label: 'A5', group: 'paper', w: 559, h: 794, hint: '148 x 210 mm' },
  { id: 'a4', label: 'A4', group: 'paper', w: 794, h: 1123, hint: '210 x 297 mm' },
  { id: 'a3', label: 'A3', group: 'paper', w: 1123, h: 1587, hint: '297 x 420 mm' },
  { id: 'letter', label: 'US Letter', group: 'paper', w: 816, h: 1056, hint: '216 x 279 mm' },
  { id: 'full-hd', label: 'Full HD', group: 'screen', w: 1920, h: 1080 },
  { id: 'hd', label: 'HD', group: 'screen', w: 1280, h: 720 },
  { id: 'square-post', label: 'Square post', group: 'screen', w: 1080, h: 1080 },
  { id: 'story', label: 'Story', group: 'screen', w: 1080, h: 1920 },
  { id: 'phone', label: 'Phone', group: 'screen', w: 390, h: 844 },
];

/** The choice id a preset has in the Frame group (its flyout rows are choices of the group). */
export function presetChoiceId(preset: FramePreset): string {
  return `preset:${preset.id}`;
}

/** The preset a group choice id stands for, or undefined for any other choice. */
export function presetForChoice(choiceId: string): FramePreset | undefined {
  return FRAME_PRESETS.find((preset) => presetChoiceId(preset) === choiceId);
}

/** Width and height of a preset in an orientation: paper turns for landscape; screen sizes stay as listed. */
export function presetSize(preset: FramePreset, orientation: FrameOrientation): { w: number; h: number } {
  if (preset.group === 'screen' || orientation === 'portrait') return { w: preset.w, h: preset.h };
  return { w: preset.h, h: preset.w };
}

/** The name a frame made from a preset gets: its label, and "landscape" after a paper size turned. */
export function presetFrameName(preset: FramePreset, orientation: FrameOrientation): string {
  return preset.group === 'paper' && orientation === 'landscape' ? `${preset.label} landscape` : preset.label;
}

/** The box of a frame of this size centred on a world point. */
export function presetFrameBox(size: { w: number; h: number }, viewCenter: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return { x: viewCenter.x - size.w / 2, y: viewCenter.y - size.h / 2, w: size.w, h: size.h };
}
