import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store, newId } from '../src/store';
import { Flow } from '../src/flow';
import { PollError, answerKey, type PollInput } from '../src/polls';
import { readBoardFile, toJson } from '../src/exporters';
import type { BaseObj, Poll } from '../src/types';

/** The parts of BoardApp that Flow and Polls use, without any DOM. */
function fakeApp(userId = 'me', doc = new Y.Doc()) {
  const store = new Store(doc);
  const app = {
    store,
    user: { id: userId, name: `name-${userId}`, color: '#123456' },
    conn: { comments: { list: () => [] } },
    r: {
      invalidateAll() {}, setOverlay() {}, flyTo() {}, flyToCenter() {},
      viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }),
      contentBounds: () => null,
    },
    zoom: 1,
    emit() {},
    participants: () => [],
    stickyColor: '#FFD23F',
    insertObjects(objs: BaseObj[], offset: { x: number; y: number }) {
      store.transact(() => {
        for (const o of objs) store.create({ ...o, id: newId(), x: o.x + offset.x, y: o.y + offset.y, createdBy: userId });
      });
    },
  };
  const flow = new Flow(app as never);
  Object.assign(app, { flow });
  return { app, store, flow, doc };
}

const input = (over: Partial<PollInput> = {}): PollInput => ({
  question: 'Which?', options: ['Alpha', 'Beta', 'Gamma'], multiple: false, anonymous: true, ...over,
});

const write = (id: string) => ({ id, title: 'Write', instructions: '', mode: 'write' as const });

/** The poll behind the running step. */
function runningPoll(flow: Flow): Poll {
  return flow.polls.get(flow.activeStep()!.pollId!)!;
}

describe('poll definitions', () => {
  it('accepts two to ten distinct options and trims text', () => {
    const { flow } = fakeApp();
    const ten = Array.from({ length: 10 }, (_, i) => `Option ${i}`);
    expect(flow.polls.create(input({ options: ['A', ' B '] })).options.map((o) => o.text)).toEqual(['A', 'B']);
    expect(() => flow.polls.create(input({ options: ten }))).not.toThrow();
    expect(() => flow.polls.create(input({ options: ['A'] }))).toThrow(PollError);
    expect(() => flow.polls.create(input({ options: [...ten, 'more'] }))).toThrow(PollError);
    expect(() => flow.polls.create(input({ options: ['Same', 'same'] }))).toThrow(PollError);
    expect(() => flow.polls.create(input({ question: '   ' }))).toThrow(PollError);
  });
});

describe('quick poll', () => {
  it('starts a session on the poll step when none is running', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input());
    expect(flow.activeStep()?.mode).toBe('poll');
    expect(flow.activeStep()?.quick).toBe(true);
    expect(flow.pollOpen()).toBe(true);
    expect(store.getFlow().active).toBe(0);
  });

  it('inserts after the running step', () => {
    const { flow } = fakeApp();
    flow.setSteps([write('w')]);
    flow.start();
    flow.quickPoll(input());
    expect(flow.state().steps.map((s) => s.mode)).toEqual(['write', 'poll']);
    expect(flow.state().active).toBe(1);
  });

  it('refuses while a poll is open', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    expect(() => flow.quickPoll(input())).toThrow(PollError);
  });

  it('leaves the step out after Finish but keeps the poll and its results', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input());
    const poll = runningPoll(flow);
    flow.polls.choose(poll.id, poll.options[0].id);
    flow.end();
    expect(flow.state().steps).toEqual([]);
    expect(flow.polls.latestClosed()?.id).toBe(poll.id);
    expect(store.pollAnswers.size).toBe(1);
  });
});

describe('answers', () => {
  it('single choice replaces the answer and can be cleared', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input());
    const { id, options: [a, b] } = runningPoll(flow);
    flow.polls.choose(id, a.id);
    flow.polls.choose(id, b.id);
    expect(store.pollAnswers.get(answerKey(id, 'me'))?.optionIds).toEqual([b.id]);
    expect(store.pollAnswers.size).toBe(1);
    flow.polls.clearMine(id);
    expect(store.pollAnswers.size).toBe(0);
    expect(() => flow.polls.choose(id, 'nope')).toThrow(PollError);
  });

  it('multiple choice toggles options', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input({ multiple: true }));
    const { id, options: [a, b] } = runningPoll(flow);
    flow.polls.choose(id, a.id);
    flow.polls.choose(id, b.id);
    expect(store.pollAnswers.get(answerKey(id, 'me'))?.optionIds).toEqual([a.id, b.id]);
    flow.polls.choose(id, a.id);
    expect(store.pollAnswers.get(answerKey(id, 'me'))?.optionIds).toEqual([b.id]);
  });

  it('anonymous answers store no name or colour; named answers do', () => {
    const anon = fakeApp();
    anon.flow.quickPoll(input({ anonymous: true }));
    const a = runningPoll(anon.flow);
    anon.flow.polls.choose(a.id, a.options[0].id);
    expect(anon.store.pollAnswers.get(answerKey(a.id, 'me'))).not.toHaveProperty('name');
    expect(anon.store.pollAnswers.get(answerKey(a.id, 'me'))).not.toHaveProperty('color');

    const named = fakeApp();
    named.flow.quickPoll(input({ anonymous: false }));
    const n = runningPoll(named.flow);
    named.flow.polls.choose(n.id, n.options[0].id);
    expect(named.store.pollAnswers.get(answerKey(n.id, 'me'))).toMatchObject({ name: 'name-me', color: '#123456' });
  });

  it('refuses answers after the flow moves on, and does not reopen when going back', () => {
    const { flow } = fakeApp();
    flow.setSteps([write('w')]);
    flow.setStepPoll('w', input());
    flow.setSteps([...flow.state().steps, write('x')]);
    flow.start();
    const poll = flow.polls.get(flow.state().steps[0].pollId!)!;
    flow.polls.choose(poll.id, poll.options[0].id);
    flow.next();
    flow.prev();
    expect(flow.polls.isOpen(poll.id)).toBe(false);
    expect(() => flow.polls.choose(poll.id, poll.options[1].id)).toThrow(PollError);
  });
});

