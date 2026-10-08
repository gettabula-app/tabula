import type { BoardApp } from './app';
import { newId } from './store';
import type { Id, Obj, Poll, PollAnswer, PollOption, Step } from './types';

export const POLL_LIMITS = { question: 200, option: 120, minOptions: 2, maxOptions: 10 } as const;

export interface PollInput {
  question: string;
  options: string[];
  multiple: boolean;
  anonymous: boolean;
}

/** A refused action. The message is shown to the person as it is. */
export class PollError extends Error {}

export interface PollRow {
  option: PollOption;
  count: number;
  /** Share of responses, or null while nobody has answered. */
  pct: number | null;
  /** Who chose the option. Always empty for anonymous polls. */
  names: string[];
}

export interface PollTally {
  responses: number;
  rows: PollRow[];
}

export const answerKey = (pollId: Id, userId: string) => `${pollId}:${userId}`;

/** The fields of a poll that change after it is created, each set by a different event. */
export type PollStateField = 'revealed' | 'openedAt' | 'closedAt';
const STATE_FIELDS: PollStateField[] = ['revealed', 'openedAt', 'closedAt'];
export const stateKey = (pollId: Id, field: PollStateField) => `${pollId}:${field}`;

const earliest = (a: unknown, b: unknown): number | undefined => {
  const ts = [a, b].filter((t): t is number => typeof t === 'number');
  return ts.length ? Math.min(...ts) : undefined;
};

export const pollInstructions = (poll: Pick<Poll, 'multiple'>) => (poll.multiple ? 'Pick any number of options.' : 'Pick one option.');

/** Trims and checks a poll definition. Throws a PollError with the message to show. */
export function checkPoll(input: PollInput): PollInput {
  const question = input.question.trim();
  const options = input.options.map((t) => t.trim());
  if (!question) throw new PollError('Write a question first.');
  if (question.length > POLL_LIMITS.question) throw new PollError(`Keep the question under ${POLL_LIMITS.question} characters.`);
  if (options.length < POLL_LIMITS.minOptions || options.length > POLL_LIMITS.maxOptions) {
    throw new PollError(`A poll needs ${POLL_LIMITS.minOptions} to ${POLL_LIMITS.maxOptions} options.`);
  }
  if (options.some((t) => !t)) throw new PollError('Every option needs some text.');
  if (options.some((t) => t.length > POLL_LIMITS.option)) throw new PollError(`Keep each option under ${POLL_LIMITS.option} characters.`);
  if (new Set(options.map((t) => t.toLowerCase())).size !== options.length) throw new PollError('Two options have the same text.');
  return { question, options, multiple: !!input.multiple, anonymous: !!input.anonymous };
}

/** Ranked rows as plain lines, then the response count. */
function rankedLines(t: PollTally): string[] {
  const lines = t.rows.map((r, i) => `${i + 1}. ${r.option.text} (${r.count}${r.pct === null ? '' : `, ${r.pct}%`})${r.names.length ? ` - ${r.names.join(', ')}` : ''}`);
  lines.push(`${t.responses} ${t.responses === 1 ? 'response' : 'responses'}`);
  return lines;
}

/**
 * Polls on the board: definitions and answers in the shared doc, the open and
 * closed lifecycle, reveal, results and exports. Steps stay in the flow; see flow.ts.
 *
 * A poll's definition is one JSON value in `polls`, and it only changes before the poll opens. The fields that
 * change later (revealed, openedAt, closedAt) each have their own key in `pollState`, so a reveal on one device and
 * a step change on another both survive; as one JSON value, the later write replaced the earlier one. Reading
 * combines both places: the fields only move one way (revealed stays true, a poll opens and closes once), so true
 * wins and the earliest time wins. That also covers polls written before `pollState` existed, and older clients that
 * still rewrite the whole value, which is why writes also update the definition.
 */
export class Polls {
  constructor(private app: BoardApp) {
    app.store.polls.observe((e) => {
      this.migrate([...e.keysChanged]);
      app.emit('flow');
    });
    app.store.pollAnswers.observe(() => app.emit('flow'));
    app.store.pollState.observe(() => app.emit('flow'));
    this.migrate([...app.store.polls.keys()]);
  }

  get(id: Id): Poll | undefined {
    const def = this.app.store.polls.get(id);
    return def ? this.withState(def) : undefined;
  }

