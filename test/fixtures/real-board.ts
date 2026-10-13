// A realistic board, built through the app's own factories (the Store, the kanban functions, labels, polls, the comment API),
// deterministically: ids come from a seeded generator and the clock is fixed, so the same code always builds the same board.
// test/fixtures/real-board.drift is its export, committed so a change to the file format or to the importer shows up as a
// failing test; test/real-board.test.ts also rebuilds it and checks the two still agree.

import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import { Store } from '../../src/store';
import { Comments } from '../../src/comments';
import { addCard, editCard, newKanban } from '../../src/containers';
import { createLabel } from '../../src/labels';
import { checkPoll } from '../../src/polls';
import type { BoardApp } from '../../src/app';
import type { BaseObj, ConnectorObj, Obj } from '../../src/types';

const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
export const AUTHOR = { id: 'lea-brandt', name: 'Lea Brandt', color: '#326DD3' };
export const MEMBER = { id: 'marta-lund', name: 'Marta Lund', color: '#1B8151' };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A tiny PNG, the bytes behind the image objects' asset references. */
export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

/** Runs `build` with random ids from a fixed seed and a fixed clock. */
function deterministic<T>(build: () => T): T {
  let x = 0x2f6e2b1;
  const realRandom = crypto.getRandomValues.bind(crypto);
  const realNow = Date.now;
  Object.defineProperty(crypto, 'getRandomValues', {
    configurable: true,
    value: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; a[i] = x >>> 24; } return a; },
  });
  Date.now = () => NOW;
  try {
    return build();
  } finally {
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: realRandom });
    Date.now = realNow;
  }
}

export interface RealBoard { app: BoardApp; store: Store; comments: Comments }

