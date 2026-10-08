import { hostedSets } from '../icons';
import { downloadSets, offlineStates, offlineSupported, removeSets, type OfflineState } from '../icon-offline';
import { toast } from './common';
import { h } from './dom';

export interface OfflineTarget { label: string; prefixes: string[] }

const mb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The "Download for offline" row of a drawer: what the target costs, and a button to store it, update it or remove it.
 * A download keeps going when the drawer closes. Hidden where the browser has no Cache Storage.
 */
export function offlineRow(target: () => OfflineTarget | null, signal: AbortSignal) {
  const el = h('div', { class: 'offline-row', hidden: !offlineSupported() });
  let busy: AbortController | null = null;
  let seq = 0;

  const draw = (text: string, ...controls: HTMLElement[]) => el.replaceChildren(h('p', { class: 'offline-text', role: 'status' }, text), ...controls);
  const button = (label: string, onclick: () => void) => h('button', { class: 'btn', onclick }, label);

  const run = async (t: OfflineTarget, prefixes: string[], verb: string) => {
    const ctl = new AbortController();
    busy = ctl;
    const cancel = button('Cancel', () => ctl.abort());
    draw(`${verb} ${t.label}…`, cancel);
    try {
      await downloadSets(prefixes, {
        signal: ctl.signal,
        onProgress: (done, total) => {
          if (!el.isConnected) return;
          draw(`${verb} ${t.label}: ${done} of ${total} files`, h('div', { class: 'offline-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done }, h('div', { style: { width: `${Math.round((done / Math.max(1, total)) * 100)}%` } })), cancel);
        },
      });
      toast(`${t.label} is available offline`);
    } catch (e) {
      if (!ctl.signal.aborted) toast((e as Error).message || 'The icons could not be downloaded. Try again.');
    }
    busy = null;
    void update();
  };

  const update = async () => {
    const mine = ++seq;
    if (!offlineSupported() || busy) return;
    const t = target();
    el.hidden = !t;
    if (!t) return;
    try {
      const sets = (await hostedSets(signal)).filter((s) => t.prefixes.includes(s.prefix));
      const states = await offlineStates(sets);
      if (mine !== seq || busy || signal.aborted) return;
      const all = Object.values(states);
      const state: OfflineState = all.includes('update') ? 'update' : all.every((s) => s === 'ready') ? 'ready' : 'none';
      const gz = sets.reduce((n, s) => n + s.gz, 0), raw = sets.reduce((n, s) => n + s.raw, 0);
      const remove = button('Remove', () => { void removeSets(t.prefixes).then(update); });
      if (state === 'ready') draw(`${t.label} is available offline.`, remove);
      else if (state === 'update') draw(`${t.label}: an update is available (downloads up to ${mb(gz)}).`, button('Update', () => { void run(t, t.prefixes, 'Updating'); }), remove);
      else draw(`${t.label}: downloads ${mb(gz)}, stores about ${mb(raw)}.`, button('Download for offline', () => { void run(t, t.prefixes, 'Downloading'); }));
    } catch {
      if (mine === seq) el.hidden = true;
    }
  };

  return { el, update: () => { void update(); } };
}
