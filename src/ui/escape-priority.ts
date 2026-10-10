export type EscapeAction = 'none' | 'overlay' | 'drag' | 'group' | 'drawer' | 'board';

export interface EscapeContext {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  dragging: boolean;
  groupOpen: boolean;
  drawerOpen: boolean;
}

/** Chooses the topmost Escape action while preserving overlay, drag and group priority over the library drawer. */
export function escapeAction(c: EscapeContext): EscapeAction {
  if (c.key !== 'Escape' || c.defaultPrevented) return 'none';
  if (c.overlayOpen) return 'overlay';
  if (c.dragging) return 'drag';
  if (c.groupOpen) return 'group';
  if (c.drawerOpen) return 'drawer';
  return 'board';
}
