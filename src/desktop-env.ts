/**
 * Whether the page runs inside the Tauri desktop shell (docs/desktop.md). Tauri defines this global before any page
 * script runs. The check loads nothing, so the web bundle can ask it freely; the glue itself (`desktop.ts`) is only
 * ever imported dynamically, after this returns true.
 */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Where boards are kept, for sentences like "Boards are stored ... only". */
export function storedWhere(): string {
  return isDesktop() ? 'on this computer' : 'in this browser';
}
