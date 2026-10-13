import { h } from './dom';

const platformIsMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

/** Keycaps for a visible shortcut. Keep the canonical shortcut available to assistive technology. */
export function kbdHint(shortcut: string, className = ''): HTMLElement {
  const mac = platformIsMac();
  const aliases = new Map([
    ['Ctrl/Cmd', mac ? 'Cmd' : 'Ctrl'],
    ['Cmd', mac ? 'Cmd' : 'Ctrl'],
    ['Meta', mac ? 'Cmd' : 'Ctrl'],
    ['Control', 'Ctrl'],
  ]);
  const glyphs: Record<string, string> = mac
    ? { Alt: '⌥', Cmd: '⌘', Shift: '⇧', Ctrl: '⌃' }
    : { Alt: 'Alt', Cmd: 'Ctrl', Shift: 'Shift', Ctrl: 'Ctrl' };
  const nodes: Node[] = [];
  shortcut.split(', ').forEach((alternative, alternativeIndex) => {
    if (alternativeIndex) nodes.push(document.createTextNode(', '));
    alternative.split('+').forEach((part, index) => {
      if (index) nodes.push(document.createTextNode('+'));
      const key = aliases.get(part) ?? part;
      nodes.push(h('kbd', null, glyphs[key] ?? key));
    });
  });
  return h('span', { class: `kbd-hint${className ? ` ${className}` : ''}`, 'aria-label': shortcut }, nodes);
}
