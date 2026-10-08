import type { BoardApp } from './app';
import type { BaseObj, Id, Obj, Step, Vote } from './types';
import { isBox, isConnector } from './types';
import { newId, type FlowState } from './store';
import { boxBounds } from './geometry';

/** `votesPerPerson` value meaning no limit. */
export const UNLIMITED = 0;

const VOTABLE = (o: Obj) => isBox(o) && o.type !== 'frame' && o.type !== 'path' && !isConnector(o);

/**
 * Facilitation: a scripted sequence of steps run on the board. All state lives
 * in the shared doc (timer as start time + duration), so every participant's
 * screen agrees and counts down locally, even offline.
 */
export class Flow {
  private lastActive = -2;
  private lastFocusTs = 0;

  constructor(private app: BoardApp) {
    const s = app.store;
    s.flow.observe(() => this.onFlowChange());
    s.votes.observe(() => this.refreshVotes());
    // initial state
    queueMicrotask(() => {
      this.lastActive = s.getFlow().active;
      this.lastFocusTs = s.getFlow().focus?.ts ?? 0;
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

  isHidden(o: BaseObj): boolean {
    if (!o.privateStep || o.type !== 'sticky') return false;
    if (o.createdBy === this.app.user.id) return false;
    return !this.state().reveal;
  }

  private onFlowChange() {
    const f = this.state();
    this.app.r.invalidateAll();
    this.refreshVotes();
    if (f.active !== this.lastActive) {
      this.lastActive = f.active;
      const step = this.activeStep();
      const frame = step?.frameId ? this.app.store.get(step.frameId) : undefined;
      if (isBox(frame)) this.app.r.flyTo(boxBounds(frame), 72, 1.2);
    }
    if (f.focus && f.focus.ts !== this.lastFocusTs) {
      this.lastFocusTs = f.focus.ts;
      if (f.focus.by !== this.app.user.id) this.app.r.flyToCenter({ x: f.focus.x, y: f.focus.y }, f.focus.zoom);
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
      if (key) this.app.store.doc.transact(() => votes.delete(key!), 'votes');
      return true;
    }
    if (!this.isUnlimited(step) && this.myVotesLeft() <= 0) {
      this.app.emit('flow'); // lets the bar flash "no votes left"
      return true;
    }
    this.app.store.doc.transact(() => votes.set(`${step.id}:${me}:${newId()}`, { itemId: hit.id, userId: me, stepId: step.id }), 'votes');
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
    this.app.store.setFlow({ steps });
  }

  goto(i: number) {
    const f = this.state();
    if (!f.steps.length) return;
    const idx = Math.max(-1, Math.min(f.steps.length - 1, i));
    const step = f.steps[idx];
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
    this.app.store.setFlow({ active: -1, timer: null, reveal: false, results, steps: f.steps.filter((st) => !st.quick) });
  }

  /** Remove the dots left on the board by the last finished vote. */
  clearResults() {
    const f = this.state();
    if (!f.results) return;
    const votes = this.app.store.votes;
    const keys: string[] = [];
    votes.forEach((v, k) => v.stepId === f.results && keys.push(k));
    this.app.store.doc.transact(() => keys.forEach((k) => votes.delete(k)), 'votes');
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

  /** Bring everyone's view to mine. */
  summon() {
    const vp = this.app.r.viewport();
    this.app.store.setFlow({ focus: { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2, zoom: this.app.zoom, ts: Date.now(), by: this.app.user.id } });
  }

  /** Markdown summary of the session: frames, their notes, votes. */
  summaryMarkdown(): string {
    const s = this.app.store;
    const f = this.state();
    const lines: string[] = [`# ${s.getMeta().name}`, ''];
    const frames = s.ordered().filter((o) => o.type === 'frame') as BaseObj[];
    const totals = new Map<Id, number>();
    const voteSteps = new Set(f.steps.filter((st) => st.mode === 'vote').map((st) => st.id));
    if (f.results) voteSteps.add(f.results);
    for (const id of voteSteps) for (const v of this.votesForStep(id)) totals.set(v.itemId, (totals.get(v.itemId) ?? 0) + 1);
    for (const fr of frames) {
      const kids = s.childrenOf(fr.id).filter((o) => (o as BaseObj).text && !isConnector(o)) as BaseObj[];
      if (!kids.length) continue;
      lines.push(`## ${fr.name || 'Frame'}`, '');
      kids.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || a.y - b.y || a.x - b.x);
      for (const k of kids) {
        const n = totals.get(k.id);
        lines.push(`- ${k.text!.replace(/\n+/g, ' ')}${n ? ` (${n} vote${n === 1 ? '' : 's'})` : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
