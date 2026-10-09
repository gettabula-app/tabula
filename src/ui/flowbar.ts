import type { BoardApp } from '../app';
import type { Step, StepMode } from '../types';
import { isBox } from '../types';
import { newId } from '../store';
import { UNLIMITED, type VoteScope } from '../flow';
import { h, icon } from './dom';
import { announce } from './announce';
import { rovingRadios } from './focus-scope';
import { popover, toast } from './common';
import { download, safeName } from '../exporters';
import { cooldownLabel } from '../focus-requests';
import { focusFor } from './focus';
import { mountPollCard, openStepPoll, pollBarControls, pollResultsBlock, refreshAnswered } from './polls';
import { NOTHING_HIDDEN, escapeHidesBar, hidePoll, hideShown, hideSession, idleShown, loadIdleHidden, reopenSession, saveIdleHidden, type IdleHidden } from './idle-bar';
import { aiBarFor, glyph, onAiBarChange } from './ai-bar';
import { dotsButtonTip, voteInstructionText } from './flowbar-logic';

const MODE_LABEL: Record<StepMode, string> = {
  write: 'Write', 'private-write': 'Private writing', cluster: 'Group', vote: 'Dot vote', discuss: 'Discuss', poll: 'Poll',
};

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Bottom bar that runs the facilitation flow: steps, timer, reveal, voting. */
export function mountFlowBar(app: BoardApp, parent: HTMLElement) {
  const bar = h('section', { class: 'flowbar tray', 'aria-label': 'Facilitation' });
  parent.appendChild(bar);
  mountPollCard(app, parent, bar);
  let tick = 0;
  let lastBeepKey = '';
  let warnedKey = '';
  let voteInstructionOpen = false;
  let voteInstructionStep: string | null = null;

  const hidden = () => loadIdleHidden(app.user.id, app.conn.id);
  const update = (change: (cur: IdleHidden) => IdleHidden) => {
    saveIdleHidden(app.user.id, app.conn.id, change(hidden()));
    app.emit('flow');
  };

  const render = () => {
    const f = app.flow.state();
    const ro = app.readOnly;
    const idle = f.active < 0;
    // A session that is running has started, so Session ready shows again once it ends.
    if (!idle && hidden().session) reopenSession(app.user.id, app.conn.id);
    const resultsDots = idle ? app.flow.resultsCount() : 0;
    const latest = idle ? app.flow.polls.latestClosed() : undefined;
    const shown = idleShown(idle ? hidden() : NOTHING_HIDDEN, { hasSteps: f.steps.length > 0, latestClosedId: latest?.id ?? null });
    const pollResults = shown.poll ? latest : undefined;
    const sessionReady = idle && shown.session;
    const anyIdle = resultsDots > 0 || !!pollResults || sessionReady;
    bar.classList.toggle('show', !idle || anyIdle);
    if (idle && !anyIdle) {
      bar.replaceChildren();
      return;
    }
    if (idle) {
      bar.classList.remove('running');
      const results = resultsDots
        ? h('div', { class: 'flow-results' },
          h('span', { class: 'results-dot', 'aria-hidden': 'true' }),
          h('div', null, h('div', { class: 'flow-title' }, 'Vote results'), h('div', { class: 'muted small' }, `${resultsDots} ${resultsDots === 1 ? 'dot' : 'dots'} on the board`)),
          h('button', { class: 'btn ghost', onclick: () => copyResults(app, f.results!) }, 'Copy results'),
          !ro && aiBarFor(app) ? h('button', {
            class: 'btn ghost', 'data-tip': 'Summarise the board with AI',
            onclick: () => aiBarFor(app)?.open({ arm: 'summarise', context: 'board' }),
          }, glyph('spark', 16), 'Summarise') : null,
          h('button', { class: 'btn ghost', disabled: ro, onclick: () => { app.flow.clearResults(); toast('Dots cleared'); } }, 'Clear dots'))
        : null;
      const poll = pollResults ? pollResultsBlock(app, pollResults, () => update((cur) => hidePoll(cur, pollResults.id))) : null;
      const session = sessionReady
        ? h('div', { class: 'flow-idle' },
          h('div', null, h('div', { class: 'flow-title' }, 'Session ready'), h('div', { class: 'muted small' }, `${f.steps.length} ${f.steps.length === 1 ? 'step' : 'steps'}, about ${Math.round(f.steps.reduce((s, x) => s + (x.durationSec ?? 0), 0) / 60)} minutes`)),
          h('button', { class: 'btn ghost', disabled: ro, onclick: (e: Event) => openSteps(app, e.currentTarget as HTMLElement) }, 'Edit steps'),
          h('button', { class: 'btn primary', disabled: ro, onclick: () => app.flow.start() }, icon('play', 16), 'Start session'),
          h('button', { class: 'icon-btn', 'aria-label': 'Hide', onclick: () => update(hideSession) }, icon('close', 18)))
        : null;
      const parts = [results, poll, session].filter(Boolean) as HTMLElement[];
      bar.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'bar-sep' }), p] : [p])));
      return;
    }
    bar.classList.add('running');
    const step = f.steps[f.active];
    const rem = app.flow.remainingMs();
    const running = app.flow.timerRunning();
    const pct = f.timer && rem !== null ? 1 - rem / f.timer.durationMs : 0;
    const voting = step.mode === 'vote';
    if (!voting || voteInstructionStep !== step.id) {
      voteInstructionStep = voting ? step.id : null;
      voteInstructionOpen = false;
    }
    const compactVote = voting && typeof matchMedia === 'function' && matchMedia('(max-width: 500px)').matches;
    const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const instructionText = voteInstructionText(step.instructions, voting && coarsePointer);
    bar.classList.toggle('vote-compact', compactVote);
    bar.classList.toggle('vote-instructions-open', compactVote && voteInstructionOpen);

    const timer = h('div', { class: `timer${rem !== null && rem <= 60_000 && rem > 0 ? ' warn' : ''}${rem === 0 ? ' done' : ''}`, role: 'timer', 'aria-label': rem !== null ? `${fmt(rem)} remaining` : 'No timer' },
      h('span', { class: 'timer-fill', style: `--p:${Math.min(1, Math.max(0, pct))}` }),
      h('span', { class: 'timer-num' }, rem !== null ? fmt(rem) : '–:––'),
    );
    const timerBtns = h('div', { class: 'btn-row flow-timer-buttons' },
      running
        ? h('button', { class: 'icon-btn', 'aria-label': 'Pause timer', disabled: ro, onclick: () => app.flow.pauseTimer() }, icon('pause', 18))
        : h('button', { class: 'icon-btn', 'aria-label': 'Start timer', disabled: ro, onclick: () => (rem === 0 || !f.timer ? app.flow.startTimer(step.durationSec ?? 300) : app.flow.startTimer()) }, icon('play', 18)),
      h('button', { class: 'icon-btn text', 'aria-label': 'Add one minute', disabled: ro, onclick: () => app.flow.addTime(60_000) }, '+1'),
    );

    const extras: HTMLElement[] = [];
    if ((step.mode === 'private-write' || step.mode === 'vote') && !f.reveal) {
      extras.push(h('button', {
        class: step.mode === 'vote' ? 'btn vote-reveal' : 'btn',
        disabled: ro,
        'aria-label': step.mode === 'vote' ? 'Reveal votes' : undefined,
        onclick: () => app.flow.reveal(),
      }, icon('eye', 16), step.mode === 'vote' ? 'Reveal votes' : 'Reveal notes'));
    }
    if (step.mode === 'vote') {
      extras.push(removeDotsButton(app, ro));
      extras.push(dotsButton(app));
      if (f.reveal) extras.push(h('button', { class: 'btn', onclick: () => copyResults(app, step.id) }, 'Copy results'));
    }
    if (step.mode === 'poll' && step.pollId) extras.push(...pollBarControls(app, step.pollId));

    const instruction = compactVote
      ? h('div', { class: 'vote-instructions', id: 'flow-vote-instructions', hidden: !voteInstructionOpen }, instructionText)
      : null;
    const info = compactVote
      ? h('button', {
        class: 'icon-btn vote-info',
        'aria-label': voteInstructionOpen ? 'Hide voting instructions' : 'Show voting instructions',
        'aria-expanded': String(voteInstructionOpen),
        'aria-controls': 'flow-vote-instructions',
        onclick: (e: Event) => {
          voteInstructionOpen = !voteInstructionOpen;
          instruction!.hidden = !voteInstructionOpen;
          bar.classList.toggle('vote-instructions-open', voteInstructionOpen);
          const button = e.currentTarget as HTMLButtonElement;
          button.setAttribute('aria-expanded', String(voteInstructionOpen));
          button.setAttribute('aria-label', voteInstructionOpen ? 'Hide voting instructions' : 'Show voting instructions');
        },
      }, 'Info')
      : null;

    bar.replaceChildren(
      h('button', { class: 'icon-btn flow-previous', 'aria-label': 'Previous step', disabled: ro || f.active === 0, onclick: () => app.flow.prev() }, icon('prev', 18)),
      h('button', { class: 'flow-step', disabled: ro, onclick: (e: Event) => openSteps(app, e.currentTarget as HTMLElement), 'aria-label': 'All steps' },
        h('span', { class: 'step-count' }, `${f.active + 1}/${f.steps.length}`),
        h('span', { class: 'step-text' },
          h('span', { class: 'flow-title' }, h('span', { class: 'title-text', title: step.title }, step.title), h('span', { class: `mode mode-${step.mode}` }, MODE_LABEL[step.mode])),
          h('span', { class: 'step-instr' }, instructionText)),
      ),
      timer, timerBtns, ...extras,
      ...(instruction ? [instruction] : []), ...(info ? [info] : []),
      askButton(app),
      f.active < f.steps.length - 1
        ? h('button', { class: 'btn primary flow-next', 'aria-label': 'Next step', disabled: ro, onclick: () => app.flow.next() }, 'Next step', icon('next', 16))
        : h('button', { class: `btn primary${voting ? ' vote-finish' : ''}`, disabled: ro, onclick: () => finish(app) }, 'Finish'),
    );

  };

  const offAiBar = onAiBarChange(app, (why) => { if (why === 'mount') render(); });
  app.onDestroy(offAiBar);

  // Between flow changes only the timer readout updates, so focus and hover
  // on the bar's buttons are never disturbed.
  let wasRunning = false;
  let timerChecked = false;
  const updateTimer = () => {
    const f = app.flow.state();
    const rem = app.flow.remainingMs();
    const running = app.flow.timerRunning();
    if (f.timer && rem !== null) {
      const key = `${f.timer.startedAt}:${f.timer.durationMs}`;
      if (rem === 0 && lastBeepKey !== key && !f.timer.pausedAt) {
        lastBeepKey = key;
        chime();
        announce('Time is up');
      }
    }
    if (running !== wasRunning) {
      // a timer already running when the bar first draws (someone joined late) is not announced as started
      if (timerChecked) {
        if (running) announce('Timer started');
        else if (f.timer && rem) announce('Timer paused');
      }
      wasRunning = running;
      render();
      return;
    }
    timerChecked = true;
    const el = bar.querySelector<HTMLElement>('.timer');
    if (!el || !f.timer || rem === null) return;
    el.querySelector('.timer-num')!.textContent = fmt(rem);
    (el.querySelector('.timer-fill') as HTMLElement).style.setProperty('--p', String(Math.min(1, 1 - rem / f.timer.durationMs)));
    el.classList.toggle('warn', rem <= 60_000 && rem > 0);
    el.classList.toggle('done', rem === 0);
    el.setAttribute('aria-label', `${fmt(rem)} remaining`);
    const timerKey = `${f.timer.startedAt}:${f.timer.durationMs}`;
    if (rem <= 60_000 && rem > 58_000 && warnedKey !== timerKey && running) {
      warnedKey = timerKey;
      toast('One minute left');
    }
  };
  const loop = () => {
    clearInterval(tick);
    wasRunning = app.flow.timerRunning();
    if (app.flow.state().timer) tick = window.setInterval(updateTimer, 250);
  };
  app.on('flow', () => {
    render();
    loop();
  });
  app.on('readonly', render);
  app.on('presence', () => refreshAnswered(app, bar));
  // A press not yet released is a drag in progress, which the board handles.
  let pressed = false;
  const onPress = () => { pressed = true; };
  const onRelease = () => { pressed = false; };
  // Capture phase: this runs before the board's own Esc handler, so a key that hides the bar is not also acted on by the board.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || app.flow.state().active >= 0) return;
    const f = app.flow.state();
    const latest = app.flow.polls.latestClosed();
    const shown = idleShown(hidden(), { hasSteps: f.steps.length > 0, latestClosedId: latest?.id ?? null });
    if (!shown.session && !shown.poll) return;
    const a = document.activeElement as HTMLElement | null;
    const typing = !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
    const free = escapeHidesBar({
      selected: app.selection.length, tool: app.tool.kind, dragging: app.dragging || pressed, editing: app.editor.active,
      threadOpen: app.openThreadId !== null, typing, dialogOpen: !!document.querySelector('[role="dialog"]'),
    });
    if (!free) return;
    e.stopImmediatePropagation();
    update((cur) => hideShown(cur, shown, latest?.id ?? null));
  };
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);
  window.addEventListener('keydown', onEscape, true);
  app.onDestroy(() => {
    window.removeEventListener('pointerdown', onPress, true);
    window.removeEventListener('pointerup', onRelease, true);
    window.removeEventListener('pointercancel', onRelease, true);
    window.removeEventListener('keydown', onEscape, true);
  });
  // A timer that already ran out before this screen opened does not chime.
  const t0 = app.flow.state().timer;
  if (t0 && app.flow.remainingMs() === 0) lastBeepKey = `${t0.startedAt}:${t0.durationMs}`;
  render();
  loop();
  app.onDestroy(() => clearInterval(tick));
}

