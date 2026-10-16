// Which focused element keeps Space and Enter for its own activation. Pure, so the rule is tested without a browser; the wiring is in
// app.ts (the board's Space pan, and the Enter that edits the selection). Space on a focused rail button presses it, and Enter does too.

/** Tags that are controls on their own: a button, a field, a list of choices, a disclosure. */
const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

/** The ARIA roles of widgets a key activates or chooses from: a press on Space or Enter belongs to them. */
const CONTROL_ROLES = new Set([
  'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'checkbox', 'radio', 'option', 'link', 'combobox', 'slider',
]);

/**
 * The board's own surfaces, and the page body: a focused one leaves Space to the board (the pan), and the walk up from a focused element
 * stops at one. The canvas's one tab stop (`.canvas-focus`, tabindex 0, src/ui/canvas-focus.ts) is one of them, so it is a pan target and
 * not a control.
 */
function isBoardSurface(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'BODY' || tag === 'HTML') return true;
  const list = el.classList;
  return !!list && typeof list.contains === 'function' && (list.contains('board-surface') || list.contains('canvas-focus') || list.contains('canvas'));
}

/** Whether this element is a control on its own, not counting its ancestors. */
function isControl(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (CONTROL_TAGS.has(tag)) return true;
  if (tag === 'A' && el.hasAttribute('href')) return true;
  if (typeof el.getAttribute !== 'function') return false;
  const editable = el.getAttribute('contenteditable');
  if ((el as HTMLElement).isContentEditable === true || (editable !== null && editable !== 'false')) return true;
  const role = el.getAttribute('role');
  if (role !== null && CONTROL_ROLES.has(role.trim().toLowerCase())) return true;
  // any other tab stop, such as a focusable region that scrolls or a tracker view; a tabindex of -1 is focused by script, not by Tab
  const tabindex = el.getAttribute('tabindex');
  return tabindex !== null && Number.parseInt(tabindex, 10) >= 0;
}

/** The parent element, or null above the top: a document or a fragment is not an element. */
function parentElementOf(el: Element): Element | null {
  const up = el.parentNode as Element | null;
  return up && typeof up.tagName === 'string' ? up : null;
}

/**
 * Whether a focused element is a control that keeps Space and Enter for its own activation: a button, a link with an address, a field
 * or a choice, a disclosure, an editable area, a widget with a role such as menuitem or tab, or any other tab stop. The walk goes up from
 * the focused element, so a span inside a button counts. It stops at the board's surfaces and the page body, which are the pan target:
 * a focused canvas, the board itself or the page leave Space to the board. Nothing focused (`null`) is not a control.
 */
export function controlTakesSpace(el: Element | null): boolean {
  let node = el;
  while (node && typeof node.tagName === 'string') {
    if (isBoardSurface(node)) return false;
    if (isControl(node)) return true;
    node = parentElementOf(node);
  }
  return false;
}

/**
 * The element a key went to: the keydown's target, else the focused element. Duck-typed (a tag name is a string), with no `Element` or
 * `document` global required, so the board's shared key handler cannot throw where a test or an odd host has no DOM classes.
 */
export function keyTarget(e: { target: unknown }): Element | null {
  const t = e.target as Element | null | undefined;
  if (t && typeof t.tagName === 'string') return t;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return active && typeof active.tagName === 'string' ? active : null;
}
