import { api, type NotificationDigest, type NotificationPrefs } from '../api';
import { chatAvailable } from '../auth';
import { dialog, toast } from './common';
import { h } from './dom';

// docs/notifications.md, Settings: the four switches of the notification bell, each on until switched off, saved as they are changed.
const SWITCHES: { key: keyof NotificationPrefs; label: string }[] = [
  { key: 'mentions', label: 'Mentions of me in chats and comments' },
  { key: 'replies', label: 'Replies to my comments' },
  { key: 'cards', label: 'Cards that are due or assigned to me' },
  { key: 'shares', label: 'Boards and teams shared with me' },
];

/**
 * The person's notification settings: the four switches of the bell (docs/notifications.md, Settings) and, when chat is on, the
 * mention email (docs/chat.md, Mentions), on until turned off. Each switch is saved as it is changed. The email section says what
 * the email holds and when it goes, so the switch is not a guess.
 */
/** The same switch control the mention-email row uses: the checkbox with role switch, a track and a thumb. */
function switchControlOf(box: HTMLInputElement): HTMLElement {
  return h('span', { class: 'chat-switch-control' }, box,
    h('span', { class: 'chat-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'chat-switch-thumb' })));
}

/** The hours of the day, each as the user's locale shows the time (08:00 or 8:00 AM). */
const hourLabel = (hour: number): string =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hour));

/** The browser's zone, sent with every digest save (docs/notifications.md, Digest). */
const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function openChatNotifications(): void {
  const switchBoxes = new Map<keyof NotificationPrefs, HTMLInputElement>();
  const notifStatus = h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  const inApp = SWITCHES.map(({ key, label }) => {
    const box = h('input', { type: 'checkbox', role: 'switch', disabled: true, 'aria-label': label });
    switchBoxes.set(key, box);
    box.addEventListener('change', async () => {
      const on = box.checked;
      box.disabled = true;
      try {
        await api.setNotificationPrefs({ [key]: on });
        toast('Notification settings saved');
      } catch {
        box.checked = !on;
        toast('Could not save that. Check your connection and try again.');
      } finally {
        box.disabled = false;
      }
    });
    return h('label', { class: 'chat-prefs-switch' }, h('span', null, label), switchControlOf(box));
  });

  // The daily digest (docs/notifications.md, Digest): off by default; the time select shows only while it is on.
  const digestStatus = h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  const digestBox = h('input', { type: 'checkbox', role: 'switch', disabled: true, 'aria-label': 'Email me a daily summary' });
  const digestHour = h('select', { disabled: true, 'aria-label': 'Send at' },
    ...Array.from({ length: 24 }, (_unused, hour) => h('option', { value: String(hour) }, hourLabel(hour))));
  const digestHourRow = h('label', { class: 'chat-prefs-switch' }, h('span', null, 'Send at'), digestHour);
  digestHourRow.hidden = true;
  digestHour.value = '8';
  let digestHourValue = 8;
  const setDigestOn = (on: boolean) => {
    digestBox.checked = on;
    digestHourRow.hidden = !on;
  };
  const saveDigest = async (patch: Partial<NotificationDigest>, revert: () => void) => {
    digestBox.disabled = true;
    digestHour.disabled = true;
    try {
      const saved = await api.setNotificationDigest({ ...patch, tz: browserZone() });
      digestHourValue = saved.digest.hour;
      digestHour.value = String(saved.digest.hour);
      toast('Notification settings saved');
    } catch {
      revert();
      toast('Could not save that. Check your connection and try again.');
    } finally {
      digestBox.disabled = false;
      digestHour.disabled = false;
    }
  };
  digestBox.addEventListener('change', () => {
    const on = digestBox.checked;
    setDigestOn(on);
    void saveDigest({ on }, () => setDigestOn(!on));
  });
  digestHour.addEventListener('change', () => {
    const hour = Number(digestHour.value);
    const previous = digestHourValue;
    void saveDigest({ hour }, () => {
      digestHourValue = previous;
      digestHour.value = String(previous);
    });
  });
  const digestSection = h('div', { class: 'stack' },
    h('h3', { class: 'admin-sub' }, 'Email digest'),
    h('label', { class: 'chat-prefs-switch', 'aria-describedby': 'chat-digest-note' }, h('span', null, 'Email me a daily summary'), switchControlOf(digestBox)),
    digestHourRow,
    h('p', { class: 'muted small', id: 'chat-digest-note' },
      'One email a day with a list of what is new in your notifications: who and where, never what was written. Sent at the hour you choose, in your time zone. Off by default.'),
    digestStatus);

  const box = h('input', { type: 'checkbox', role: 'switch', disabled: true, 'aria-label': 'Email me when I am mentioned in chat', 'aria-describedby': 'chat-prefs-note' });
  const switchControl = switchControlOf(box);
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

  const sections: HTMLElement[] = [
    h('div', { class: 'stack' }, h('h3', { class: 'admin-sub' }, 'In your notifications'), ...inApp, notifStatus),
    digestSection,
  ];
  const chat = chatAvailable();
  if (chat) {
    sections.push(h('div', { class: 'stack' },
      h('h3', { class: 'admin-sub' }, 'Email'),
      h('label', { class: 'chat-prefs-switch' }, h('span', null, 'Email me when I am mentioned in chat'), switchControl),
      note, status));
  }
  dialog('Notification settings', h('div', { class: 'stack' }, ...sections), [{ label: 'Done', primary: true }]);

  api.notificationPrefs().then(({ prefs }) => {
    for (const { key } of SWITCHES) {
      const switchBox = switchBoxes.get(key)!;
      switchBox.checked = prefs[key];
      switchBox.disabled = false;
    }
    notifStatus.textContent = '';
  }, () => {
    notifStatus.textContent = 'Could not load your notification settings. Check your connection.';
  });

  api.notificationDigest().then(({ digest }) => {
    if (!digest) { digestSection.hidden = true; return; } // this instance sends no email: nothing to switch on
    digestHourValue = digest.hour;
    digestHour.value = String(digest.hour);
    setDigestOn(digest.on);
    digestBox.disabled = false;
    digestHour.disabled = false;
    digestStatus.textContent = '';
  }, (error: unknown) => {
    if ((error as { status?: number } | null)?.status === 404) { digestSection.hidden = true; return; } // an older server without the digest
    digestStatus.textContent = 'Could not load your digest settings. Check your connection.';
  });

  if (!chat) return;
  api.chatPrefs().then((p) => {
    loaded = true;
    box.checked = p.emailMentions;
    box.disabled = false;
    status.textContent = '';
  }, () => {
    status.textContent = loaded ? '' : 'Could not load your settings. Check your connection.';
  });
}