const ASK_LABEL = 'Ask everyone to look here';

/**
 * Sends a request, not a command: it moves nobody. It is not tied to editing, so people with view-only access can ask too.
 * After a request it waits 10 seconds, and the tooltip counts down. The bar is redrawn often, so the countdown lives in the
 * focus controller and each button repaints itself once a second until it is replaced or ready.
 */
function askButton(app: BoardApp): HTMLElement {
  const focus = focusFor(app);
  const b = h('button', { class: 'icon-btn flow-ask', 'aria-label': ASK_LABEL }, icon('focus', 18));
  let timer = 0;
  const paint = () => {
    const left = focus?.cooldownLeft() ?? 0;
    b.disabled = !focus || left > 0;
    b.dataset.tip = left > 0 ? cooldownLabel(left) : ASK_LABEL;
    if (left <= 0 || !b.isConnected) clearInterval(timer);
  };
  const countdown = () => {
    clearInterval(timer);
    if ((focus?.cooldownLeft() ?? 0) > 0) timer = window.setInterval(paint, 1000);
  };
  b.addEventListener('click', () => {
    if (!focus?.ask()) return;
    toast('Asked everyone to look at your view');
    paint();
    countdown();
  });
  paint();
  countdown();
  return b;
}

function removeDotsButton(app: BoardApp, readOnly: boolean): HTMLElement {
  const enabled = app.flow.isRemoveDotsMode();
  return h('button', {
    class: 'btn remove-dots-toggle',
    disabled: readOnly,
    'aria-pressed': String(enabled),
    onclick: () => {
      const next = !app.flow.isRemoveDotsMode();
      if (app.flow.setRemoveDotsMode(next)) announce(next ? 'Remove dots on' : 'Remove dots off');
    },
  }, icon('minus', 16), 'Remove dots');
}

