import { FRAME_PRESETS, type FramePreset } from './frame-presets';

/** The inspector's Frame size helpers. The list itself is FRAME_PRESETS in frame-presets.ts, the same one the Frame menu reads. */
export { FRAME_PRESETS };
export type { FramePreset };

export const CUSTOM_SIZE = 'custom';
export const FRAME_MIN = 40;
export const FRAME_MAX = 8000;

/**
 * The preset a frame of this size matches in either orientation (within half a unit), or 'custom'. A frame turned by the toggle
 * (1080 x 1920 or 1920 x 1080 for Story and Full HD) is still that preset.
 */
export function presetFor(w: number, h: number): string {
  const natural = (p: FramePreset) => Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5;
  const turned = (p: FramePreset) => Math.abs(p.h - w) < 0.5 && Math.abs(p.w - h) < 0.5;
  // 1080 x 1920 is Story as listed and Full HD turned: the row that has it as listed wins
  return (FRAME_PRESETS.find(natural) ?? FRAME_PRESETS.find(turned))?.id ?? CUSTOM_SIZE;
}
