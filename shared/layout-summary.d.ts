// Types for shared/layout-summary.mjs (TAB-379).

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface Solid extends Rect { id?: string }
export interface LayoutFrame extends Rect { id: string; name: string; children: number }
export interface FreeArea extends Rect { where: string }
export interface LayoutSummary {
  frames: LayoutFrame[];
  occupied: Rect[];
  occupiedMore?: number;
  free: FreeArea[];
}

export const GAP: number;
export const MARGIN: number;
export const AREA: Readonly<{ right: Size; hole: Size; frame: Size }>;
export const FRAME_PAD: Readonly<{ top: number; side: number; bottom: number }>;
export const MAX: Readonly<{ frames: number; free: number; occupied: number; frameAreas: number }>;

export function boundsOf(rects: readonly Rect[]): Rect | null;
export function frameInterior(frame: Rect): Rect;
export function findSpot(solids: readonly Rect[], size: Size, options?: { region?: Rect | null; gap?: number }): { x: number; y: number } | null;
export function packBlock(sizes: readonly Size[], options?: { maxRowW?: number; gap?: number }): { offsets: { x: number; y: number }[]; w: number; h: number };
export function beyondContent(solids: readonly Rect[]): { x: number; y: number };
export function placeBlock(solids: readonly Rect[], sizes: readonly Size[], options?: { region?: Rect | null; gap?: number }): { x: number; y: number }[] | null;
export function summarizeLayout(input: { solids: readonly Solid[]; frames: readonly LayoutFrame[] }): LayoutSummary;
