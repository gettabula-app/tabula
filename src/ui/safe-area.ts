/** The device safe-area insets in px (--safe-* on :root, see styles.css). All zero where there is no layout, as in tests. */
export type Insets = { top: number; right: number; bottom: number; left: number };

export function safeInsets(el?: Element): Insets {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof getComputedStyle !== 'function') return zero;
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!target) return zero;
  const style = getComputedStyle(target);
  const read = (edge: string) => parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0;
  return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
}
