import type { BoardApp } from './app';
import type { BaseObj, Id, Obj, Poll, Rect, Step, Vote } from './types';
import { isBox, isConnector } from './types';
import { newId, type FlowState } from './store';
import { boxBounds } from './geometry';
import { Polls, PollError, pollInstructions, type PollInput } from './polls';

/** `votesPerPerson` value meaning no limit. */
export const UNLIMITED = 0;

const VOTABLE = (o: Obj) => isBox(o) && o.type !== 'frame' && o.type !== 'path' && o.type !== 'container' && o.type !== 'lane' && !isConnector(o);

/**
 * Facilitation: a scripted sequence of steps run on the board. All state lives
 * in the shared doc (timer as start time + duration), so every participant's
 * screen agrees and counts down locally, even offline.
 */
/** How a picture reads in the Markdown summary: its description, else what it is (docs/images.md). */
export function imageLine(o: BaseObj): string {
  const alt = typeof o.alt === 'string' ? o.alt.replace(/\s+/g, ' ').trim() : '';
  if (alt) return `Image: ${alt}`;
  const w = Math.round(o.nw ?? o.w);
  const h = Math.round(o.nh ?? o.h);
  return `Image (${o.mime ?? 'image'}, ${w} x ${h})`;
}

/**
 * User text as one line of Markdown that reads as typed: line breaks (NEL and the Unicode separators too) fold to a space,
 * the characters that start emphasis, code, links, images, HTML, tables or a character reference are escaped, and so is a
 * leading `#`, `>`, `-`, `+` or `1.` that would make a block of a bullet's text.
 */
