import { h, icon, ICONS } from './dom';

const features: [keyof typeof ICONS, string][] = [
  ['share', 'Share'],
  ['chat', 'Chat'],
  ['flag', 'AI'],
  ['history', 'History'],
  ['cloudOff', 'Backups'],
];

/** Disabled menu entries explain which workspace features are unavailable in the ephemeral demo. */
export function demoWorkspaceItems(): HTMLButtonElement[] {
  return features.map(([ic, label]) => h('button', {
    class: 'menu-item', disabled: true, 'data-workspace-feature': label,
  }, icon(ic, 18), h('span', null, label), h('span', { class: 'menu-hint' }, 'Available in a workspace')));
}
