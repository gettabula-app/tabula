import './ai-review-panel.css';
import type { BoardApp } from '../app';
import type { AiProposal } from '../ai-apply';
import { FEATURE_LABEL } from '../ai-bar-logic';
import { TEXT_MAX, TITLE_MAX, addLabel, reviewCounts, reviewed, startReview, type Review } from '../ai-review';
import { STICKY_COLORS } from '../palette';
import { liveRunsFor, onLiveChange, reviewFor, setReview, setReviewOpener, staleFor, type ReviewActions } from './ai-live';
import { h, icon } from './dom';

// The review panel of an AI proposal (TAB-160, docs/ai.md "Reviewing a proposal"): every item with a box to keep it, the
// words and colours to change, and Add or Discard for the rest. What it changes is the reviewer's own: the ghosts on their
// screen follow it, nobody else sees it, and Add writes exactly what they see. One panel at a time; it closes when the run
// is settled or gone, and on Escape.

const MEMBER_WORDS = 40;

interface Open {
  app: BoardApp;
  runId: string;
  el: HTMLElement;
  close(): void;
}
let current: Open | null = null;

function closeCurrent() {
  current?.close();
}

/** The first words of a sticky, for a group member's chip; the type when it has none. */
function memberLabel(app: BoardApp, id: string): string {
  const o = app.store.get(id) as { text?: unknown } | undefined;
  const text = typeof o?.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return o ? 'Sticky note' : 'A sticky that is gone';
  return text.length > MEMBER_WORDS ? `${text.slice(0, MEMBER_WORDS - 1)}…` : text;
}

