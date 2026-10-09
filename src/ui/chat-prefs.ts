import { api } from '../api';
import { dialog, toast } from './common';
import { h } from './dom';

/**
 * The person's chat notifications (docs/chat.md, Mentions): one switch, mention emails, on until turned off. It is saved as
 * it is changed. The dialog says what the email holds and when it goes, so the switch is not a guess.
 */
export function openChatNotifications(): void {
  const box = h('input', { type: 'checkbox', disabled: true, 'aria-describedby': 'chat-prefs-note' });
  const note = h('p', { class: 'muted small', id: 'chat-prefs-note' },
    'When someone mentions you and you have not had Tabula open for 10 minutes, you get one email per conversation with who wrote it and the first words, and a link. You are never emailed for something you have read, or while you are using Tabula.');
  const status = h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  let loaded = false;
  box.addEventListener('change', async () => {
    const on = box.checked;
    box.disabled = true;
    try {
      await api.setChatPrefs({ emailMentions: on });
      toast(on ? 'You will be emailed when you are mentioned' : 'No emails for mentions');
    } catch {
      box.checked = !on;
      toast('Could not save that. Check your connection and try again.');
    } finally {
      box.disabled = false;
    }
  });
  dialog('Chat notifications', h('div', { class: 'stack' },
    h('label', { class: 'ai-check' }, box, h('span', null, 'Email me when I am mentioned in chat')),
    note, status), [{ label: 'Close', primary: true }]);
  api.chatPrefs().then((p) => {
    loaded = true;
    box.checked = p.emailMentions;
    box.disabled = false;
    status.textContent = '';
  }, () => {
    status.textContent = loaded ? '' : 'Could not load your settings. Check your connection.';
  });
}