export function buildRealBoard(): RealBoard {
  return deterministic(() => {
    const doc = new Y.Doc();
    doc.clientID = 4242;
    const store = new Store(doc);
    const cdoc = new Y.Doc();
    cdoc.clientID = 4343;
    const comments = new Comments(cdoc);
    const make = (o: Partial<BaseObj> & { id: string; type: BaseObj['type'] }): BaseObj => ({
      x: 0, y: 0, w: 192, h: 192, rotation: 0, z: '', createdBy: AUTHOR.id, updatedAt: NOW, font: 'satoshi', ...o,
    });
    let z = 0;
    const nextZ = () => `a${(z++).toString(36).padStart(2, '0')}`;
    const put = (o: Partial<BaseObj> & { id: string; type: BaseObj['type'] }) => store.transact(() => store.create(make({ ...o, z: nextZ() }) as Obj));

    store.setMeta({ name: 'Q4 planning workshop', gridType: 'lines', gridSize: 24, snap: true, headingFont: 'cabinet-grotesk', bodyFont: 'satoshi', stickyColors: ['#112233'] });
    put({ id: 'frame-ideas', type: 'frame', x: 0, y: 0, w: 960, h: 600, name: 'Ideas', fill: '#FFFFFF', font: 'cabinet-grotesk' });
    put({ id: 'title', type: 'text', x: 24, y: 24, w: 400, h: 40, text: 'What should we build next?', fontSize: 28, fontWeight: 700, parent: 'frame-ideas' });
    const colours = ['#FFE16B', '#FFB979', '#FFA3C4', '#A3D2FF', '#BCE88C'];
    ['Faster boards', 'Offline mode', 'Templates for retros', 'Better export', 'Dark theme', 'Keyboard shortcuts'].forEach((text, i) => {
      put({ id: `idea-${i}`, type: 'sticky', x: 24 + (i % 3) * 210, y: 90 + Math.floor(i / 3) * 210, text, fill: colours[i % colours.length], parent: 'frame-ideas', createdBy: i % 2 ? MEMBER.id : AUTHOR.id });
    });
    put({ id: 'private-note', type: 'sticky', x: 700, y: 90, text: 'A private thought', fill: '#CDB8FF', parent: 'frame-ideas', privateStep: 'step-write' });
    put({ id: 'shape-a', type: 'shape', x: 1100, y: 40, w: 160, h: 90, kind: 'rounded', text: 'Discover', fill: '#FFFFFF', stroke: '#112233', strokeWidth: 2 });
    put({ id: 'shape-b', type: 'shape', x: 1100, y: 220, w: 160, h: 90, kind: 'diamond', text: 'Decide?', fill: '#FFFFFF', stroke: '#112233', dash: 'dashed' });
    put({ id: 'icon-star', type: 'icon', x: 1300, y: 40, w: 64, h: 64, ref: 'mdi:star', body: '<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" fill="currentColor"/>', viewBox: [0, 0, 24, 24] });
    put({ id: 'sticker-1', type: 'icon', x: 1300, y: 140, w: 96, h: 96, ref: 'fluent-emoji:rocket', body: '<circle cx="12" cy="12" r="10"/>', viewBox: [0, 0, 24, 24], sticker: true });
    put({ id: 'photo-1', type: 'image', x: 1100, y: 340, w: 320, h: 200, asset: HASH_A, mime: 'image/png', nw: 640, nh: 400, alt: 'Whiteboard photo' });
    put({ id: 'photo-2', type: 'image', x: 1100, y: 560, w: 160, h: 100, asset: HASH_B, mime: 'image/png', nw: 320, nh: 200 });
    put({ id: 'sketch', type: 'path', x: 1450, y: 300, w: 120, h: 60, points: [0, 0, 20.5, 10, 60, 40, 120, 60], stroke: '#D3332D', strokeWidth: 3 });
    put({ id: 'uml-1', type: 'uml-class', x: 1500, y: 40, w: 220, h: 120, text: 'Board', stereotype: 'entity', attributes: [{ visibility: '+', name: 'id', type: 'string' }], operations: [{ visibility: '+', name: 'open()', type: 'void' }] });
    store.transact(() => {
      store.create(make({ id: 'crew', type: 'group', w: 0, h: 0, z: nextZ(), parent: 'frame-ideas' }) as Obj);
      store.update('idea-0', { parent: 'crew' });
      store.update('idea-1', { parent: 'crew' });
    });
    const link: ConnectorObj = {
      id: 'link-1', type: 'connector', z: nextZ(), from: { kind: 'bound', id: 'shape-a', anchor: 'bottom' }, to: { kind: 'bound', id: 'shape-b', anchor: 'top' },
      route: 'elbow', startHead: 'none', endHead: 'arrow', stroke: '#112233', strokeWidth: 2, createdBy: AUTHOR.id, updatedAt: NOW,
    };
    store.transact(() => store.create(link as Obj));
    // a table (docs/tables.md: one object, a key per part) and a Markdown block, both made by somebody else on another board
    const rowRanks = generateNKeysBetween(null, null, 3);
    const colRanks = generateNKeysBetween(null, null, 3);
    const tableParts: Record<string, string | number> = {};
    ['r1', 'r2', 'r3'].forEach((id, i) => { tableParts[`r:${id}`] = rowRanks[i]; });
    ['c1', 'c2', 'c3'].forEach((id, i) => { tableParts[`k:${id}`] = colRanks[i]; });
    Object.assign(tableParts, { 'w:c1': 220, 'a:c3': 'right', 'f:r1:c1': '#FFE16B' });
    [['Task', 'Owner', 'Cost'], ['Venue', 'Marta', '1,200'], ['Catering', 'Lea', '800']].forEach((cells, r) => cells.forEach((text, c) => { tableParts[`c:r${r + 1}:c${c + 1}`] = text; }));
    put({ id: 'budget-table', type: 'table', x: 1500, y: 400, w: 440, h: 120, headerRow: true, createdBy: MEMBER.id, ...tableParts } as never);
    put({ id: 'notes-md', type: 'markdown', x: 1500, y: 600, w: 320, h: 140, text: '# Next steps\n\n- [ ] Book the venue\n- [x] Send the invites', fontSize: 16, createdBy: MEMBER.id, proposedBy: { feature: 'summarise', by: { id: MEMBER.id, name: MEMBER.name } } });
    put({ id: 'tracker-1', type: 'tracker', x: 0, y: 700, w: 480, h: 360, trackerId: 'workspace-1', view: 'inbox' });

    // a kanban with labels, owners, due dates and links
    const { container, lanes } = newKanban({ x: 0, y: 1150 }, { z: nextZ(), createdBy: AUTHOR.id, headingFont: 'cabinet-grotesk', bodyFont: 'satoshi' });
    store.transact(() => { store.create(container as Obj); lanes.forEach((l) => store.create(l as Obj)); });
    const bug = createLabel(store, 'Bug', 'pink')!;
    const feature = createLabel(store, 'Feature', 'blue')!;
    const c1 = addCard(store, lanes[0].id, 'Fix the login redirect', { createdBy: AUTHOR.id, font: 'satoshi' })!;
    editCard(store, c1, { desc: 'Users land on a blank page after signing in.', owner: { id: MEMBER.id, name: MEMBER.name }, due: '2026-10-30', labels: [bug], link: 'https://example.com/issues/12' });
    const c2 = addCard(store, lanes[1].id, 'Offline mode spike', { createdBy: AUTHOR.id, font: 'satoshi' })!;
    editCard(store, c2, { owner: { name: 'An outside contractor' }, labels: [feature], fill: 'blue' });
    addCard(store, lanes[2].id, 'Ship the new export', { createdBy: MEMBER.id, font: 'satoshi' });

    // a session, a vote and a poll
    const poll = checkPoll({ question: 'Which idea first?', options: ['Faster boards', 'Offline mode'], multiple: false, anonymous: false });
    store.polls.set('poll-1', { id: 'poll-1', question: poll.question, options: poll.options.map((text, i) => ({ id: `opt-${i}`, text })), multiple: false, anonymous: false, revealed: true, createdAt: NOW, createdBy: AUTHOR.id, openedAt: NOW });
    store.pollState.set('poll-1:revealed', true);
    store.pollAnswers.set(`poll-1:${MEMBER.id}`, { pollId: 'poll-1', userId: MEMBER.id, optionIds: ['opt-1'], updatedAt: NOW, name: MEMBER.name, color: MEMBER.color });
    store.setFlow({
      steps: [
        { id: 'step-write', title: 'Write ideas', instructions: 'Add a note per idea', mode: 'private-write', frameId: 'frame-ideas', durationSec: 300 },
        { id: 'step-vote', title: 'Vote', instructions: 'Place your dots', mode: 'vote', votesPerPerson: 3 },
        { id: 'step-poll', title: 'Poll', instructions: 'Pick one', mode: 'poll', pollId: 'poll-1' },
      ],
      active: 1, reveal: true, timer: { startedAt: NOW, durationMs: 300_000 }, focus: { x: 10, y: 20, zoom: 1, ts: NOW, by: MEMBER.id }, stepStartedAt: NOW, results: null,
    });
    store.votes.set(`step-vote:${MEMBER.id}:v1`, { itemId: 'idea-2', userId: MEMBER.id, stepId: 'step-vote' });
    store.votes.set(`step-vote:${AUTHOR.id}:v2`, { itemId: 'idea-3', userId: AUTHOR.id, stepId: 'step-vote' });

    const t1 = comments.addThread(AUTHOR, { x: 24, y: 90, obj: 'idea-0', fx: 0.2, fy: 0.3 }, 'Can we do this one this quarter?')!;
    comments.reply(t1, MEMBER, 'Probably, if we cut the scope.');
    comments.addThread(MEMBER, { x: 600, y: 400 }, 'Pin on empty canvas');
    comments.setResolved(t1, true, AUTHOR);

    const app = {
      store,
      flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [...store.polls.values()], answers: [...store.pollAnswers.values()] }) } },
      conn: { comments },
      images: { blobOf: async (key: string) => (key === HASH_A || key === HASH_B ? new Blob([PNG as BlobPart], { type: 'image/png' }) : null) },
    } as unknown as BoardApp;
    return { app, store, comments };
  });
}