describe('lifecycle', () => {
  it('a poll cannot be edited once it has opened', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    const poll = runningPoll(flow);
    expect(() => flow.polls.update(poll.id, input({ question: 'Changed' }))).toThrow(PollError);
  });

  it('a draft can be edited, and removing its step removes the poll and its answers', () => {
    const { flow, store } = fakeApp();
    flow.setSteps([write('w')]);
    flow.setStepPoll('w', input());
    const pollId = flow.state().steps[0].pollId!;
    flow.setStepPoll('w', input({ question: 'Edited?' }));
    expect(flow.polls.get(pollId)?.question).toBe('Edited?');
    expect(flow.state().steps[0].title).toBe('Edited?');
    flow.setSteps([]);
    expect(flow.polls.get(pollId)).toBeUndefined();
    expect(store.polls.size).toBe(0);
  });

  it('clearPoll removes the poll, its answers and its step', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input());
    const poll = runningPoll(flow);
    flow.polls.choose(poll.id, poll.options[0].id);
    flow.end();
    flow.clearPoll(poll.id);
    expect(store.polls.size).toBe(0);
    expect(store.pollAnswers.size).toBe(0);
  });

  it('ending the session closes the running poll', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    const id = runningPoll(flow).id;
    flow.end();
    expect(flow.polls.get(id)?.closedAt).toBeDefined();
  });
});

describe('reveal', () => {
  it('reveals this poll only and keeps earlier private notes hidden', () => {
    const { flow, store } = fakeApp();
    const note: BaseObj = { id: 'note', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: 'private', privateStep: 'earlier', createdBy: 'other' };
    store.transact(() => store.create(note));
    flow.quickPoll(input());
    flow.polls.reveal(runningPoll(flow).id);
    expect(runningPoll(flow).revealed).toBe(true);
    expect(flow.state().reveal).toBe(false);
    expect(flow.isHidden(note)).toBe(true);
  });

  it('cannot reveal a poll that has not opened', () => {
    const { flow } = fakeApp();
    flow.setSteps([write('w')]);
    flow.setStepPoll('w', input());
    expect(() => flow.polls.reveal(flow.state().steps[0].pollId!)).toThrow(PollError);
  });
});

describe('read-only store', () => {
  it('refuses every write and writes nothing', () => {
    const { flow, store } = fakeApp();
    const draft = flow.polls.create(input());
    store.setReadOnly(true);
    expect(() => flow.polls.create(input())).toThrow(PollError);
    expect(() => flow.quickPoll(input())).toThrow(PollError);
    expect(() => flow.polls.reveal(draft.id)).toThrow(PollError);
    expect(store.polls.size).toBe(1);
    expect(store.pollAnswers.size).toBe(0);
  });
});

describe('sync between people', () => {
  it('merges answers from two people and keeps one entry per person', () => {
    const alice = fakeApp('alice');
    alice.flow.quickPoll(input({ multiple: true }));
    const { id, options: [a, b] } = runningPoll(alice.flow);
    const bob = fakeApp('bob');
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));
    alice.flow.polls.choose(id, a.id);
    bob.flow.polls.choose(id, b.id);
    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc));
    expect(alice.flow.polls.tally(id).responses).toBe(2);

    const phone = fakeApp('alice');
    Y.applyUpdate(phone.doc, Y.encodeStateAsUpdate(alice.doc));
    phone.flow.polls.choose(id, b.id);
    alice.flow.polls.choose(id, a.id);
    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(phone.doc));
    const aliceEntries = [...alice.store.pollAnswers.values()].filter((x) => x.userId === 'alice');
    expect(aliceEntries).toHaveLength(1);
  });

  it('accepts an answer written on a device that had not seen the close', () => {
    const alice = fakeApp('alice');
    alice.flow.quickPoll(input());
    const id = runningPoll(alice.flow).id;
    const bob = fakeApp('bob');
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));
    alice.flow.end();
    bob.flow.polls.choose(id, bob.flow.polls.get(id)!.options[0].id);
    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc));
    expect(alice.store.pollAnswers.get(answerKey(id, 'bob'))).toBeDefined();
  });
});

