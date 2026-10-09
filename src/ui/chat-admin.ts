import './chat-admin.css';
import { api, type ChatSettings } from '../api';
import { h } from './dom';
import type { AdminKit } from './tokens';

/** Keep chat messages: the choices of docs/chat.md (Retention); null is forever. */
export const RETENTION_OPTIONS: { value: number | null; label: string }[] = [
  { value: 365, label: '1 year' },
  { value: 90, label: '90 days' },
  { value: 30, label: '30 days' },
  { value: null, label: 'Forever' },
];

/** What the retention choice means for people, one sentence under the options. */
export function retentionNote(days: number | null): string {
  return days === null
    ? 'Messages are kept until someone deletes them. Backups keep what was deleted until they expire.'
    : `Messages older than ${days === 365 ? '1 year' : `${days} days`} are deleted once a day, with their mentions. Backups keep them until they expire.`;
}

const fact = (label: string, control: HTMLElement) => h('div', { class: 'admin-fact' }, h('dt', null, label), h('dd', null, control));

/**
 * The body of the admin dashboard's Chat tab (docs/chat.md, Interface): whether the workspace has its one channel, whether
 * viewers may post in board chat, and how long messages are kept. Each change is saved as it is made.
 */
export function chatAdminPanel(kit: AdminKit): HTMLElement {
  const root = h('div', { class: 'chat-admin' });
  let saved: ChatSettings | null = null;
  let failed = false;

  const save = async (patch: Partial<ChatSettings>, done: string) => {
    let next: ChatSettings | undefined;
    const ok = await kit.change(async () => {
      next = await api.setAdminChat(patch);
    }, done);
    if (ok && next) saved = next;
    render();
  };

  function render() {
    if (!saved) {
      root.replaceChildren(failed ? h('p', { class: 'chat-admin-note', role: 'alert' }, 'Chat settings could not be loaded. Check your connection and reload.') : h('p', { class: 'chat-admin-note' }, 'Loading…'));
      return;
    }
    const state = saved;
    const check = (label: string, checked: boolean, onChange: (on: boolean) => void) =>
      h('label', { class: 'ai-check' },
        h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.currentTarget as HTMLInputElement).checked) }),
        h('span', null, label));
    const keep = h('div', { class: 'chat-admin-keep', role: 'radiogroup', 'aria-label': 'Keep chat messages' },
      RETENTION_OPTIONS.map((o) => {
        const on = o.value === state.retentionDays;
        return h('button', {
          class: `admin-chip${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1',
          onclick: () => {
            if (!on) void save({ retentionDays: o.value }, `Messages are kept ${o.label === 'Forever' ? 'forever' : `for ${o.label}`}`);
          },
        }, o.label);
      }));
    keep.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const radios = [...keep.querySelectorAll<HTMLButtonElement>('[role=radio]')];
      const at = radios.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      e.preventDefault();
      radios[(at + (e.key === 'ArrowRight' ? 1 : radios.length - 1)) % radios.length].focus();
    });
    root.replaceChildren(
      h('p', { class: 'chat-admin-note' }, 'Board chat, team channels and the workspace channel. Messages are plain text, kept on the server, and are not part of board files or exports. To answer a request to be forgotten, or to give a person a copy of what they wrote, use Erase chat messages and Export chat in the Members tab. Backups keep erased messages until they expire.'),
      h('dl', { class: 'admin-facts' },
        fact('Workspace channel', check('Everyone except guests can talk in one workspace channel', state.workspaceChannel,
          (on) => void save({ workspaceChannel: on }, on ? 'Workspace channel is on' : 'Workspace channel is off'))),
        fact('Viewers', check('Viewers may post in board chat (they can always read it)', state.viewersMayPost,
          (on) => void save({ viewersMayPost: on }, on ? 'Viewers may post in board chat' : 'Viewers read board chat only'))),
        fact('Keep messages', h('div', null, keep, h('p', { class: 'chat-admin-note' }, retentionNote(state.retentionDays))))));
  }

  render();
  api.adminChat().then((s) => {
    saved = s;
    render();
  }, () => {
    failed = true;
    render();
  });
  return root;
}