function finish(app: BoardApp) {
  const hadVote = app.flow.state().steps.some((s) => s.mode === 'vote');
  app.flow.end();
  toast(hadVote ? 'Finished. The dots stay on the board until you clear them.' : 'Session finished. Export a summary from the menu.');
}

function copyResults(app: BoardApp, stepId: string) {
  const ranked = app.flow.ranked(stepId);
  if (!ranked.length) return toast('No dots placed yet');
  const md = ranked.map((r, i) => `${i + 1}. ${((isBox(r.item) && (r.item.text || r.item.name)) || 'Item').replace(/\s+/g, ' ')} (${r.votes})`).join('\n');
  navigator.clipboard.writeText(md).then(() => toast('Ranked results copied'), () => toast('Clipboard is not available'));
}

let lastDots: { step: string; text: string } | null = null;

/** What this person has left, shown as dots; opens the per-person limit. */
function dotsButton(app: BoardApp): HTMLElement {
  const step = app.flow.activeStep()!;
  const limit = app.flow.voteLimit(step);
  const mine = app.flow.myVoteCount(step);
  const unlimited = app.flow.isUnlimited(step);
  const left = unlimited ? Infinity : Math.max(0, limit - mine);
  let body: (HTMLElement | string)[];
  if (unlimited) {
    body = [h('span', { class: 'dot on' }), h('span', null, mine ? `${mine} placed, no limit` : 'No limit')];
  } else if (limit <= 10) {
    body = [...Array.from({ length: limit }, (_, i) => h('span', { class: i < left ? 'dot on' : 'dot' })), h('span', null, left ? `${left} left` : 'All dots used')];
  } else {
    body = [h('span', { class: 'dot on' }), h('span', null, left ? `${left} of ${limit} left` : 'All dots used')];
  }
  // placing or removing a dot changes this count; say it once the person stops clicking
  const said = unlimited ? `${mine} dots placed` : `${left} of ${limit} dots left`;
  if (lastDots && lastDots.step === step.id && lastDots.text !== said) announce(said, { key: 'dots', delay: 500 });
  lastDots = { step: step.id, text: said };
  const b = h('button', {
    class: `votes-left${left === 0 ? ' none' : ''}`,
    disabled: app.readOnly,
    'data-tip': dotsButtonTip(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches),
    'aria-label': `${unlimited ? 'No dot limit' : `${left} of ${limit} dots left`}. Change dots per person`,
  }, ...body, h('span', { class: 'vote-compact-count', 'aria-hidden': 'true' }, unlimited ? '∞' : String(left)), icon('chevron', 14));
  b.addEventListener('click', () => openDotLimit(app, b));
  return b;
}