describe('tally', () => {
  it('ranks by count, keeps option order for ties, and ignores unknown options', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input({ multiple: true }));
    const { id, options: [, b, c] } = runningPoll(flow);
    const put = (userId: string, optionIds: string[]) => store.pollAnswers.set(answerKey(id, userId), { pollId: id, userId, optionIds, updatedAt: 0 });
    put('alice', [b.id]);
    put('bob', [b.id, c.id]);
    put('carol', [c.id, 'gone']);
    const t = flow.polls.tally(id);
    expect(t.responses).toBe(3);
    expect(t.rows.map((r) => [r.option.text, r.count, r.pct])).toEqual([['Beta', 2, 67], ['Gamma', 2, 67], ['Alpha', 0, 0]]);
  });

  it('gives no percentages before anyone has answered', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    expect(flow.polls.tally(runningPoll(flow).id).rows.every((r) => r.pct === null)).toBe(true);
  });
});

describe('summary, copy and results sticky', () => {
  it('hides tallies and names until reveal, then ranks them', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input({ anonymous: false, options: ['Alpha', 'Beta'] }));
    const { id, options: [, beta] } = runningPoll(flow);
    flow.polls.choose(id, beta.id);
    expect(flow.summaryMarkdown()).toContain('Results not revealed.');
    expect(flow.summaryMarkdown()).not.toContain('name-me');
    expect(flow.summaryMarkdown()).not.toContain('(1');
    flow.polls.reveal(id);
    expect(flow.summaryMarkdown()).toContain('1. Beta (1, 100%) - name-me');
    expect(flow.summaryMarkdown()).toContain('1 response');
    expect(flow.summaryMarkdown()).not.toContain('undefined');
  });

  it('never names people in an anonymous poll', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    const id = runningPoll(flow).id;
    flow.polls.choose(id, runningPoll(flow).options[0].id);
    flow.polls.reveal(id);
    expect(flow.summaryMarkdown()).not.toContain('name-me');
  });

  it('copy text is refused until revealed, then starts with the question in bold', () => {
    const { flow } = fakeApp();
    flow.quickPoll(input());
    const id = runningPoll(flow).id;
    expect(() => flow.polls.copyText(id)).toThrow(PollError);
    flow.polls.reveal(id);
    expect(flow.polls.copyText(id).startsWith('**Which?**\n1. ')).toBe(true);
  });

  it('adds one plain sticky that undo removes', () => {
    const { flow, store } = fakeApp();
    flow.quickPoll(input({ options: ['A', 'B'] }));
    const id = runningPoll(flow).id;
    expect(() => flow.polls.addResultsSticky(id)).toThrow(PollError);
    flow.polls.reveal(id);
    flow.polls.addResultsSticky(id);
    const stickies = () => [...store.cache.values()].filter((o) => o.type === 'sticky') as BaseObj[];
    expect(stickies()).toHaveLength(1);
    expect(stickies()[0].text).toContain('Which?');
    expect(stickies()[0].privateStep).toBeUndefined();
    store.undo.undo();
    expect(stickies()).toHaveLength(0);
  });
});

describe('dot voting and legacy boards', () => {
  it('leaves dot voting alone on a poll step', () => {
    const { flow, store } = fakeApp();
    store.transact(() => store.create({ id: 'a', type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: 'a' }));
    flow.quickPoll(input());
    expect(flow.isVoting()).toBe(false);
    expect(flow.handleClick(store.get('a')!, false)).toBe(false);
    expect(store.votes.size).toBe(0);
  });

  it('a board without polls summarises as before', () => {
    const { flow, store } = fakeApp();
    expect(store.polls.size).toBe(0);
    expect(store.pollAnswers.size).toBe(0);
    expect(flow.summaryMarkdown()).not.toContain('## Polls');
  });
});

describe('export and import', () => {
  it('keeps polls and answers through a whole-document update, as .drift does', () => {
    const alice = fakeApp('alice');
    alice.flow.quickPoll(input());
    alice.flow.polls.choose(runningPoll(alice.flow).id, runningPoll(alice.flow).options[0].id);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(alice.doc));
    const restored = new Store(copy);
    expect(restored.polls.size).toBe(1);
    expect(restored.pollAnswers.size).toBe(1);
  });

  it('the JSON snapshot carries polls and answers, and reads back', async () => {
    const alice = fakeApp('alice');
    alice.flow.quickPoll(input());
    alice.flow.polls.choose(runningPoll(alice.flow).id, runningPoll(alice.flow).options[0].id);
    const json = toJson(alice.app as never);
    expect(json.polls).toHaveLength(1);
    expect(json.pollAnswers).toHaveLength(1);
    expect(toJson(alice.app as never, []).polls).toBeUndefined();
    const imported = await readBoardFile(new File([JSON.stringify(json)], 'board.json'));
    expect(imported.json.pollAnswers?.[0].optionIds).toEqual(json.pollAnswers![0].optionIds);
  });
});
