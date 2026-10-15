import './tooltip.css';
import { h } from './dom';
import { kbdHint } from './kbd';
import { shortcutKeys } from '../shortcuts';
import { addToken, createTipController, placeTip, removeToken, tipContent, type TipContent } from '../tooltip';
import { safeInsets, type Insets } from './safe-area';

const ID = 'tabula-tooltip';
// Anything with a data-tip, plus icon buttons that have no caption but their aria-label.
const TARGET = '[data-tip], .icon-btn[aria-label], .rail-btn[aria-label]';
// The chrome a target can sit in: its group is the nearest of these (the left rail, the top bar, a tray, a menu). A warm
// hop only stays warm inside one group; the canvas is in none of them.
const GROUP = '.tray, .popover, .topbar, .menu';
// While a tooltip is open: a change to these on its target redraws it, and the target leaving the page closes it.
const WATCHED = ['data-tip', 'data-tip-key', 'data-tip-keys', 'aria-label'];

function contentOf(el: HTMLElement): TipContent | null {
  return tipContent({ tip: el.getAttribute('data-tip'), ariaLabel: el.getAttribute('aria-label'), keyId: el.getAttribute('data-tip-key'), keys: el.getAttribute('data-tip-keys') }, shortcutKeys);
}

const targetOf = (node: EventTarget | null): HTMLElement | null => (node instanceof Element ? node.closest<HTMLElement>(TARGET) : null);
// The group a pointer moved onto: its nearest chrome container, the page body outside every one (the canvas, a target in the
// page itself, which share the body group), or null when it left the window.
const groupOfNode = (node: Node | null): Element | null => {
  if (!node) return null;
  return (node instanceof Element ? node : node.parentElement)?.closest(GROUP) ?? document.body;
};

/**
 * One tooltip for the whole app, driven by events on the document: hover (mouse only) or keyboard focus on an element with
 * `data-tip` (and `data-tip-key`, a key id from shortcuts.ts for the key chip) opens it. Native `title` is not used on controls.
 */
export function installTooltips(): void {
  if (document.getElementById(ID)) return;
  const label = h('span', { class: 'tip-label' });
  const keys = h('span', { class: 'tip-key' });
  // hidden from the page's reading order (it is not inside a landmark); its text reaches a screen reader through the target's aria-describedby while it shows
  const tip = h('div', { id: ID, class: 'tip', role: 'tooltip', 'aria-hidden': 'true' }, label, keys);
  document.body.appendChild(tip);

  let anchor: HTMLElement | null = null;
  const watcher = new MutationObserver((records) => {
    if (!anchor) return;
    if (!anchor.isConnected) ctl.dismiss();
    else if (records.some((r) => r.type === 'attributes' && r.target === anchor)) draw(anchor);
  });

  function draw(el: HTMLElement) {
    const content = contentOf(el);
    if (!content) {
      ctl.dismiss();
      return;
    }
    label.textContent = content.label;
    keys.replaceChildren(content.keys ? kbdHint(content.keys, 'tip-keycaps') : document.createDocumentFragment());
    keys.hidden = !content.keys;
    const box = el.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const safe = safeInsets();
    const inset = (edge: keyof Insets) => safe[edge];
    const at = placeTip(box, size, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, undefined, undefined, {
      top: inset('top'), right: inset('right'), bottom: inset('bottom'), left: inset('left'),
    });
    tip.style.left = `${Math.round(at.left)}px`;
    tip.style.top = `${Math.round(at.top)}px`;
  }

  const ctl = createTipController<HTMLElement>({
    show(el) {
      if (anchor && anchor !== el) release(anchor);
      anchor = el;
      el.setAttribute('aria-describedby', addToken(el.getAttribute('aria-describedby'), ID));
      draw(el);
      tip.classList.add('show');
      watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED });
    },
    hide() {
      tip.classList.remove('show');
      watcher.disconnect();
      if (anchor) release(anchor);
      anchor = null;
    },
  }, {
    live: (el) => el.isConnected && contentOf(el) !== null,
    group: (el) => el.closest(GROUP) ?? document.body,
  });

  function release(el: HTMLElement) {
    const rest = removeToken(el.getAttribute('aria-describedby'), ID);
    if (rest) el.setAttribute('aria-describedby', rest);
    else el.removeAttribute('aria-describedby');
  }

  const mouse = (e: PointerEvent) => e.pointerType === 'mouse';
  document.addEventListener('pointerover', (e) => {
    const el = mouse(e) ? targetOf(e.target) : null;
    if (el) ctl.enter(el);
  });
  document.addEventListener('pointerout', (e) => {
    if (!mouse(e)) return;
    const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    const el = targetOf(e.target);
    if (el) {
      if (!(next && el.contains(next))) ctl.leave(el, groupOfNode(next));
    } else if (e.target instanceof Element) {
      // Leaving a chrome container through its padding, with no target under the pointer, still ends a warm hop.
      const from = e.target.closest(GROUP);
      if (from && from !== groupOfNode(next)) ctl.leave(e.target as HTMLElement, groupOfNode(next));
    }
  });
  document.addEventListener('focusin', (e) => {
    const el = targetOf(e.target);
    if (el && (e.target as Element).matches(':focus-visible')) ctl.focus(el);
  });
  document.addEventListener('focusout', (e) => {
    const el = targetOf(e.target);
    if (el) ctl.leave(el);
  });
  window.addEventListener('pointerdown', () => ctl.dismiss(), true);
  window.addEventListener('keydown', (e) => ctl.key(e.key), true);
  window.addEventListener('scroll', () => ctl.dismiss(), { capture: true, passive: true });
  window.addEventListener('resize', () => ctl.dismiss());
}