  /** Every poll, oldest first. */
  list(): Poll[] {
    const out: Poll[] = [];
    this.app.store.polls.forEach((p) => out.push(this.withState(p)));
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The definition with its changing fields, from `pollState` and from the definition itself. */
  private withState(def: Poll): Poll {
    const state = (f: PollStateField) => this.app.store.pollState.get(stateKey(def.id, f));
    const poll: Poll = { ...def, revealed: def.revealed === true || state('revealed') === true };
    const openedAt = earliest(def.openedAt, state('openedAt'));
    const closedAt = earliest(def.closedAt, state('closedAt'));
    if (openedAt === undefined) delete poll.openedAt;
    else poll.openedAt = openedAt;
    if (closedAt === undefined) delete poll.closedAt;
    else poll.closedAt = closedAt;
    return poll;
  }

  /**
   * Copies changing fields that only the definition holds (polls from before `pollState`, or written by an older
   * client) into `pollState`, where a later rewrite of the definition cannot drop them. Safe to run on several
   * devices at once: they write the same values. Read-only viewers skip it; reading combines both places anyway.
   */
  private migrate(ids: Id[]) {
    if (this.app.store.readOnly) return;
    const sets: [string, unknown][] = [];
    for (const id of ids) {
      const def = this.app.store.polls.get(id);
      if (!def) continue;
      for (const f of STATE_FIELDS) {
        const value = def[f];
        if ((f === 'revealed' ? value === true : typeof value === 'number') && !this.app.store.pollState.has(stateKey(id, f))) {
          sets.push([stateKey(id, f), value]);
        }
      }
    }
    if (sets.length) this.app.store.transactAs(() => sets.forEach(([k, v]) => this.app.store.pollState.set(k, v)), 'polls');
  }

  /** Polls and answers as stored, for the JSON snapshot. */
  snapshot(): { polls: Poll[]; answers: PollAnswer[] } {
    const answers: PollAnswer[] = [];
    this.app.store.pollAnswers.forEach((a) => answers.push(a));
    return { polls: this.list(), answers };
  }

  answers(pollId: Id): PollAnswer[] {
    const out: PollAnswer[] = [];
    this.app.store.pollAnswers.forEach((a) => {
      if (a.pollId === pollId) out.push(a);
    });
    return out;
  }

  mine(pollId: Id): PollAnswer | undefined {
    return this.app.store.pollAnswers.get(answerKey(pollId, this.app.user.id));
  }

  /** Open for answers: opened, not closed, and its step is the running one. */
  isOpen(pollId: Id): boolean {
    const poll = this.get(pollId);
    if (!poll || poll.openedAt === undefined || poll.closedAt !== undefined) return false;
    const f = this.app.store.getFlow();
    const step = f.active >= 0 ? f.steps[f.active] : undefined;
    return step?.pollId === pollId;
  }

  /** The most recently closed poll, shown in the session bar after the session ends. */
  latestClosed(): Poll | undefined {
    let best: Poll | undefined;
    for (const p of this.list()) {
      if (p.closedAt !== undefined && (!best || p.closedAt > best.closedAt!)) best = p;
    }
    return best;
  }

  /** Counts per option. Ranked: count descending, ties in option order. */
  tally(pollId: Id): PollTally {
    const poll = this.get(pollId);
    const known = new Set<Id>((poll?.options ?? []).map((o) => o.id));
    const counts = new Map<Id, number>();
    const names = new Map<Id, string[]>();
    let responses = 0;
    for (const a of this.answers(pollId)) {
      const picked = a.optionIds.filter((id) => known.has(id));
      if (!picked.length) continue;
      responses++;
      for (const id of picked) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (a.name) names.set(id, [...(names.get(id) ?? []), a.name]);
      }
    }
    const rows: PollRow[] = (poll?.options ?? []).map((option) => {
      const count = counts.get(option.id) ?? 0;
      return {
        option,
        count,
        pct: responses ? Math.round((100 * count) / responses) : null,
        names: poll?.anonymous ? [] : names.get(option.id) ?? [],
      };
    });
    rows.sort((a, b) => b.count - a.count);
    return { responses, rows };
  }

  create(input: PollInput): Poll {
    const checked = checkPoll(input);
    const poll: Poll = {
      id: newId(),
      question: checked.question,
      options: checked.options.map((text) => ({ id: newId(), text })),
      multiple: checked.multiple,
      anonymous: checked.anonymous,
      revealed: false,
      createdAt: Date.now(),
      createdBy: this.app.user.id,
    };
    this.write(() => this.app.store.polls.set(poll.id, poll));
    return poll;
  }

  /** Edits a poll that has not opened yet. */
  update(pollId: Id, input: PollInput): Poll {
    const old = this.require(pollId);
    if (old.openedAt !== undefined) throw new PollError('This poll has opened, so it can no longer change.');
    const checked = checkPoll(input);
    const poll: Poll = {
      ...old,
      question: checked.question,
      options: checked.options.map((text) => ({ id: newId(), text })),
      multiple: checked.multiple,
      anonymous: checked.anonymous,
    };
    this.write(() => this.app.store.polls.set(pollId, poll));
    return poll;
  }

