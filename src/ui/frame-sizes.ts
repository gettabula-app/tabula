/** Frame size presets, in board units (1 unit = 1 CSS pixel; paper sizes at 96 dpi). */
export interface FramePreset {
  id: string;
  group: 'Screen' | 'Tablet' | 'Phone' | 'Paper' | 'Other';
  label: string;
  w: number;
  h: number;
}

const paper = (name: string, w: number, h: number): FramePreset[] => [
  { id: `${name.toLowerCase()}-portrait`, group: 'Paper', label: `${name} portrait`, w, h },
  { id: `${name.toLowerCase()}-landscape`, group: 'Paper', label: `${name} landscape`, w: h, h: w },
];

export const FRAME_PRESETS: FramePreset[] = [
  { id: 'screen-1920', group: 'Screen', label: '1920 × 1080', w: 1920, h: 1080 },
  { id: 'screen-1440', group: 'Screen', label: '1440 × 900', w: 1440, h: 900 },
  { id: 'screen-1280', group: 'Screen', label: '1280 × 800', w: 1280, h: 800 },
  { id: 'tablet-landscape', group: 'Tablet', label: '1024 × 768', w: 1024, h: 768 },
  { id: 'tablet-portrait', group: 'Tablet', label: '768 × 1024', w: 768, h: 1024 },
  { id: 'phone', group: 'Phone', label: '390 × 844', w: 390, h: 844 },
  ...paper('A3', 1123, 1587),
  ...paper('A4', 794, 1123),
  ...paper('Letter', 816, 1056),
  { id: 'square', group: 'Other', label: 'Square 1000 × 1000', w: 1000, h: 1000 },
];

export const CUSTOM_SIZE = 'custom';
export const FRAME_MIN = 40;
export const FRAME_MAX = 8000;

/** The preset a frame of this size matches (within half a unit), or 'custom'. */
export function presetFor(w: number, h: number): string {
  return FRAME_PRESETS.find((p) => Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5)?.id ?? CUSTOM_SIZE;
}
