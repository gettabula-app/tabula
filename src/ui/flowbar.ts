import type { BoardApp } from '../app';
import type { Step, StepMode } from '../types';
import { isBox } from '../types';
import { newId } from '../store';
import { h, icon } from './dom';
import { popover, toast } from './common';
import { download, safeName } from '../exporters';
import { mountPollCard, openStepPoll, pollBarControls, pollResultsBlock, refreshAnswered } from './polls';

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

  const render = () => {
    const f = app.flow.state();
    const ro = app.readOnly;
    const resultsDots = f.active < 0 ? app.flow.resultsCount() : 0;
    const pollResults = f.active < 0 ? app.flow.polls.latestClosed() : undefined;
    bar.classList.toggle('show', f.steps.length > 0 || resultsDots > 0 || !!pollResults);
    if (!f.steps.length && !resultsDots && !pollResults) {
      bar.replaceChildren();
      return;
    }
    if (f.active < 0) {
      bar.classList.remove('running');
      const results = resultsDots
        ? h('div', { class: 'flow-results' },
          h('span', { class: 'results-dot', 'aria-hidden': 'true' }),
          h('div', null, h('div', { class: 'flow-title' }, 'Vote results'), h('div', { class: 'muted small' }, `${resultsDots} ${resultsDots === 1 ? 'dot' : 'dots'} on the board`)),
          h('button', { class: 'btn ghost', onclick: () => copyResults(app, f.results!) }, 'Copy results'),
          h('button', { class: 'btn ghost', disabled: ro, onclick: () => { app.flow.clearResults(); toast('Dots cleared'); } }, 'Clear dots'))
        : null;
      const poll = pollResults ? pollResultsBlock(app, pollResults) : null;
      const session = f.steps.length
        ? h('div', { class: 'flow-idle' },
          h('div', null, h('div', { class: 'flow-title' }, 'Session ready'), h('div', { class: 'muted small' }, `${f.steps.length} ${f.steps.length === 1 ? 'step' : 'steps'}, about ${Math.round(f.steps.reduce((s, x) => s + (x.durationSec ?? 0), 0) / 60)} minutes`)),
          h('button', { class: 'btn ghost', disabled: ro, onclick: (e: Event) => openSteps(app, e.currentTarget as HTMLElement) }, 'Edit steps'),
          h('button', { class: 'btn primary', disabled: ro, onclick: () => app.flow.start() }, icon('play', 16), 'Start session'))
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

    const timer = h('div', { class: `timer${rem !== null && rem <= 60_000 && rem > 0 ? ' warn' : ''}${rem === 0 ? ' done' : ''}`, role: 'timer', 'aria-label': rem !== null ? `${fmt(rem)} remaining` : 'No timer' },
      h('span', { class: 'timer-fill', style: `--p:${Math.min(1, Math.max(0, pct))}` }),
      h('span', { class: 'timer-num' }, rem !== null ? fmt(rem) : '–:––'),
    );
    const timerBtns = h('div', { class: 'btn-row' },
      running
        ? h('button', { class: 'icon-btn', title: 'Pause timer', 'aria-label': 'Pause timer', disabled: ro, onclick: () => app.flow.pauseTimer() }, icon('pause', 18))
        : h('button', { class: 'icon-btn', title: 'Start timer', 'aria-label': 'Start timer', disabled: ro, onclick: () => (rem === 0 || !f.timer ? app.flow.startTimer(step.durationSec ?? 300) : app.flow.startTimer()) }, icon('play', 18)),
      h('button', { class: 'icon-btn text', title: 'Add one minute', 'aria-label': 'Add one minute', disabled: ro, onclick: () => app.flow.addTime(60_000) }, '+1'),
    );

    const extras: HTMLElement[] = [];
    if ((step.mode === 'private-write' || step.mode === 'vote') && !f.reveal) {
      extras.push(h('button', { class: 'btn', disabled: ro, onclick: () => app.flow.reveal() }, icon('eye', 16), step.mode === 'vote' ? 'Reveal votes' : 'Reveal notes'));
    }
    if (step.mode === 'vote') {
      extras.push(dotsButton(app));
      if (f.reveal) extras.push(h('button', { class: 'btn', onclick: () => copyResults(app, step.id) }, 'Copy results'));
    }
    if (step.mode === 'poll' && step.pollId) extras.push(...pollBarControls(app, step.pollId));

    bar.replaceChildren(
      h('button', { class: 'icon-btn', title: 'Previous step', 'aria-label': 'Previous step', disabled: ro || f.active === 0, onclick: () => app.flow.prev() }, icon('prev', 18)),
      h('button', { class: 'flow-step', disabled: ro, onclick: (e: Event) => openSteps(app, e.currentTarget as HTMLElement), 'aria-label': 'All steps' },
        h('span', { class: 'step-count' }, `${f.active + 1}/${f.steps.length}`),
        h('span', { class: 'step-text' },
          h('span', { class: 'flow-title' }, h('span', { class: 'title-text', title: step.title }, step.title), h('span', { class: `mode mode-${step.mode}` }, MODE_LABEL[step.mode])),
          h('span', { class: 'step-instr' }, step.instructions)),
      ),
      timer, timerBtns, ...extras,
      h('button', { class: 'icon-btn', title: 'Bring everyone to my view', 'aria-label': 'Bring everyone to my view', disabled: ro, onclick: () => { app.flow.summon(); toast('Everyone is now looking where you are'); } }, icon('focus', 18)),
      f.active < f.steps.length - 1
        ? h('button', { class: 'btn primary', disabled: ro, onclick: () => app.flow.next() }, 'Next step', icon('next', 16))
        : h('button', { class: 'btn primary', disabled: ro, onclick: () => finish(app) }, 'Finish'),
    );

  };

  // Between flow changes only the timer readout updates, so focus and hover
  // on the bar's buttons are never disturbed.
  let wasRunning = false;
  const updateTimer = () => {
    const f = app.flow.state();
    const rem = app.flow.remainingMs();
    const running = app.flow.timerRunning();
    if (f.timer && rem !== null) {
      const key = `${f.timer.startedAt}:${f.timer.durationMs}`;
      if (rem === 0 && lastBeepKey !== key && !f.timer.pausedAt) {
        lastBeepKey = key;
        chime();
      }
    }
    if (running !== wasRunning) {
      wasRunning = running;
      render();
      return;
    }
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
  // A timer that already ran out before this screen opened does not chime.
  const t0 = app.flow.state().timer;
  if (t0 && app.flow.remainingMs() === 0) lastBeepKey = `${t0.startedAt}:${t0.durationMs}`;
  render();
  loop();
  app.onDestroy(() => clearInterval(tick));
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
  const b = h('button', {
    class: `votes-left${left === 0 ? ' none' : ''}`,
    disabled: app.readOnly,
    title: 'Click a note to add a dot, shift-click to remove one. Click here to change how many dots each person gets.',
    'aria-label': `${unlimited ? 'No dot limit' : `${left} of ${limit} dots left`}. Change dots per person`,
  }, ...body, icon('chevron', 14));
  b.addEventListener('click', () => openDotLimit(app, b));
  return b;
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
        const sel = h('select', { class: 'input', 'aria-label': `Step ${i + 1} dots per person`, title: 'Dots per person' },
          ...[...new Set([...DOT_CHOICES, cur > 0 ? cur : 1])].sort((a, b) => a - b).map((n) => h('option', { value: n, selected: n === cur }, `${n} ${n === 1 ? 'dot' : 'dots'}`)),
          h('option', { value: 0, selected: cur <= 0 }, 'No limit'));
        sel.addEventListener('change', () => save({ votesPerPerson: Number(sel.value) }));
        dots = sel;
      } else if (s.mode === 'poll') {
        dots = h('button', { class: 'btn ghost poll-btn poll-edit', disabled: locked, 'aria-label': `Edit poll in step ${i + 1}`, onclick: () => openStepPoll(app, s.id, draw) }, 'Edit poll');
      }
      return h('li', { class: i === f.active ? 'current' : '' },
        h('button', { class: 'icon-btn', title: 'Go to this step', 'aria-label': `Go to step ${i + 1}`, onclick: () => app.flow.goto(i) }, String(i + 1)),
        title, mins, h('span', { class: 'muted small' }, 'min'), mode, dots,
        h('button', { class: 'icon-btn', title: 'Remove step', 'aria-label': `Remove step ${i + 1}`, onclick: () => { app.flow.setSteps(app.flow.state().steps.filter((x) => x.id !== s.id)); draw(); } }, icon('trash', 18)),
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
