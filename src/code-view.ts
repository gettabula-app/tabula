// What a person sees of a code block that is not in the board: how far each one is scrolled sideways (docs/code-blocks.md). View state, per session, never
// stored and never exported; the drawing code asks for it, the wheel and the keyboard set it.
const scrolls = new Map<string, number>();
let changed: (id: string) => void = () => {};

/** Registers what happens when a block's scroll changed (the app redraws that block). */
export const onCodeScroll = (fn: ((id: string) => void) | null): void => { changed = fn ?? (() => {}); };
export const codeScroll = (id: string): number => scrolls.get(id) ?? 0;

/** Sets a block's scroll, clamped to [0, max]; returns whether it moved. */
export function setCodeScroll(id: string, x: number, max: number): boolean {
  const next = Math.max(0, Math.min(Math.round(x), Math.max(0, max)));
  if (next === codeScroll(id)) return false;
  if (next === 0) scrolls.delete(id);
  else scrolls.set(id, next);
  changed(id);
  return true;
}

export function forgetCodeScroll(id: string): void {
  scrolls.delete(id);
}