/** Starts a no-limit dot vote on `scope` and says what it covers. */
export function startVote(app: BoardApp, scope: VoteScope) {
  app.flow.quickVote(UNLIMITED, scope);
  const n = app.flow.eligible(scope).length;
  const addVerb = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';
  toast(`Dot vote started on ${n} ${n === 1 ? 'item' : 'items'}, no limit. ${addVerb} one to add a dot.`);
}

/** The step before a quick dot vote: what can be voted on, with a count and a default (TAB-232). */
export function openVoteSetup(app: BoardApp, anchor: HTMLElement) {
  const chosen = app.selection.filter((id) => app.flow.canVote({ id: '', title: '', instructions: '', mode: 'vote', voteScope: 'selection', voteItems: [id] }, app.store.get(id)));
  const scopes: { key: 'all' | 'selection' | 'stickies'; label: string; scope: VoteScope; hint: string }[] = [
    { key: 'selection', label: 'Selected items', scope: { kind: 'selection', ids: chosen }, hint: 'Only what you have selected now, frames included.' },
    { key: 'all', label: 'Everything', scope: { kind: 'all' }, hint: 'Every note, shape, card, text and image on the board.' },
    { key: 'stickies', label: 'Sticky notes only', scope: { kind: 'stickies' }, hint: 'Just the sticky notes.' },
  ];
  const counts = new Map(scopes.map((s) => [s.key, app.flow.eligible(s.scope).length]));
  let pick: 'all' | 'selection' | 'stickies' = chosen.length > 0 ? 'selection' : 'all';
  const radios = h('div', { class: 'vote-scope', role: 'radiogroup', 'aria-label': 'What can be voted on' });
  const summary = h('p', { class: 'muted small', 'aria-live': 'polite' });
  let pop: ReturnType<typeof popover>;
  const start = h('button', { class: 'btn primary' }, 'Start vote');
  const sync = () => {
    for (const b of Array.from(radios.children) as HTMLElement[]) {
      const on = b.dataset.key === pick;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    const n = counts.get(pick) ?? 0;
    summary.textContent = `${n} ${n === 1 ? 'item' : 'items'} can be voted on.`;
    (start as HTMLButtonElement).disabled = n === 0;
  };
  for (const s of scopes) {
    const n = counts.get(s.key) ?? 0;
    const b = h('button', { role: 'radio', 'data-key': s.key, 'aria-checked': 'false', disabled: s.key === 'selection' && chosen.length === 0, onclick: () => { pick = s.key; sync(); } },
      h('span', { class: 'vs-label' }, s.label, h('span', { class: 'vs-count' }, s.key === 'selection' && chosen.length === 0 ? 'select items first' : String(n))),
      h('span', { class: 'muted small' }, s.hint));
    radios.append(b);
  }
  rovingRadios(radios, { select: false });
  start.addEventListener('click', () => {
    const scope = scopes.find((s) => s.key === pick)!.scope;
    pop.close();
    startVote(app, scope);
  });
  sync();
  pop = popover(anchor, h('div', { class: 'dots-pop vote-setup' },
    h('div', { class: 'pop-head' }, h('h3', null, 'What can be voted on?')),
    radios,
    summary,
    h('div', { class: 'copy-row' }, start, h('button', { class: 'btn', onclick: () => { pop.close(); startVote(app, { kind: 'all' }); } }, 'Start on everything')),
    h('p', { class: 'muted small' }, 'Everyone gets as many dots as they like. You can change that from the bar once the vote runs.'),
  ), { side: 'right' });
}

const PRESETS = [1, 2, 3, 5, 10];

function openDotLimit(app: BoardApp, anchor: HTMLElement) {
  const step = app.flow.activeStep();
  if (!step) return;
  const people = app.participants().length;
  const cur = app.flow.voteLimit(step);
  const stats = app.flow.voteStats(step);
  const custom = h('input', { class: 'input', type: 'number', min: '1', max: '999', value: cur > 0 && !PRESETS.includes(cur) ? String(cur) : '', placeholder: 'Any number', 'aria-label': 'Dots per person' });
  let pop: ReturnType<typeof popover>;
  const set = (n: number) => {
    app.flow.setVoteLimit(n);
    pop.close();
    toast(n > 0 ? `Everyone now has ${n} ${n === 1 ? 'dot' : 'dots'}` : 'No dot limit: vote as much as you like');
  };
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && Number(custom.value) > 0) set(Number(custom.value));
  });
  const opts = h('div', { class: 'dot-presets', role: 'radiogroup', 'aria-label': 'Dots per person' },
    ...PRESETS.map((n) => h('button', { class: cur === n ? 'on' : '', role: 'radio', 'aria-checked': String(cur === n), onclick: () => set(n) }, String(n))),
    h('button', { class: `wide${cur <= 0 ? ' on' : ''}`, role: 'radio', 'aria-checked': String(cur <= 0), onclick: () => set(0) }, 'No limit'),
  );
  rovingRadios(opts, { select: false });
  pop = popover(anchor, h('div', { class: 'dots-pop' },
    h('div', { class: 'pop-head' }, h('h3', null, 'Dots per person')),
    opts,
    h('div', { class: 'copy-row' }, custom, h('button', { class: 'btn', onclick: () => Number(custom.value) > 0 && set(Number(custom.value)) }, 'Set')),
    h('p', { class: 'muted small' }, `${people} ${people === 1 ? 'person' : 'people'} on the board. ${stats.dots} ${stats.dots === 1 ? 'dot' : 'dots'} placed by ${stats.voters} so far.`),
    h('p', { class: 'muted small' }, 'Changes apply to everyone straight away. Dots already placed are kept.'),
  ), { side: 'top' });
  requestAnimationFrame(() => custom.focus());
}