  /** Single choice replaces the answer; multiple choice toggles the option. */
  choose(pollId: Id, optionId: Id) {
    const poll = this.requireOpen(pollId);
    if (!poll.options.some((o) => o.id === optionId)) throw new PollError('That option is gone.');
    const cur = this.mine(pollId)?.optionIds ?? [];
    const next = !poll.multiple ? [optionId] : cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId];
    if (next.length) this.saveAnswer(poll, next);
    else this.write(() => this.app.store.pollAnswers.delete(answerKey(pollId, this.app.user.id)));
  }

  clearMine(pollId: Id) {
    this.requireOpen(pollId);
    this.write(() => this.app.store.pollAnswers.delete(answerKey(pollId, this.app.user.id)));
  }

  /** Shows the results to everyone. Allowed while the poll is open or closed; the poll stays revealed. */
  reveal(pollId: Id) {
    const poll = this.require(pollId);
    if (poll.openedAt === undefined) throw new PollError('Run the poll before revealing its results.');
    this.setState(poll, 'revealed', true);
  }

  /** Deletes the poll, its answers and its record. Steps are handled by Flow. */
  remove(pollId: Id) {
    const keys: string[] = [];
    this.app.store.pollAnswers.forEach((a, key) => {
      if (a.pollId === pollId) keys.push(key);
    });
    this.write(() => {
      for (const k of keys) this.app.store.pollAnswers.delete(k);
      for (const f of STATE_FIELDS) this.app.store.pollState.delete(stateKey(pollId, f));
      this.app.store.polls.delete(pollId);
    });
  }

  /** The flow moved from one step to another (or to none). Opens the new poll and closes the old one. */
  moveTo(from: Step | null, to: Step | null) {
    if (this.app.store.readOnly) return;
    if (from?.pollId && from.pollId !== to?.pollId) this.stamp(from.pollId, 'closedAt');
    if (to?.pollId) this.stamp(to.pollId, 'openedAt');
  }

  /** Markdown section for the summary: opened polls only, and tallies only once revealed. */
  markdownLines(): string[] {
    const opened = this.list().filter((p) => p.openedAt !== undefined).sort((a, b) => a.openedAt! - b.openedAt!);
    if (!opened.length) return [];
    const out = ['## Polls', ''];
    for (const p of opened) {
      out.push(`### ${p.question}`, '');
      out.push(...(p.revealed ? rankedLines(this.tally(p.id)) : ['Results not revealed.']), '');
    }
    return out;
  }

  /** Markdown for "Copy results". Refused until the poll is revealed. */
  copyText(pollId: Id): string {
    const poll = this.require(pollId);
    if (!poll.revealed) throw new PollError('Reveal the results first.');
    return [`**${poll.question}**`, ...rankedLines(this.tally(pollId))].join('\n');
  }

  /** A plain sticky with the question and ranked lines. A snapshot, not live. */
  addResultsSticky(pollId: Id) {
    const poll = this.require(pollId);
    if (!poll.revealed) throw new PollError('Reveal the results first.');
    this.guard();
    const r = this.app.r;
    const content = r.contentBounds();
    const at = content ? { x: content.x + content.w + 200, y: content.y } : r.viewport();
    const sticky: Obj = {
      id: newId(), type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: '',
      text: [poll.question, ...rankedLines(this.tally(pollId))].join('\n'),
      fill: this.app.stickyColor,
    };
    this.app.insertObjects([sticky], at);
  }

  private saveAnswer(poll: Poll, optionIds: Id[]) {
    const me = this.app.user;
    const answer: PollAnswer = {
      pollId: poll.id,
      userId: me.id,
      optionIds,
      updatedAt: Date.now(),
      ...(poll.anonymous ? {} : { name: me.name, color: me.color }),
    };
    this.write(() => this.app.store.pollAnswers.set(answerKey(poll.id, me.id), answer));
  }

  private stamp(pollId: Id, field: 'openedAt' | 'closedAt') {
    const poll = this.get(pollId);
    if (!poll || poll[field] !== undefined) return;
    if (field === 'closedAt' && poll.openedAt === undefined) return;
    this.setState(poll, field, Date.now());
  }

  /**
   * Sets one changing field in its own key. The definition gets the same value, for clients that predate
   * `pollState`; if two devices rewrite the definition at once one rewrite is lost there, but never here.
   */
  private setState(poll: Poll, field: PollStateField, value: boolean | number) {
    const def = this.app.store.polls.get(poll.id);
    this.write(() => {
      this.app.store.pollState.set(stateKey(poll.id, field), value);
      if (def) this.app.store.polls.set(poll.id, { ...this.withState(def), [field]: value });
    });
  }

  private require(pollId: Id): Poll {
    const poll = this.get(pollId);
    if (!poll) throw new PollError('That poll is gone.');
    return poll;
  }

  private requireOpen(pollId: Id): Poll {
    this.guard();
    const poll = this.require(pollId);
    if (!this.isOpen(pollId)) throw new PollError('This poll is closed.');
    return poll;
  }

  private guard() {
    if (this.app.store.readOnly) throw new PollError('This board is read-only.');
  }

  private write(fn: () => void) {
    this.guard();
    this.app.store.transactAs(fn, 'polls');
  }
}