export function mdText(t: string | undefined): string {
  return (t ?? '').replace(/[\s\u0085\u2028\u2029]+/g, ' ').trim().replace(/[\\`*_[\]<>|~&]/g, '\\$&').replace(/^(#|>|-|\+)/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}

export class Flow {
  private lastActive = -2;
  readonly polls: Polls;
  /**
   * Called on the screen where someone moved the session to a step that has a frame, after this screen flew there.
   * The focus prompts use it to tell the others; nothing here moves their view.
   */
  onLocalStep: ((step: Step, frame: Rect) => void) | null = null;

  constructor(private app: BoardApp) {
    const s = app.store;
    this.polls = new Polls(app);
    s.flow.observe((_e, tx) => this.onFlowChange(tx.local));
    s.votes.observe(() => this.refreshVotes());
    // initial state
    queueMicrotask(() => {
      this.lastActive = s.getFlow().active;
      this.refreshVotes();
    });
  }

  state(): FlowState {
    return this.app.store.getFlow();
  }

  activeStep(): Step | null {
    const f = this.state();
    return f.active >= 0 ? f.steps[f.active] ?? null : null;
  }

  isVoting() {
    return this.activeStep()?.mode === 'vote';
  }

  /** True while a poll step is running and still open for answers. */
  pollOpen(): boolean {
    const pollId = this.activeStep()?.pollId;
    return !!pollId && this.polls.isOpen(pollId);
  }

  isHidden(o: BaseObj): boolean {
    if (!o.privateStep || o.type !== 'sticky') return false;
    if (o.createdBy === this.app.user.id) return false;
    return !this.state().reveal;
  }

  /** Only a change made on this screen moves this view. Other people's step changes arrive as a prompt they answer. */
  private onFlowChange(local: boolean) {
    const f = this.state();
    // a private step that starts (or a reveal that ends) changes which notes are hidden: what is selected is looked at again
    if (this.app.selection?.length) this.app.setSelection(this.app.selection);
    this.app.r.invalidateAll();
    this.refreshVotes();
    if (f.active !== this.lastActive) {
      this.lastActive = f.active;
      const step = this.activeStep();
      const frame = step?.frameId ? this.app.store.get(step.frameId) : undefined;
      if (local && step && isBox(frame)) {
        const bounds = boxBounds(frame);
        this.app.r.flyTo(bounds, 72, 1.2);
        this.onLocalStep?.(step, bounds);
      }
    }
    this.app.emit('flow');
  }

  // ---------------------------------------------------------------- votes

  votesForStep(stepId: Id): Vote[] {
    const out: Vote[] = [];
    this.app.store.votes.forEach((v) => {
      if (v.stepId === stepId) out.push(v);
    });
    return out;
  }

  /** Dots each person may place in a vote step; 0 means unlimited. */
  voteLimit(step: Step | null = this.activeStep()): number {
    return step?.votesPerPerson ?? 3;
  }

  isUnlimited(step: Step | null = this.activeStep()): boolean {
    return this.voteLimit(step) <= UNLIMITED;
  }

  myVoteCount(step: Step | null = this.activeStep()): number {
    if (!step) return 0;
    return this.votesForStep(step.id).filter((v) => v.userId === this.app.user.id).length;
  }

  myVotesLeft(): number {
    const step = this.activeStep();
    if (!step || step.mode !== 'vote') return 0;
    if (this.isUnlimited(step)) return Infinity;
    return Math.max(0, this.voteLimit(step) - this.myVoteCount(step));
  }

  /** Dots placed in total and by how many people, for the session bar. */
  voteStats(step: Step | null = this.activeStep()): { dots: number; voters: number } {
    if (!step) return { dots: 0, voters: 0 };
    const votes = this.votesForStep(step.id);
    return { dots: votes.length, voters: new Set(votes.map((v) => v.userId)).size };
  }

  /** Change the per-person limit of the running vote; takes effect for everyone at once. */
  setVoteLimit(limit: number) {
    const step = this.activeStep();
    if (!step) return;
    const steps = this.state().steps.map((s) => (s.id === step.id ? { ...s, votesPerPerson: Math.max(UNLIMITED, Math.round(limit)) } : s));
    this.setSteps(steps);
  }

  /**
   * Start a dot vote right now, with no template needed. During a session it is
   * added after the current step; otherwise it becomes the whole session.
   */
  quickVote(limit = UNLIMITED) {
    const f = this.state();
    const step: Step = {
      id: newId(), title: 'Dot vote', mode: 'vote', votesPerPerson: limit, quick: true,
      instructions: 'Click any note or shape to add a dot. Click again to add more; shift-click removes one of yours.',
    };
    if (f.active >= 0 && f.steps[f.active]?.mode === 'vote') return;
    if (f.active >= 0) {
      const steps = [...f.steps];
      steps.splice(f.active + 1, 0, step);
      this.setSteps(steps);
      this.goto(f.active + 1);
    } else {
      this.setSteps([...f.steps, step]);
      this.goto(f.steps.length);
      this.app.store.setFlow({ results: null });
    }
  }

  /** Start a poll right now: as a quick step after the running one, or as the whole session. */
  quickPoll(input: PollInput) {
    if (this.pollOpen()) throw new PollError('A poll is open. Finish it or move on first.');
    const step = this.pollStep(this.polls.create(input), true);
    const f = this.state();
    if (f.active >= 0) {
      const steps = [...f.steps];
      steps.splice(f.active + 1, 0, step);
      this.setSteps(steps);
      this.goto(f.active + 1);
    } else {
      this.setSteps([...f.steps, step]);
      this.goto(f.steps.length);
    }
  }

  /** Create the poll for a step, or edit it while it has not opened. */
  setStepPoll(stepId: Id, input: PollInput) {
    const f = this.state();
    const i = f.steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new PollError('That step is gone.');
    const step = f.steps[i];
    const poll = step.pollId && this.polls.get(step.pollId) ? this.polls.update(step.pollId, input) : this.polls.create(input);
    const next: Step = { ...step, mode: 'poll', pollId: poll.id, title: poll.question, instructions: pollInstructions(poll) };
    this.setSteps(f.steps.map((s, n) => (n === i ? next : s)));
  }

  /** Remove a poll, its answers and, if the session still lists it, its step. */
  clearPoll(pollId: Id) {
    const steps = this.state().steps;
    if (steps.some((s) => s.pollId === pollId)) this.setSteps(steps.filter((s) => s.pollId !== pollId));
    else this.polls.remove(pollId);
  }

  private pollStep(poll: Poll, quick = false): Step {
    return { id: newId(), title: poll.question, instructions: pollInstructions(poll), mode: 'poll', pollId: poll.id, ...(quick ? { quick: true } : {}) };
  }

  /** Vote handling for clicks during a vote step. Returns true if the click was consumed. */
  handleClick(hit: Obj, remove: boolean): boolean {
    const step = this.activeStep();
    if (!step || step.mode !== 'vote' || !VOTABLE(hit)) return false;
    const votes = this.app.store.votes;
    const me = this.app.user.id;
    if (remove) {
      let key: string | null = null;
      votes.forEach((v, k) => {
        if (!key && v.stepId === step.id && v.userId === me && v.itemId === hit.id) key = k;
      });
      if (key) this.app.store.transactAs(() => votes.delete(key!), 'votes');
      return true;
    }
    if (!this.isUnlimited(step) && this.myVotesLeft() <= 0) {
      this.app.emit('flow'); // lets the bar flash "no votes left"
      return true;
    }
    this.app.store.transactAs(() => votes.set(`${step.id}:${me}:${newId()}`, { itemId: hit.id, userId: me, stepId: step.id }), 'votes');
    return true;
  }

  /** Vote totals for the step; totals hidden until reveal. */
  summary(stepId?: Id): Map<Id, { mine: number; total: number | null }> {
    const step = stepId ? this.state().steps.find((s) => s.id === stepId) : this.activeStep();
    const out = new Map<Id, { mine: number; total: number | null }>();
    if (!step) return out;
    const reveal = this.state().reveal;
    for (const v of this.votesForStep(step.id)) {
      const e = out.get(v.itemId) ?? { mine: 0, total: reveal ? 0 : null };
      if (v.userId === this.app.user.id) e.mine++;
      if (e.total !== null) e.total++;
      out.set(v.itemId, e);
    }
    return out;
  }

  /** The most recent vote step that has votes, shown after the vote moves on. */
  private refreshVotes() {
    const f = this.state();
    const step = this.activeStep();
    let map = new Map<Id, { mine: number; total: number | null }>();
    if (step?.mode === 'vote') map = this.summary(step.id);
    else if (f.active < 0 && f.results) {
      for (const v of this.votesForStep(f.results)) {
        const e = map.get(v.itemId) ?? { mine: 0, total: 0 };
        e.total = (e.total ?? 0) + 1;
        map.set(v.itemId, e);
      }
    } else if (f.active >= 0) {
      // keep showing revealed results from the last vote step
      for (let i = f.active - 1; i >= 0; i--) {
        const s = f.steps[i];
        if (s.mode === 'vote') {
          const votes = this.votesForStep(s.id);
          for (const v of votes) {
            const e = map.get(v.itemId) ?? { mine: 0, total: 0 };
            e.total = (e.total ?? 0) + 1;
            map.set(v.itemId, e);
          }
          break;
        }
      }
    }
    this.app.r.setOverlay({ votes: map });
    this.app.emit('flow');
  }

  /** Items ranked by votes for a step (for the results summary). */
  ranked(stepId: Id): { item: Obj; votes: number }[] {
    const counts = new Map<Id, number>();
    for (const v of this.votesForStep(stepId)) counts.set(v.itemId, (counts.get(v.itemId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, n]) => ({ item: this.app.store.get(id)!, votes: n }))
      .filter((r) => r.item)
      .sort((a, b) => b.votes - a.votes);
  }

  // ---------------------------------------------------------------- session control

  setSteps(steps: Step[]) {
    const f = this.state();
    const kept = (s: Step) => steps.some((n) => n.id === s.id && n.pollId === s.pollId);
    const active = this.activeStep();
    if (active?.pollId && !kept(active)) this.polls.moveTo(active, null);
    this.app.store.setFlow({ steps });
    if (this.app.store.readOnly) return;
    for (const s of f.steps) if (s.pollId && !kept(s)) this.polls.remove(s.pollId);
  }

  goto(i: number) {
    const f = this.state();
    if (!f.steps.length) return;
    const idx = Math.max(-1, Math.min(f.steps.length - 1, i));
    const step = f.steps[idx];
    this.polls.moveTo(this.activeStep(), idx >= 0 ? step ?? null : null);
    this.app.store.setFlow({
      active: idx,
      reveal: false,
      stepStartedAt: Date.now(),
      timer: step?.durationSec ? { startedAt: Date.now(), durationMs: step.durationSec * 1000, pausedAt: Date.now() } : null,
    });
  }

  start() {
    this.goto(0);
  }

  next() {
    const f = this.state();
    if (f.active < f.steps.length - 1) this.goto(f.active + 1);
    else this.end();
  }

  prev() {
    const f = this.state();
    if (f.active > 0) this.goto(f.active - 1);
  }

  /** Finish the session. Dots from the last vote stay visible until cleared. */
  end() {
    const f = this.state();
    let results = f.results;
    for (let i = Math.min(f.active, f.steps.length - 1); i >= 0; i--) {
      const st = f.steps[i];
      if (st.mode === 'vote' && this.votesForStep(st.id).length) {
        results = st.id;
        break;
      }
    }
    this.polls.moveTo(this.activeStep(), null);
    this.app.store.setFlow({ active: -1, timer: null, reveal: false, results, steps: f.steps.filter((st) => !st.quick) });
  }

  /** Remove the dots left on the board by the last finished vote. */
  clearResults() {
    const f = this.state();
    if (!f.results) return;
    const votes = this.app.store.votes;
    const keys: string[] = [];
    votes.forEach((v, k) => v.stepId === f.results && keys.push(k));
    this.app.store.transactAs(() => keys.forEach((k) => votes.delete(k)), 'votes');
    this.app.store.setFlow({ results: null });
  }

  resultsCount(): number {
    const f = this.state();
    return f.results ? this.votesForStep(f.results).length : 0;
  }

  remainingMs(now = Date.now()): number | null {
    const t = this.state().timer;
    if (!t) return null;
    const elapsed = (t.pausedAt ?? now) - t.startedAt;
    return Math.max(0, t.durationMs - elapsed);
  }

  timerRunning() {
    const t = this.state().timer;
    return !!t && t.pausedAt === undefined && (this.remainingMs() ?? 0) > 0;
  }

  startTimer(sec?: number) {
    const t = this.state().timer;
    const now = Date.now();
    if (t && sec === undefined) {
      // resume
      if (t.pausedAt !== undefined) this.app.store.setFlow({ timer: { startedAt: t.startedAt + (now - t.pausedAt), durationMs: t.durationMs } });
      return;
    }
    const s = sec ?? this.activeStep()?.durationSec ?? 300;
    this.app.store.setFlow({ timer: { startedAt: now, durationMs: s * 1000 } });
  }

  pauseTimer() {
    const t = this.state().timer;
    if (t && t.pausedAt === undefined) this.app.store.setFlow({ timer: { ...t, pausedAt: Date.now() } });
  }

  addTime(ms: number) {
    const t = this.state().timer;
    if (t) this.app.store.setFlow({ timer: { ...t, durationMs: t.durationMs + ms } });
    else this.startTimer(ms / 1000);
  }

  clearTimer() {
    this.app.store.setFlow({ timer: null });
  }

  /** Reveal private notes and vote totals for everyone. */
  reveal() {
    const s = this.app.store;
    s.transact(() => {
      for (const o of s.cache.values()) if ((o as BaseObj).privateStep) s.update(o.id, { privateStep: undefined });
    });
    s.setFlow({ reveal: true });
  }

  /** Markdown summary of the session: frames, their notes, votes. Leaves out what is hidden from this person on the board. */
  summaryMarkdown(): string {
    const s = this.app.store;
    const f = this.state();
    const lines: string[] = [`# ${s.getMeta().name}`, ''];
    // hidden objects (TAB-198) are left out, as on the canvas, and so is everything in a hidden frame
    const frames = s.shown().filter((o) => o.type === 'frame') as BaseObj[];
    const totals = new Map<Id, number>();
    const voteSteps = new Set(f.steps.filter((st) => st.mode === 'vote').map((st) => st.id));
    if (f.results) voteSteps.add(f.results);
    // Totals of the vote that is running stay hidden until the reveal, as they are on the board.
    const running = this.activeStep();
    if (running?.mode === 'vote' && !f.reveal) voteSteps.delete(running.id);
    for (const id of voteSteps) for (const v of this.votesForStep(id)) totals.set(v.itemId, (totals.get(v.itemId) ?? 0) + 1);
    for (const fr of frames) {
      const kids = s.childrenOf(fr.id).filter((o) => ((o as BaseObj).text || o.type === 'image') && !isConnector(o) && !this.isHidden(o as BaseObj) && s.isShown(o)) as BaseObj[];
      if (!kids.length) continue;
      lines.push(`## ${fr.name || 'Frame'}`, '');
      kids.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || a.y - b.y || a.x - b.x);
      for (const k of kids) {
        const n = totals.get(k.id);
        lines.push(`- ${k.type === 'image' ? imageLine(k) : k.text!.replace(/\n+/g, ' ')}${n ? ` (${n} vote${n === 1 ? '' : 's'})` : ''}`);
      }
      lines.push('');
    }
    lines.push(...this.kanbanLines(totals));
    lines.push(...this.polls.markdownLines());
    return lines.join('\n');
  }

  /**
   * The kanbans of the board for the summary (docs/kanban.md, Export and import): a heading per kanban, a lower heading per
   * lane with its stage and limit, the cards as bullets in the order drawn, `(owner, due)` in parentheses, and the votes a
   * card got. A hidden kanban, lane or card (TAB-198) and a card this person may not see are left out, as are the notes.
   */
  private kanbanLines(totals: Map<Id, number>): string[] {
    const s = this.app.store;
    const line = mdText;
    const out: string[] = [];
    for (const c of s.shown()) {
      if (c.type !== 'container') continue;
      const layout = s.containerLayout(c.id);
      if (!layout) continue;
      out.push(`## ${line((c as BaseObj).name) || 'Kanban'}`, '');
      for (const laneId of layout.lanes) {
        const lane = s.get(laneId) as BaseObj | undefined;
        if (!lane) continue;
        const cards = (layout.cards.get(laneId) ?? []).map((id) => s.get(id) as BaseObj | undefined).filter((k): k is BaseObj => !!k && k.type === 'card' && !this.isHidden(k));
        const notes = [lane.stage, lane.wip ? `${cards.length} of ${lane.wip}${lane.wipMode === 'block' ? ', blocks' : ''}` : ''].filter(Boolean).join(', ');
        out.push(`### ${line(lane.name) || 'Lane'}${notes ? ` (${notes})` : ''}`, '');
        if (!cards.length) out.push('_No cards_');
        for (const k of cards) {
          const who = [line(k.ownerName), k.due].filter(Boolean).join(', ');
          const n = totals.get(k.id);
          out.push(`- ${line(k.text) || 'Untitled card'}${who ? ` (${who})` : ''}${n ? ` (${n} vote${n === 1 ? '' : 's'})` : ''}`);
        }
        out.push('');
      }
    }
    return out;
  }
}