const DOT_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];

function openSteps(app: BoardApp, anchor: HTMLElement) {
  reopenSession(app.user.id, app.conn.id);
  const list = h('ol', { class: 'step-list' });
  const draw = () => {
    const f = app.flow.state();
    list.replaceChildren(...f.steps.map((s, i) => {
      const poll = s.pollId ? app.flow.polls.get(s.pollId) : undefined;
      const locked = poll?.openedAt !== undefined;
      const title = h('input', { class: 'input', value: s.title, disabled: s.mode === 'poll', 'aria-label': `Step ${i + 1} title` });
      const mins = h('input', { class: 'input mins', type: 'number', min: '0', max: '120', value: String(Math.round((s.durationSec ?? 0) / 60)), 'aria-label': `Step ${i + 1} minutes` });
      const mode = h('select', { class: 'input', disabled: locked, 'aria-label': `Step ${i + 1} mode` }, ...(Object.keys(MODE_LABEL) as StepMode[]).map((m) => h('option', { value: m, selected: m === s.mode }, MODE_LABEL[m])));
      const save = (patch: Partial<Step>) => {
        const steps = app.flow.state().steps.map((x) => (x.id === s.id ? { ...x, ...patch } : x));
        app.flow.setSteps(steps);
      };
      title.addEventListener('change', () => save({ title: title.value }));
      mins.addEventListener('change', () => save({ durationSec: Number(mins.value) * 60 || undefined }));
      mode.addEventListener('change', () => {
        if (mode.value === 'poll') {
          mode.value = s.mode;
          openStepPoll(app, s.id, draw);
          return;
        }
        save({ mode: mode.value as StepMode, votesPerPerson: mode.value === 'vote' ? s.votesPerPerson ?? 3 : undefined, pollId: undefined });
        draw();
      });
      let dots: HTMLElement = h('span');
      if (s.mode === 'vote') {
        const cur = s.votesPerPerson ?? 3;
        const sel = h('select', { class: 'input', 'aria-label': `Step ${i + 1} dots per person`, 'data-tip': 'Dots per person' },
          ...[...new Set([...DOT_CHOICES, cur > 0 ? cur : 1])].sort((a, b) => a - b).map((n) => h('option', { value: n, selected: n === cur }, `${n} ${n === 1 ? 'dot' : 'dots'}`)),
          h('option', { value: 0, selected: cur <= 0 }, 'No limit'));
        sel.addEventListener('change', () => save({ votesPerPerson: Number(sel.value) }));
        dots = sel;
      } else if (s.mode === 'poll') {
        dots = h('button', { class: 'btn ghost poll-btn poll-edit', disabled: locked, 'aria-label': `Edit poll in step ${i + 1}`, onclick: () => openStepPoll(app, s.id, draw) }, 'Edit poll');
      }
      return h('li', { class: i === f.active ? 'current' : '' },
        h('button', { class: 'icon-btn', 'data-tip': 'Go to this step', 'aria-label': `Go to step ${i + 1}`, onclick: () => app.flow.goto(i) }, String(i + 1)),
        title, mins, h('span', { class: 'muted small' }, 'min'), mode, dots,
        h('button', { class: 'icon-btn', 'data-tip': 'Remove step', 'aria-label': `Remove step ${i + 1}`, onclick: () => { app.flow.setSteps(app.flow.state().steps.filter((x) => x.id !== s.id)); draw(); } }, icon('trash', 18)),
      );
    }));
  };
  draw();
  const addBtn = h('button', { class: 'btn', onclick: () => {
    const sel = app.selected().find((o) => o.type === 'frame');
    const steps = [...app.flow.state().steps, { id: newId(), title: 'New step', instructions: 'Describe what people should do.', mode: 'write' as StepMode, durationSec: 300, frameId: sel?.id }];
    app.flow.setSteps(steps);
    draw();
  } }, icon('plus', 16), 'Add step');
  popover(anchor, h('div', { class: 'steps-pop' },
    h('div', { class: 'pop-head' }, h('h3', null, 'Steps')),
    h('p', { class: 'muted small' }, 'Select a frame before adding a step to focus everyone on it.'),
    list,
    h('div', { class: 'btn-row' }, addBtn,
      h('button', { class: 'btn ghost', onclick: () => download(app.flow.summaryMarkdown(), `${safeName(app.store.getMeta().name)}-summary.md`, 'text/markdown') }, icon('download', 16), 'Summary'),
      app.flow.state().active >= 0 ? h('button', { class: 'btn ghost', onclick: () => app.flow.end() }, 'End session') : null,
    ),
  ), { side: 'top', className: 'wide' });
}

let audio: AudioContext | null = null;
function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [[0, 880], [0.18, 1318]] as const) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i);
      g.gain.exponentialRampToValueAtTime(0.18, t + i + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(t + i);
      o.stop(t + i + 0.55);
    }
  } catch { /* audio unavailable */ }
}
