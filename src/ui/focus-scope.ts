// Keyboard focus for the surfaces that open over the page (dialog() and popover() in common.ts): which controls Tab can
// reach inside one, wrapping Tab at its ends, making the page behind it inert, and giving focus back when it closes.
// docs/accessibility-audit.md, C2 and S1.

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';

/** The controls inside `root` that Tab reaches, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.getAttribute('tabindex') === '-1' || el.getAttribute('type') === 'hidden') return false;
    if ((el as HTMLButtonElement).disabled) return false;
    for (let n: Node | null = el; n && n !== root.parentNode; n = n.parentNode) if ((n as HTMLElement).hidden) return false;
    return typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
  });
}

/** Moves focus into `root`: its first control, or the container itself when it has none. */
export function focusFirst(root: HTMLElement, prefer?: HTMLElement | null) {
  const target = prefer ?? tabbables(root)[0];
  if (target) target.focus({ preventScroll: true });
  else {
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    root.focus({ preventScroll: true });
  }
}

const inside = (root: HTMLElement, el: Element | null) => !!el && root.contains(el);

/**
 * Keeps Tab and Shift+Tab inside `root`: at the last control Tab goes to the first, and the other way round. When focus is
 * somewhere else on the page (it was clicked away, or never moved in) Tab brings it in. Returns true when it moved focus.
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
  const list = tabbables(root);
  const active = document.activeElement as HTMLElement | null;
  const go = (el: HTMLElement) => {
    e.preventDefault();
    el.focus({ preventScroll: true });
    return true;
  };
  if (!list.length) return go(root.hasAttribute('tabindex') ? root : (root.setAttribute('tabindex', '-1'), root));
  const first = list[0], last = list[list.length - 1];
  if (!inside(root, active)) return go(e.shiftKey ? last : first);
  if (e.shiftKey && (active === first || active === root)) return go(last);
  if (!e.shiftKey && active === last) return go(first);
  return false;
}

/** True when focus is in `root` or nowhere in particular (on the body): the cases where closing should give focus back. */
export function focusIsIn(root: HTMLElement): boolean {
  const active = document.activeElement;
  return !active || active === document.body || root.contains(active);
}

/** Makes everything in the body except `keep` (and the toast, which must stay announced) inert. Returns the undo. */
export function inertPage(keep: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (el === keep || el.inert || el.classList.contains('toast')) continue;
    el.inert = true;
    changed.push(el);
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

/** Gives focus back to `el` if it is still on the page. */
export function restoreFocus(el: HTMLElement | null) {
  if (el && el !== document.body && el.isConnected) el.focus({ preventScroll: true });
}