function openPanel(app: BoardApp, runId: string, actions: ReviewActions): void {
  const runs = liveRunsFor(app);
  const run = runs?.get(runId);
  const chrome = document.querySelector<HTMLElement>('.chrome');
  if (!run?.proposal || !chrome || app.readOnly) return;
  if (current?.runId === runId) {
    current.el.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return;
  }
  closeCurrent();
  const proposal: AiProposal = run.proposal;
  const stale = staleFor(app, runId);
  if (!reviewFor(app, runId)) setReview(app, runId, startReview(proposal, stale));
  const review = (): Review => reviewFor(app, runId) ?? startReview(proposal, stale);
  const change = (fn: (r: Review) => Review) => {
    setReview(app, runId, fn(structuredClone(review())));
    paintFooter();
  };

  const whose = run.by.name ? `${run.by.name}'s` : 'An';
  const opener = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'aireview-body' });
  const note = h('p', { class: 'aireview-note' }, 'Only you see these changes until you add them.');
  const discard = h('button', { class: 'btn ghost', type: 'button', onclick: () => actions.discard() }, 'Discard');
  const add = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    if (!reviewed(proposal, review())) return;
    actions.accept();
  } }, '');
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the review', 'data-tip': 'Close', 'data-tip-key': 'escape', onclick: () => close() }, icon('close', 18));
  const el = h('aside', { class: 'aireview tray', role: 'region', 'aria-label': 'Review the AI proposal' },
    h('div', { class: 'aireview-head' },
      h('div', null,
        h('h2', null, 'Review'),
        h('p', { class: 'aireview-sub' }, `${whose} proposal · ${FEATURE_LABEL[run.feature]}`)),
      closeBtn),
    body,
    h('div', { class: 'aireview-foot' }, note, h('div', { class: 'aireview-actions' }, discard, add)));

  function paintFooter() {
    const r = review();
    const { kept, stale: staleCount } = reviewCounts(r);
    add.textContent = addLabel(proposal, r);
    add.setAttribute('aria-disabled', String(kept === 0));
    note.textContent = staleCount
      ? `${staleCount === 1 ? '1 sticky has' : `${staleCount} stickies have`} changed since the proposal came, and ${staleCount === 1 ? 'is' : 'are'} left where ${staleCount === 1 ? 'it is' : 'they are'}. Only you see these changes until you add them.`
      : 'Only you see these changes until you add them.';
  }

  /** Rebuilt only when the stale members change: the fields keep their focus and caret while the person types. */
  let structure = '';
  function paintBody() {
    const r = review();
    const sig = r.kind === 'group' ? r.groups.map((g) => g.members.map((m) => `${m.id}${m.stale ? '!' : ''}`).join(',')).join('|') : `create:${r.items.length}`;
    if (sig === structure) return;
    structure = sig;
    body.replaceChildren(r.kind === 'create' ? createList(r) : groupList(r));
  }

  function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false): HTMLInputElement {
    const box = h('input', { type: 'checkbox', 'aria-label': label });
    box.checked = checked;
    box.disabled = disabled;
    box.addEventListener('change', () => onChange(box.checked));
    return box;
  }

  function createList(r: Extract<Review, { kind: 'create' }>): HTMLElement {
    const list = h('ol', { class: 'aireview-list' });
    if (r.frame) {
      const title = h('input', { class: 'input', type: 'text', maxlength: String(TITLE_MAX), 'aria-label': 'Frame title', value: r.frame.title });
      title.addEventListener('input', () => change((x) => (x.kind === 'create' && x.frame ? ((x.frame.title = title.value), x) : x)));
      list.appendChild(h('li', { class: 'aireview-frame' },
        checkbox('Put the stickies in a frame', r.frame.keep, (v) => change((x) => (x.kind === 'create' && x.frame ? ((x.frame.keep = v), x) : x))),
        h('span', { class: 'aireview-kind' }, 'Frame'), title));
    }
    r.items.forEach((item, i) => {
      const text = h('textarea', { class: 'input', rows: '2', maxlength: String(TEXT_MAX), 'aria-label': `Sticky ${i + 1} text` });
      text.value = item.text;
      text.addEventListener('input', () => change((x) => (x.kind === 'create' ? ((x.items[i].text = text.value), x) : x)));
      const swatches = h('div', { class: 'aireview-colors', role: 'radiogroup', 'aria-label': `Sticky ${i + 1} colour` },
        ...STICKY_COLORS.map((c) => {
          const on = (item.color ?? STICKY_COLORS[0].name).toLowerCase() === c.name.toLowerCase();
          const b = h('button', { class: `swatch${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': c.name, 'data-tip': c.name, style: `--c:${c.fill}` });
          b.addEventListener('click', () => {
            change((x) => (x.kind === 'create' ? ((x.items[i].color = c.name), x) : x));
            for (const s of swatches.children) {
              s.classList.toggle('on', s === b);
              s.setAttribute('aria-checked', String(s === b));
            }
          });
          return b;
        }));
      list.appendChild(h('li', { class: 'aireview-item' },
        checkbox(`Keep sticky ${i + 1}`, item.keep, (v) => change((x) => (x.kind === 'create' ? ((x.items[i].keep = v), x) : x))),
        h('div', { class: 'aireview-fields' }, text, swatches)));
    });
    return list;
  }

  function groupList(r: Extract<Review, { kind: 'group' }>): HTMLElement {
    const list = h('ol', { class: 'aireview-list' });
    r.groups.forEach((g, gi) => {
      const title = h('input', { class: 'input', type: 'text', maxlength: String(TITLE_MAX), 'aria-label': `Group ${gi + 1} title`, value: g.title });
      title.addEventListener('input', () => change((x) => (x.kind === 'group' ? ((x.groups[gi].title = title.value), x) : x)));
      const members = h('ul', { class: 'aireview-members' },
        ...g.members.map((m, mi) => h('li', { class: `aireview-member${m.stale ? ' stale' : ''}` },
          checkbox(`Move “${memberLabel(app, m.id)}”`, m.keep && !m.stale, (v) => change((x) => (x.kind === 'group' ? ((x.groups[gi].members[mi].keep = v), x) : x)), m.stale),
          h('span', { class: 'aireview-member-text' }, memberLabel(app, m.id)),
          m.stale ? h('span', { class: 'aireview-tag' }, 'Changed since') : null)));
      list.appendChild(h('li', { class: 'aireview-group' },
        h('div', { class: 'aireview-group-head' },
          checkbox(`Keep group ${gi + 1}`, g.keep, (v) => change((x) => (x.kind === 'group' ? ((x.groups[gi].keep = v), x) : x))),
          title),
        members));
    });
    return list;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !el.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  let off: () => void = () => {};
  function close() {
    if (current?.el !== el) return;
    current = null;
    off();
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    if (opener?.isConnected) opener.focus();
  }

  chrome.appendChild(el);
  current = { app, runId, el, close };
  window.addEventListener('keydown', onKey, true);
  off = onLiveChange(app, () => {
    // settled, gone, or the person lost the right to edit: nothing left to review
    if (!liveRunsFor(app)?.get(runId) || app.readOnly) return close();
    paintBody();
    paintFooter();
  });
  app.onDestroy(() => close());
  paintBody();
  paintFooter();
  el.querySelector<HTMLElement>('input, textarea')?.focus();
}

setReviewOpener(openPanel);
