import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { Flow } from '../src/flow';
import { answerKey } from '../src/polls';
import { boardUser, deviceIdentity } from '../src/board-user';
import { getUser, saveUser } from '../src/sync';
import type { AuthState } from '../src/auth';
import type { BaseObj } from '../src/types';

// A signed-in user whose earlier votes and poll answers were written under the browser's device id (docs/identity: src/identity.ts).

const DEVICE = { id: 'device-7d1f', name: 'Quick Otter', color: '#3366FF' };
const me = { user: { id: 'usr_acct123', name: 'Lea Brandt', role: 'member' } };

function appFor(user: Record<string, unknown>, doc = new Y.Doc()) {
  const store = new Store(doc);
  const app = {
    store, user,
    conn: { comments: { list: () => [] } },
    r: { invalidateAll() {}, setOverlay() {}, flyTo() {}, flyToCenter() {}, viewport: () => ({ x: 0, y: 0, w: 100, h: 100 }), contentBounds: () => null },
    zoom: 1, emit() {}, participants: () => [], stickyColor: '#FFD23F',
  };
  return { store, flow: new Flow(app as never) };
}
const note = (id: string): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 192, h: 192, rotation: 0, z: 'a0', text: id });
const signedIn = () => ({ ...DEVICE, id: me.user.id, deviceId: DEVICE.id });

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  });
  localStorage.setItem('driftboard:user', JSON.stringify(DEVICE));
});

describe('the profile of a signed-in user', () => {
  it('saves the new name and colour on the device identity, never the account id or deviceId', () => {
    const user = boardUser({ mode: 'signed-in', me } as unknown as AuthState);
    expect(user).toMatchObject({ id: me.user.id, deviceId: DEVICE.id });
    saveUser(deviceIdentity({ name: 'Lea B.', color: '#FF0000' }));
    const stored = JSON.parse(localStorage.getItem('driftboard:user')!);
    expect(stored).toEqual({ id: DEVICE.id, name: 'Lea B.', color: '#FF0000' });
    expect(stored).not.toHaveProperty('deviceId');
    // another account on this device gets this device id as its deviceId, not the first account's
    expect(boardUser({ mode: 'signed-in', me: { user: { id: 'usr_other', name: 'Other', role: 'member' } } } as unknown as AuthState).deviceId).toBe(getUser().id);
    expect(getUser().id).toBe(DEVICE.id);
  });
});

describe('dots cast under the device id', () => {
  it('count against the limit, show as mine, and can be taken back', () => {
    const { store, flow } = appFor(signedIn());
    store.transact(() => store.create(note('a')));
    flow.quickVote(3);
    const step = flow.activeStep()!;
    store.transactAs(() => {
      for (const n of [1, 2]) store.votes.set(`${step.id}:${DEVICE.id}:old${n}`, { itemId: 'a', userId: DEVICE.id, stepId: step.id });
      store.votes.set(`${step.id}:someone-else:x`, { itemId: 'a', userId: 'someone-else', stepId: step.id });
    }, 'votes');
    expect(flow.myVoteCount()).toBe(2);
    expect(flow.myVotesLeft()).toBe(1);
    expect(flow.summary().get('a')).toMatchObject({ mine: 2 });
    flow.handleClick(store.get('a')!, false);
    flow.handleClick(store.get('a')!, false); // over the limit: refused
    expect(flow.myVoteCount()).toBe(3);
    expect([...store.votes.values()].filter((v) => v.userId === me.user.id)).toHaveLength(1); // new dots carry the account id
    flow.handleClick(store.get('a')!, true);
    flow.handleClick(store.get('a')!, true);
    expect(flow.myVoteCount()).toBe(1);
  });
});

describe('a poll answer given under the device id', () => {
  const poll = (flow: Flow) => { flow.quickPoll({ question: 'Which?', options: ['Alpha', 'Beta'], multiple: false, anonymous: true }); return flow.polls.get(flow.activeStep()!.pollId!)!; };

  it('is still the person\'s answer, moves to the account id when they answer again, and the tally counts them once', () => {
    const { store, flow } = appFor(signedIn());
    const p = poll(flow);
    store.pollAnswers.set(answerKey(p.id, DEVICE.id), { pollId: p.id, userId: DEVICE.id, optionIds: [p.options[0].id], updatedAt: 1 });
    expect(flow.polls.mine(p.id)?.optionIds).toEqual([p.options[0].id]);
    expect(flow.polls.tally(p.id).responses).toBe(1);
    flow.polls.choose(p.id, p.options[1].id);
    expect([...store.pollAnswers.keys()]).toEqual([answerKey(p.id, me.user.id)]);
    expect(flow.polls.mine(p.id)?.optionIds).toEqual([p.options[1].id]);
    expect(flow.polls.tally(p.id).responses).toBe(1);
  });

  it('is removed with the account-id answer when the person clears theirs', () => {
    const { store, flow } = appFor(signedIn());
    const p = poll(flow);
    store.pollAnswers.set(answerKey(p.id, DEVICE.id), { pollId: p.id, userId: DEVICE.id, optionIds: [p.options[0].id], updatedAt: 1 });
    flow.polls.clearMine(p.id);
    expect(store.pollAnswers.size).toBe(0);
  });

  it('is left alone for someone with no device id (open mode, a guest)', () => {
    const { store, flow } = appFor({ id: 'u1', name: 'U', color: '#000' });
    const p = poll(flow);
    store.pollAnswers.set(answerKey(p.id, DEVICE.id), { pollId: p.id, userId: DEVICE.id, optionIds: [p.options[0].id], updatedAt: 1 });
    expect(flow.polls.mine(p.id)).toBeUndefined();
    flow.polls.choose(p.id, p.options[1].id);
    expect(store.pollAnswers.size).toBe(2);
  });
});
