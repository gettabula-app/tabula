import './tooltip.css';
import { h } from './dom';
import { shortcutKeys } from '../shortcuts';
import { addToken, createTipController, placeTip, removeToken, tipContent, type TipContent } from '../tooltip';
import { safeInsets, type Insets } from './safe-area';

const ID = 'tabula-tooltip';
// Anything with a data-tip, plus icon buttons that have no caption but their aria-label.
const TARGET = '[data-tip], .icon-btn[aria-label], .rail-btn[aria-label]';
// While a tooltip is open: a change to these on its target redraws it, and the target leaving the page closes it.
const WATCHED = ['data-tip', 'data-tip-key', 'aria-label'];

function contentOf(el: HTMLElement): TipContent | null {
  return tipContent({ tip: el.getAttribute('data-tip'), ariaLabel: el.getAttribute('aria-label'), keyId: el.getAttribute('data-tip-key') }, shortcutKeys);
}

const targetOf = (node: EventTarget | null): HTMLElement | null => (node instanceof Element ? node.closest<HTMLElement>(TARGET) : null);

/**
 * One tooltip for the whole app, driven by events on the document: hover (mouse only) or keyboard focus on an element with
 * `data-tip` (and `data-tip-key`, a key id from shortcuts.ts for the key chip) opens it. Native `title` is not used on controls.
 */
export function installTooltips(): void {
  if (document.getElementById(ID)) return;
  const label = h('span', { class: 'tip-label' });
  const keys = h('span', { class: 'tip-key' });
  const tip = h('div', { id: ID, class: 'tip', role: 'tooltip' }, label, keys);
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
    keys.textContent = content.keys ?? '';
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
  }, { live: (el) => el.isConnected && contentOf(el) !== null });

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
    const el = mouse(e) ? targetOf(e.target) : null;
    if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) ctl.leave(el);
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
