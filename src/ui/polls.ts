import type { BoardApp } from '../app';
import type { Id, Poll } from '../types';
import { POLL_LIMITS, answeredLabel, countPeople, type PollInput, type PollTally } from '../polls';
import { h, icon } from './dom';
import { dialog, field, popover, toast } from './common';
import { reopenPollResults } from './idle-bar';
import { POLL_LIST_MIN, pollCardBox } from './poll-layout';
import './polls.css';

/** The fade on a list's bottom edge shows while more of it is below. */
function showMore(list: HTMLElement) {
  list.classList.toggle('more', list.scrollHeight - list.clientHeight - list.scrollTop > 2);
}

/** "N of M answered" for the card and the bar alike. */
function answeredText(app: BoardApp, pollId: Id): string {
  return answeredLabel(app.flow.polls.tally(pollId).responses, countPeople(app.participants()));
}

/** Rewrites the "N of M answered" texts under `root` in place, so cursor moves do not redraw the card or bar. */
export function refreshAnswered(app: BoardApp, root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-answered]').forEach((el) => {
    el.textContent = answeredText(app, el.dataset.answered!);
  });
}

/** Runs an action; a refusal shows its reason. */
function attempt(fn: () => void, done?: string) {
  try {
    fn();
    if (done) toast(done);
  } catch (e) {
    toast((e as Error).message);
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function copyResults(app: BoardApp, pollId: Id) {
  let text: string;
  try {
    text = app.flow.polls.copyText(pollId);
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  navigator.clipboard.writeText(text).then(() => toast('Results copied'), () => toast('Clipboard is not available'));
}

function resultsList(tally: PollTally): HTMLElement {
  return h('div', { class: 'poll-results-block' },
    h('span', { class: 'poll-label' }, 'Ranked results'),
    h('ol', { class: 'poll-results' }, ...tally.rows.map((r, i) => h('li', null,
      h('div', { class: 'poll-row-head' },
        h('span', null, `${i + 1}. ${r.option.text}`),
        h('span', null, r.pct === null ? `${r.count}` : `${r.count} · ${r.pct}%`)),
      h('div', { class: 'poll-bar' }, h('span', { style: { width: `${r.pct ?? 0}%` } })),
      r.names.length ? h('div', { class: 'poll-names' }, r.names.join(', ')) : null))));
}

/** The answering card: options while open, the ranked list once revealed. Only the list scrolls. */
function pollBody(app: BoardApp, poll: Poll): HTMLElement {
  const polls = app.flow.polls;
  const tally = polls.tally(poll.id);
  const mine = polls.mine(poll.id)?.optionIds ?? [];
  const open = polls.isOpen(poll.id);
  const canAnswer = open && !app.readOnly;
  const canClear = canAnswer && mine.length > 0;
  const status = poll.revealed ? plural(tally.responses, 'response', 'responses') : answeredText(app, poll.id);
  const questionId = `poll-q-${poll.id}`;
  const choices = poll.options.map((o) => {
    const input = h('input', { type: poll.multiple ? 'checkbox' : 'radio', name: `poll-${poll.id}`, checked: mine.includes(o.id), 'data-option': o.id });
    input.addEventListener('change', () => attempt(() => polls.choose(poll.id, o.id)));
    return h('label', { class: 'poll-choice' }, input, h('span', null, o.text));
  });
  const note = canAnswer
    ? 'Your answer saves as you choose and can change until the poll closes.'
    : open ? 'View only. Only people who can edit the board can answer.' : 'This poll is closed.';
  return h('div', { class: 'poll-body' },
    h('div', { class: 'poll-head' }, h('span', { class: 'poll-label' }, 'Poll'),
      h('span', { class: 'poll-label', 'data-answered': poll.revealed ? undefined : poll.id }, status)),
    h('h2', { class: 'poll-question', id: questionId }, poll.question),
    h('div', { class: 'poll-scroll', onscroll: (e: Event) => showMore(e.currentTarget as HTMLElement) },
      h('fieldset', { class: 'poll-choices', disabled: !canAnswer, 'aria-labelledby': questionId }, ...choices),
      poll.revealed ? resultsList(tally) : null),
    h('div', { class: 'poll-foot' },
      h('span', { class: 'poll-note' }, note),
      h('button', {
        class: `btn ghost poll-btn poll-clear${canClear ? '' : ' is-reserved'}`, disabled: !canClear,
        onclick: () => attempt(() => polls.clearMine(poll.id)),
      }, 'Clear my answer')),
  );
}

/** Docked above the session bar; shown while the running step is a poll. */
export function mountPollCard(app: BoardApp, parent: HTMLElement, bar: HTMLElement) {
  const card = h('section', { class: 'poll-card', 'aria-label': 'Poll', hidden: true });
  parent.appendChild(card);
  // Sized from what is on screen: the room between the top bar and the session bar's real height, never less than the card's header plus three rows.
  const place = () => {
    const scroll = card.querySelector<HTMLElement>('.poll-scroll');
    if (card.hidden || !scroll) return;
    const inset = parseFloat(getComputedStyle(bar).bottom) || 12;
    const dock = inset + bar.offsetHeight + 12;
    const top = parseFloat(getComputedStyle(card).getPropertyValue('--panel-top')) || 72;
    const viewport = card.parentElement?.clientHeight ?? window.innerHeight;
    const overhead = card.offsetHeight - scroll.clientHeight;
    const list = scroll.scrollHeight;
    const box = pollCardBox({ viewport, top, dock, natural: overhead + list, minimum: overhead + Math.min(POLL_LIST_MIN, list) });
    card.style.bottom = `${box.bottom}px`;
    card.style.maxHeight = `${box.height}px`;
    showMore(scroll);
  };
  new ResizeObserver(place).observe(bar);
  window.addEventListener('resize', place);
  app.on('presence', () => refreshAnswered(app, card));
  const render = () => {
    const f = app.flow.state();
    const step = f.active >= 0 ? f.steps[f.active] : undefined;
    const poll = step?.pollId ? app.flow.polls.get(step.pollId) : undefined;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.option;
    card.hidden = !poll;
    if (!poll) {
      card.replaceChildren();
      return;
    }
    // Every answer redraws the card; keep the list where the person had scrolled it.
    const scrolled = card.dataset.poll === poll.id ? card.querySelector<HTMLElement>('.poll-scroll')?.scrollTop ?? 0 : 0;
    card.dataset.poll = poll.id;
    card.replaceChildren(pollBody(app, poll));
    const list = card.querySelector<HTMLElement>('.poll-scroll');
    if (list) list.scrollTop = scrolled;
    // Redrawing would drop keyboard focus from the option being arrowed through.
    if (focused) card.querySelector<HTMLInputElement>(`input[data-option="${focused}"]`)?.focus();
    place();
  };
  app.on('flow', render);
  app.on('readonly', render);
  render();
}

/** Bar buttons for a running poll step: reveal before it is revealed, then copy and sticky. */
export function pollBarControls(app: BoardApp, pollId: Id): HTMLElement[] {
  const polls = app.flow.polls;
  const poll = polls.get(pollId);
  if (!poll) return [];
  if (!poll.revealed) {
    return [
      h('span', { class: 'poll-label poll-chip', 'data-answered': pollId }, answeredText(app, pollId)),
      h('button', { class: 'btn primary poll-btn', disabled: app.readOnly, onclick: () => attempt(() => polls.reveal(pollId)) }, icon('eye', 16), 'Reveal results'),
    ];
  }
  return [
    h('button', { class: 'btn ghost poll-btn', onclick: () => copyResults(app, pollId) }, icon('copy', 16), 'Copy results'),
    h('button', { class: 'btn ghost poll-btn', disabled: app.readOnly, onclick: () => attempt(() => polls.addResultsSticky(pollId), 'Results added to the board') }, 'Add results to board'),
  ];
}

/** Session bar, idle state: the latest closed poll with its actions. */
export function pollResultsBlock(app: BoardApp, poll: Poll, onHide: () => void): HTMLElement {
  const polls = app.flow.polls;
  const responses = polls.tally(poll.id).responses;
  return h('div', { class: 'poll-summary' },
    h('div', { class: 'poll-summary-text' },
      h('span', { class: 'poll-label' }, 'Poll results'),
      h('span', { class: 'muted small' }, `${poll.question} · ${plural(responses, 'response', 'responses')}`)),
    h('button', { class: 'btn ghost poll-btn', disabled: !poll.revealed, onclick: () => copyResults(app, poll.id) }, icon('copy', 16), 'Copy results'),
    h('button', { class: 'btn ghost poll-btn', disabled: !poll.revealed || app.readOnly, onclick: () => attempt(() => polls.addResultsSticky(poll.id), 'Results added to the board') }, 'Add results to board'),
    poll.revealed ? null : h('button', { class: 'btn primary poll-btn', disabled: app.readOnly, onclick: () => attempt(() => polls.reveal(poll.id)) }, icon('eye', 16), 'Reveal results'),
    h('button', { class: 'btn ghost poll-btn', disabled: app.readOnly, onclick: () => attempt(() => app.flow.clearPoll(poll.id), 'Poll cleared') }, icon('trash', 16), 'Clear poll'),
    h('button', { class: 'icon-btn', 'aria-label': 'Hide', onclick: onHide }, icon('close', 18)),
  );
}

/** The composer shared by the quick poll popover and the step editor dialog. */
function composer(initial: PollInput | null, submitLabel: string, onSubmit: (input: PollInput) => void, onCancel: () => void): HTMLElement {
  const question = h('input', { class: 'input', maxlength: String(POLL_LIMITS.question), placeholder: 'Ask a question', 'aria-label': 'Question', value: initial?.question ?? '' });
  const multiple = h('input', { type: 'checkbox', checked: initial?.multiple ?? false });
  const anonymous = h('input', { type: 'checkbox', checked: initial?.anonymous ?? true });
  const options = initial ? [...initial.options] : ['', ''];
  const list = h('ol', { class: 'poll-compose-options' });
  const add = h('button', { class: 'btn ghost', type: 'button', onclick: () => { options.push(''); draw(options.length - 1); } }, icon('plus', 16), 'Add option');
  // Focus moves to the new option's field, so typing never reaches the board's tool shortcuts.
  const draw = (focus = -1) => {
    list.replaceChildren(...options.map((text, i) => {
      const input = h('input', { class: 'input', maxlength: String(POLL_LIMITS.option), value: text, placeholder: `Option ${i + 1}`, 'aria-label': `Option ${i + 1}` });
      input.addEventListener('input', () => { options[i] = input.value; });
      const remove = h('button', {
        class: 'icon-btn', type: 'button', disabled: options.length <= POLL_LIMITS.minOptions, 'aria-label': `Remove option ${i + 1}`,
        onclick: () => { options.splice(i, 1); draw(); },
      }, icon('close', 16));
      return h('li', null, input, remove);
    }));
    add.disabled = options.length >= POLL_LIMITS.maxOptions;
    if (focus >= 0) list.querySelectorAll<HTMLInputElement>('input')[focus]?.focus();
  };
  draw();
  const submit = () => attempt(() => onSubmit({ question: question.value, options: [...options], multiple: multiple.checked, anonymous: anonymous.checked }));
  const root = h('div', { class: 'poll-compose' },
    field('Question', question),
    h('div', { class: 'field poll-options' },
      h('div', { class: 'field-label' }, 'Options'),
      h('div', { class: 'poll-compose-list' }, h('div', { class: 'poll-compose-scroll' }, list), add)),
    h('label', { class: 'poll-check' }, multiple, h('span', null, 'More than one answer')),
    h('label', { class: 'poll-check' }, anonymous, h('span', null, 'Anonymous (names stay hidden)')),
    h('div', { class: 'btn-row poll-compose-actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: onCancel }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: submit }, submitLabel)),
  );
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  return root;
}

/** Puts the cursor in the question once the composer is in the page. Synchronous: animation frames do not run in a hidden tab. */
function focusQuestion(root: HTMLElement) {
  root.querySelector<HTMLInputElement>('input[aria-label="Question"]')?.focus();
}

/** Quick poll from the rail: a popover that starts the poll on save. */
export function openQuickPoll(app: BoardApp, anchor: HTMLElement) {
  // The poll tool brings back a hidden poll result, and starting a poll does too.
  reopenPollResults(app.user.id, app.conn.id);
  app.emit('flow');
  if (app.flow.pollOpen()) {
    toast('A poll is open. Finish it or move on first.');
    return;
  }
  let pop: { close: () => void } | undefined;
  const close = () => pop?.close();
  const body = composer(null, 'Start poll', (input) => {
    app.flow.quickPoll(input);
    close();
    toast('Poll started. Answers show above the bar.');
  }, close);
  pop = popover(anchor, body, { side: 'right', className: 'poll-pop' });
  focusQuestion(body);
}

/** Step editor: create or edit the poll of a step. `onDone` runs after save or cancel. */
export function openStepPoll(app: BoardApp, stepId: Id, onDone: () => void) {
  const step = app.flow.state().steps.find((s) => s.id === stepId);
  if (!step) return;
  const poll = step.pollId ? app.flow.polls.get(step.pollId) : undefined;
  const initial: PollInput = poll
    ? { question: poll.question, options: poll.options.map((o) => o.text), multiple: poll.multiple, anonymous: poll.anonymous }
    : { question: '', options: ['', ''], multiple: false, anonymous: true };
  let d: ReturnType<typeof dialog> | undefined;
  const done = () => {
    d?.close();
    onDone();
  };
  const body = composer(initial, 'Save poll', (input) => {
    app.flow.setStepPoll(stepId, input);
    done();
  }, done);
  d = dialog('Poll', body);
  focusQuestion(body);
}
