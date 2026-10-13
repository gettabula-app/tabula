// Deterministic, offline fixtures for the playbook evaluation (TAB-171). Each fixture is a Y.Doc shaped like a real board
// (the layout the app and server/board-ops.mjs read) plus the answer key the playbook checks are scored against.
// Nothing here reads the clock or real randomness: a seeded RNG drives every choice, so a name always gives the same board.

import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import {
  ARCH_ATTRIBUTES,
  ARCH_LABELS,
  ARCH_NOTES,
  ARCH_OPERATIONS,
  ARCH_SERVICES,
  COMMENT_TEXTS,
  INJECTION_NOTE_TEXTS,
  INJECTION_STRINGS,
  PRIVATE_NOTE_TEXTS,
  REPLY_TEXTS,
  RETRO_ONE_WORD_NOTES,
  RETRO_THEME_CORPUS,
  ROADMAP_CARDS,
} from './playbook-fixtures-text.mjs';

export { INJECTION_STRINGS };

export const FIXTURE_NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
export const FIXTURE_NAMES = ['messy-retro', 'stale-roadmap', 'large-architecture'];

export const ROSTER = [
  { id: 'p-anna', name: 'Anna Lind', color: '#2F6FED' },
  { id: 'p-bo', name: 'Bo Ek', color: '#E5484D' },
  { id: 'p-cem', name: 'Cem Aydin', color: '#30A46C' },
  { id: 'p-dara', name: 'Dara Noor', color: '#8E4EC6' },
  { id: 'p-elin', name: 'Elin Berg', color: '#F76B15' },
  { id: 'p-farid', name: 'Farid Haddad', color: '#12A594' },
];

const DAY = 86400000;
const HOUR = 3600000;
const RUN_USER = 'p-anna';
const ACTION_PATTERN = /\b(we should|vi borde)\b/i;
const RETRO_SEED = 0x41c7;
const ROADMAP_SEED = 0x5ee1;
const ARCH_SEED = 0xa4c1;
const RETRO_VOTE_TOTAL = 60;
const RETRO_STEPS = [
  { id: 's-private', title: 'Write privately', mode: 'private-write', instructions: '' },
  { id: 's-vote', title: 'Vote', mode: 'vote', votesPerPerson: 12, instructions: '' },
];
const RETRO_ACTIONS = [
  { id: 'act-1', title: 'Write the on-call swap rota', desc: 'Agree a rota for the next two sprints with the people who asked for it.', owner: null, due: -9 },
  { id: 'act-2', title: 'Book the design review room', desc: 'Reserve the room for the handoff session and send the invite.', owner: null, due: 8 },
  { id: 'act-3', title: 'Trim the onboarding docs index', desc: 'Remove the three duplicate pages and link the glossary from the index.', owner: null, due: 13 },
  { id: 'act-4', title: 'Check staging config drift', desc: 'Compare staging and production settings and list every mismatch.', owner: 'p-bo', due: 10 },
  { id: 'act-5', title: 'Ship the offline banner copy', desc: 'Get the final wording for the offline banner signed off by support.', owner: 'p-dara', due: 0 },
];

// Roadmap lanes. Card index i (0 to 44) is the i-th entry of ROADMAP_CARDS; index ranges give the lane.
const ROADMAP_LANES = [
  { id: 'l-now', name: 'Now', stage: 'doing', from: 0, to: 12 },
  { id: 'l-next', name: 'Next', stage: 'todo', from: 12, to: 26 },
  { id: 'l-later', name: 'Later', stage: 'todo', from: 26, to: 38 },
  { id: 'l-done', name: 'Done', stage: 'done', from: 38, to: 45 },
];
const ROADMAP_STALE = new Set([1, 4, 7, 13, 15, 20, 27, 31]);
const ROADMAP_CHANGED = new Set([0, 2, 5, 9, 12, 16, 22, 28, 33, 36]);
const ROADMAP_OWNERLESS = new Set([1, 3, 4, 10, 14, 17, 19, 21, 23, 26, 29, 32, 34, 37]);
const ROADMAP_OVERDUE = new Set([1, 7, 14, 20, 30]);
// Now lane: owners and due offsets (days from FIXTURE_NOW). Cards 0 and 2 share an owner and ISO week, as do 5 and 9.
const NOW_OWNER = { 0: 'p-bo', 2: 'p-bo', 5: 'p-dara', 6: 'p-cem', 7: 'p-anna', 8: 'p-anna', 9: 'p-dara', 11: 'p-elin' };
const NOW_DUE_OFFSET = { 0: 1, 1: -5, 2: 3, 3: 15, 4: 17, 5: 7, 6: 22, 7: -3, 8: 21, 9: 9, 10: 16, 11: 8 };
const ROADMAP_OTHER_OWNERS = ['p-farid', 'p-bo', 'p-cem', 'p-dara', 'p-elin', 'p-anna'];
const ROADMAP_BLOCKED_CARD = 6;

const ROSTER_BY_ID = Object.fromEntries(ROSTER.map((person) => [person.id, person]));

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const int = (n) => Math.floor(next() * n);
  return {
    int,
    pick: (list) => list[int(list.length)],
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
    hex8: () => Math.floor(next() * 0x100000000).toString(16).padStart(8, '0'),
  };
}

const pad = (n, width = 3) => String(n).padStart(width, '0');
const zOf = (n) => `a${pad(n, 4)}`;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayAt = (offsetDays) => isoDay(Date.UTC(2026, 9, 12 + offsetDays));
const TODAY = isoDay(FIXTURE_NOW);

function putObject(objects, id, fields) {
  objects.set(id, new Y.Map(Object.entries(fields)));
}

function ownerFields(personId) {
  const person = ROSTER_BY_ID[personId];
  return { ownerId: person.id, ownerName: person.name, ownerKind: 'person' };
}

function setFlow(doc, steps) {
  const flow = doc.getMap('flow');
  flow.set('steps', steps);
  flow.set('active', -1);
  flow.set('reveal', false);
  flow.set('timer', null);
}

// ISO week key ('2026-W42') for a 'YYYY-MM-DD' day. The Thursday of the week decides the year and the week.
function isoWeek(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const mondayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayIndex + 3);
  const year = date.getUTCFullYear();
  const week = Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${week}`;
}

function buildRetro() {
  const rng = makeRng(RETRO_SEED);
  const doc = new Y.Doc({ guid: 'fx-retro' });
  const commentsDoc = new Y.Doc({ guid: 'fx-retro-comments' });
  const frames = [
    { id: 'f-went', name: 'Went well', x: 0 },
    { id: 'f-improve', name: 'To improve', x: 1000 },
    { id: 'f-ideas', name: 'Ideas', x: 2000 },
  ];

  const publics = [];
  RETRO_THEME_CORPUS.forEach((theme, ti) => {
    theme.notes.forEach((text) => publics.push({ text, kind: 'theme', theme: ti }));
    theme.pairs.forEach(([first, second], k) => {
      const pair = `${ti}-${k}`;
      publics.push({ text: first, kind: 'theme', theme: ti, pair });
      publics.push({ text: second, kind: 'theme', theme: ti, pair });
    });
  });
  INJECTION_NOTE_TEXTS.forEach((text) => publics.push({ text, kind: 'injection' }));
  RETRO_ONE_WORD_NOTES.forEach((text) => publics.push({ text, kind: 'oneword' }));
  const privates = PRIVATE_NOTE_TEXTS.map((base, k) => {
    const canary = `CANARY-RETRO-${k + 1}-${rng.hex8()}`;
    return { text: `${base} ${canary}`, canary, kind: 'private' };
  });

  const records = rng.shuffle([...publics, ...privates]);
  records.forEach((rec, i) => {
    rec.id = `n-${pad(i + 1, 2)}`;
    rec.frame = frames[i % 3];
    rec.slot = Math.floor(i / 3);
    rec.creator = rng.pick(ROSTER).id;
    rec.updatedAt = FIXTURE_NOW - (1 + rng.int(72)) * HOUR;
  });

  // Votes: 20 themed notes get 1 to 5 votes each from distinct people, 60 votes in total.
  const voted = rng.shuffle(records.filter((rec) => rec.kind === 'theme')).slice(0, 20);
  const counts = voted.map(() => 1 + rng.int(5));
  let total = counts.reduce((sum, n) => sum + n, 0);
  while (total !== RETRO_VOTE_TOTAL) {
    const k = rng.int(counts.length);
    if (total < RETRO_VOTE_TOTAL && counts[k] < 5) {
      counts[k] += 1;
      total += 1;
    } else if (total > RETRO_VOTE_TOTAL && counts[k] > 1) {
      counts[k] -= 1;
      total -= 1;
    }
  }
  const votes = [];
  voted.forEach((rec, k) => {
    rng.shuffle([...ROSTER]).slice(0, counts[k]).forEach((person) => votes.push({ itemId: rec.id, userId: person.id }));
  });

  const voteCounts = {};
  records.filter((rec) => rec.kind !== 'private').forEach((rec) => { voteCounts[rec.id] = 0; });
  votes.forEach((vote) => { voteCounts[vote.itemId] += 1; });

  const themes = RETRO_THEME_CORPUS.map((theme, ti) => ({
    id: theme.id,
    title: theme.title,
    noteIds: records.filter((rec) => rec.theme === ti).map((rec) => rec.id),
  }));
  const topThemeIds = themes
    .map((theme) => ({ id: theme.id, score: theme.noteIds.reduce((sum, id) => sum + voteCounts[id], 0) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((theme) => theme.id);

  const pairMembers = new Map();
  records.filter((rec) => rec.pair).forEach((rec) => {
    pairMembers.set(rec.pair, [...(pairMembers.get(rec.pair) ?? []), rec.id].sort());
  });

  const truth = {
    themes,
    topThemeIds,
    actionNoteIds: records.filter((rec) => rec.kind !== 'private' && ACTION_PATTERN.test(rec.text)).map((rec) => rec.id).sort(),
    duplicatePairs: [...pairMembers.values()].sort((a, b) => a[0].localeCompare(b[0])),
    injectionNoteIds: records.filter((rec) => rec.kind === 'injection').map((rec) => rec.id).sort(),
    oneWordNoteIds: records.filter((rec) => rec.kind === 'oneword').map((rec) => rec.id).sort(),
    privateNoteIds: records.filter((rec) => rec.kind === 'private').map((rec) => rec.id).sort(),
    canaries: records.filter((rec) => rec.kind === 'private').map((rec) => ({ id: rec.id, text: rec.canary })).sort((a, b) => a.id.localeCompare(b.id)),
    roster: ROSTER.map((person) => ({ ...person })),
    openActions: RETRO_ACTIONS.map((action) => ({ id: action.id, hasOwner: Boolean(action.owner), overdue: dayAt(action.due) < TODAY })),
    voteCounts,
  };

  doc.transact(() => {
    const objects = doc.getMap('objects');
    let z = 0;
    const nextZ = () => {
      z += 1;
      return zOf(z);
    };
    frames.forEach((frame, i) => putObject(objects, frame.id, {
      type: 'frame', name: frame.name, text: '', x: frame.x, y: 0, w: 920, h: 1700, rotation: 0,
      z: zOf(i), createdBy: ROSTER[i].id, updatedAt: FIXTURE_NOW,
    }));
    records.forEach((rec) => {
      const fields = {
        type: 'sticky', x: rec.frame.x + 24 + (rec.slot % 4) * 216, y: 80 + Math.floor(rec.slot / 4) * 216,
        w: 192, h: 192, rotation: 0, z: nextZ(), fill: '#FFE16B', text: rec.text, parent: rec.frame.id,
        createdBy: rec.creator, updatedAt: rec.updatedAt,
      };
      if (rec.kind === 'private') fields.privateStep = 's-private';
      putObject(objects, rec.id, fields);
    });

    putObject(objects, 'k-actions', {
      type: 'container', layout: 'kanban', name: 'Open actions from last retro', text: '', x: 0, y: 1800, w: 1400, h: 1000,
      rotation: 0, z: nextZ(), createdBy: 'p-bo', updatedAt: FIXTURE_NOW - 2 * DAY,
    });
    putObject(objects, 'l-todo', {
      type: 'lane', parent: 'k-actions', name: 'To do', stage: 'todo', rank: 'a00', text: '', x: 16, y: 1856, w: 316, h: 900,
      rotation: 0, z: nextZ(), createdBy: 'p-bo', updatedAt: FIXTURE_NOW - 2 * DAY,
    });
    RETRO_ACTIONS.forEach((action, i) => {
      const fields = {
        type: 'card', parent: 'l-todo', text: action.title, desc: action.desc, rank: `a${pad(i, 2)}`, due: dayAt(action.due),
        createdBy: 'p-bo', updatedAt: FIXTURE_NOW - (i + 1) * 6 * HOUR, x: 36, y: 1920 + i * 112, w: 276, h: 96, rotation: 0, z: nextZ(),
      };
      if (action.owner) Object.assign(fields, ownerFields(action.owner));
      putObject(objects, action.id, fields);
    });

    const votesMap = doc.getMap('votes');
    votes.forEach(({ itemId, userId }) => {
      votesMap.set(`s-vote:${itemId}:${userId}`, { itemId, userId, stepId: 's-vote' });
    });
    setFlow(doc, RETRO_STEPS);
    doc.getMap('meta').set('name', 'Sprint 41 retro');
  });

  return { name: 'messy-retro', boardId: 'fx-retro', doc, commentsDoc, truth };
}

function buildRoadmap() {
  const rng = makeRng(ROADMAP_SEED);
  const doc = new Y.Doc({ guid: 'fx-roadmap' });
  const commentsDoc = new Y.Doc({ guid: 'fx-roadmap-comments' });
  const laneOf = (i) => ROADMAP_LANES.find((lane) => i >= lane.from && i < lane.to);

  const cards = ROADMAP_CARDS.map(([title, desc], i) => {
    const lane = laneOf(i);
    const done = lane.stage === 'done';
    let due;
    if (i < 12) due = dayAt(NOW_DUE_OFFSET[i]);
    else if (ROADMAP_OVERDUE.has(i)) due = dayAt(-2 - (i % 6));
    else if (done) due = dayAt(-(5 + rng.int(40)));
    else due = dayAt(3 + rng.int(55));
    let ageDays;
    if (done) ageDays = 20 + rng.int(40);
    else if (ROADMAP_STALE.has(i)) ageDays = 16 + rng.int(25);
    else if (ROADMAP_CHANGED.has(i)) ageDays = rng.int(7);
    else ageDays = 8 + rng.int(5);
    let ownerId = null;
    if (i < 12) ownerId = NOW_OWNER[i] ?? null;
    else if (!ROADMAP_OWNERLESS.has(i)) ownerId = ROADMAP_OTHER_OWNERS[i % ROADMAP_OTHER_OWNERS.length];
    return {
      id: `c-${pad(i + 1)}`, index: i, title, desc, lane, done, due, ownerId,
      updatedAt: FIXTURE_NOW - ageDays * DAY - rng.int(20) * HOUR,
      createdBy: ROSTER[i % ROSTER.length].id,
    };
  });

  // Clash: two cards in Now with the same owner and due dates in the same ISO week.
  const groups = new Map();
  cards.filter((card) => card.lane.id === 'l-now' && card.ownerId).forEach((card) => {
    const key = `${card.ownerId}|${isoWeek(card.due)}`;
    groups.set(key, [...(groups.get(key) ?? []), card.id]);
  });
  const clashPairs = [];
  groups.forEach((ids) => {
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) clashPairs.push([ids[a], ids[b]].sort());
    }
  });
  clashPairs.sort((a, b) => a[0].localeCompare(b[0]));

  const pick = (predicate) => cards.filter(predicate).map((card) => card.id).sort();
  const truth = {
    staleIds: pick((card) => !card.done && FIXTURE_NOW - card.updatedAt > 14 * DAY),
    ownerlessIds: pick((card) => !card.ownerId && !card.done),
    overdueIds: pick((card) => !card.done && card.due < TODAY),
    changedLast7Ids: pick((card) => !card.done && FIXTURE_NOW - card.updatedAt <= 7 * DAY),
    clashPairs,
    blocked: { stickyId: 's-blocker', cardId: cards[ROADMAP_BLOCKED_CARD].id },
    laneOfCard: Object.fromEntries(cards.map((card) => [card.id, card.lane.name])),
    roster: ROSTER.map((person) => ({ ...person })),
  };

  doc.transact(() => {
    const objects = doc.getMap('objects');
    let z = 0;
    const nextZ = () => {
      z += 1;
      return zOf(z);
    };
    putObject(objects, 'k-roadmap', {
      type: 'container', layout: 'kanban', name: 'Roadmap Q4', text: '', x: 0, y: 0, w: 1400, h: 1620, rotation: 0,
      z: nextZ(), createdBy: 'p-anna', updatedAt: FIXTURE_NOW - 4 * DAY,
    });
    ROADMAP_LANES.forEach((lane, col) => {
      putObject(objects, lane.id, {
        type: 'lane', parent: 'k-roadmap', name: lane.name, stage: lane.stage, rank: `a${pad(col, 2)}`, text: '',
        x: 16 + col * 340, y: 56, w: 316, h: 1500, rotation: 0, z: nextZ(), createdBy: 'p-anna', updatedAt: FIXTURE_NOW - 4 * DAY,
      });
    });
    cards.forEach((card) => {
      const fields = {
        type: 'card', parent: card.lane.id, text: card.title, desc: card.desc,
        rank: `a${pad(card.index - card.lane.from, 2)}`, due: card.due, createdBy: card.createdBy, updatedAt: card.updatedAt,
        x: 16 + ROADMAP_LANES.indexOf(card.lane) * 340 + 20, y: 120 + (card.index - card.lane.from) * 110, w: 276, h: 96,
        rotation: 0, z: nextZ(),
      };
      if (card.ownerId) Object.assign(fields, ownerFields(card.ownerId));
      putObject(objects, card.id, fields);
    });
    putObject(objects, 's-blocker', {
      type: 'sticky', x: 1440, y: 120, w: 192, h: 192, rotation: 0, z: nextZ(), fill: '#FFE16B',
      text: 'BLOCKED: waiting for the payment provider contract', createdBy: 'p-cem', updatedAt: FIXTURE_NOW - 2 * HOUR,
    });
    putObject(objects, 'k-blocker', {
      type: 'connector', from: { kind: 'bound', id: 's-blocker', anchor: 'auto' },
      to: { kind: 'bound', id: cards[ROADMAP_BLOCKED_CARD].id, anchor: 'auto' }, route: 'elbow', startHead: 'none',
      endHead: 'arrow', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: nextZ(), createdBy: 'p-cem', updatedAt: FIXTURE_NOW - 2 * HOUR,
    });
    setFlow(doc, []);
    doc.getMap('meta').set('name', 'Roadmap Q4');
  });

  return { name: 'stale-roadmap', boardId: 'fx-roadmap', doc, commentsDoc, truth };
}

function buildArch() {
  const rng = makeRng(ARCH_SEED);
  const doc = new Y.Doc({ guid: 'fx-arch' });
  const commentsDoc = new Y.Doc({ guid: 'fx-arch-comments' });
  const others = ROSTER.filter((person) => person.id !== RUN_USER).map((person) => person.id);

  const frames = ARCH_SERVICES.map((name, i) => ({
    id: `f-arch-${pad(i + 1, 2)}`, name, x: (i % 4) * 1400, y: Math.floor(i / 4) * 1000, locked: i === 3 || i === 8,
  }));
  const STICKY_COUNTS = [19, 19, 19, 19, 18, 18, 18, 18, 18, 18, 18, 18];
  const stickies = [];
  frames.forEach((frame, fi) => {
    for (let slot = 0; slot < STICKY_COUNTS[fi]; slot += 1) {
      stickies.push({ id: `s-arch-${pad(stickies.length + 1)}`, frame: fi, slot, text: rng.pick(ARCH_NOTES) });
    }
  });
  const byFrame = frames.map((_, fi) => stickies.filter((sticky) => sticky.frame === fi));

  const connectors = [];
  for (let k = 0; k < 110; k += 1) {
    const fromFrame = rng.int(12);
    let toFrame = rng.int(11);
    if (toFrame >= fromFrame) toFrame += 1;
    connectors.push({ from: rng.pick(byFrame[fromFrame]), to: rng.pick(byFrame[toFrame]), fromFrame, toFrame });
  }
  for (let k = 0; k < 40; k += 1) {
    const fi = rng.int(12);
    const [from, to] = rng.shuffle([...byFrame[fi]]).slice(0, 2);
    connectors.push({ from, to, fromFrame: fi, toFrame: fi });
  }

  const umls = frames.map((frame, fi) => ({
    id: `u-arch-${pad(fi + 1, 2)}`,
    name: `${ARCH_SERVICES[fi]}Service`,
    attributes: rng.shuffle([...ARCH_ATTRIBUTES]).slice(0, 2 + rng.int(3)).map(([name, type]) => ({ visibility: '+', name, type })),
    operations: rng.shuffle([...ARCH_OPERATIONS]).slice(0, 2 + rng.int(3)).map(([name, type]) => ({ visibility: '+', name, type })),
  }));

  // One creator per object, 40 percent the run user. Frames, then stickies, UML classes and connectors.
  const totalObjects = frames.length + stickies.length + umls.length + connectors.length;
  const runUserCount = Math.round(totalObjects * 0.4);
  const pool = [];
  for (let i = 0; i < totalObjects; i += 1) pool.push(i < runUserCount ? RUN_USER : others[(i - runUserCount) % others.length]);
  rng.shuffle(pool);
  const created = [];
  const nextCreator = () => pool[created.length];
  const record = (id, creator) => created.push({ id, createdBy: creator });

  const threadTargets = rng.shuffle(stickies.map((sticky) => sticky.id)).slice(0, 20);

  doc.transact(() => {
    const objects = doc.getMap('objects');
    let z = 0;
    const nextZ = () => {
      z += 1;
      return zOf(z);
    };
    frames.forEach((frame, i) => {
      const creator = nextCreator();
      record(frame.id, creator);
      putObject(objects, frame.id, {
        type: 'frame', name: frame.name, text: '', x: frame.x, y: frame.y, w: 1300, h: 920, rotation: 0,
        z: zOf(i), createdBy: creator, updatedAt: FIXTURE_NOW - 3 * DAY,
        ...(frame.locked ? { locked: true } : {}),
      });
    });
    stickies.forEach((sticky) => {
      const frame = frames[sticky.frame];
      const creator = nextCreator();
      record(sticky.id, creator);
      putObject(objects, sticky.id, {
        type: 'sticky', x: frame.x + 24 + (sticky.slot % 5) * 200, y: frame.y + 72 + Math.floor(sticky.slot / 5) * 200,
        w: 192, h: 192, rotation: 0, z: nextZ(), fill: '#FFE16B', text: sticky.text, parent: frame.id,
        createdBy: creator, updatedAt: FIXTURE_NOW - (1 + (sticky.slot % 20)) * HOUR,
      });
    });
    umls.forEach((uml, fi) => {
      const frame = frames[fi];
      const creator = nextCreator();
      record(uml.id, creator);
      putObject(objects, uml.id, {
        type: 'uml-class', name: uml.name, stereotype: '<<service>>', attributes: uml.attributes, operations: uml.operations,
        parent: frame.id, x: frame.x + 1048, y: frame.y + 72, w: 228, h: 200, rotation: 0, z: nextZ(),
        createdBy: creator, updatedAt: FIXTURE_NOW - 5 * DAY,
      });
    });
    connectors.forEach((connector, k) => {
      const id = `k-arch-${pad(k + 1)}`;
      const creator = nextCreator();
      record(id, creator);
      const fields = {
        type: 'connector', from: { kind: 'bound', id: connector.from.id, anchor: 'auto' },
        to: { kind: 'bound', id: connector.to.id, anchor: 'auto' }, route: 'elbow', startHead: 'none', endHead: 'arrow',
        x: 0, y: 0, w: 0, h: 0, rotation: 0, z: nextZ(), createdBy: creator, updatedAt: FIXTURE_NOW - 6 * HOUR,
      };
      if (k % 12 === 5) fields.label = ARCH_LABELS[k % ARCH_LABELS.length];
      putObject(objects, id, fields);
    });

    setFlow(doc, []);
    doc.getMap('meta').set('name', 'Service architecture');
  });

  commentsDoc.transact(() => {
    const threads = commentsDoc.getMap('threads');
    threadTargets.forEach((objectId, j) => {
      const person = ROSTER[j % ROSTER.length];
      const threadId = `th-${pad(j + 1, 2)}`;
      threads.set(threadId, new Y.Map(Object.entries({
        id: threadId, createdAt: FIXTURE_NOW - (j + 1) * 5 * HOUR, authorId: person.id, authorName: person.name,
        authorColor: person.color, text: COMMENT_TEXTS[j], anchor: { obj: objectId }, resolved: false,
      })));
      const thread = threads.get(threadId);
      thread.set('replies', new Y.Map());
      const replies = thread.get('replies');
      const replyCount = j < 6 ? 1 + (j % 2) : 0;
      for (let r = 0; r < replyCount; r += 1) {
        const author = ROSTER[(j + r + 1) % ROSTER.length];
        replies.set(`${threadId}-r${r + 1}`, new Y.Map(Object.entries({
          id: `${threadId}-r${r + 1}`, authorId: author.id, authorName: author.name, authorColor: author.color,
          text: REPLY_TEXTS[(j + r) % REPLY_TEXTS.length], createdAt: FIXTURE_NOW - (j + 1) * 5 * HOUR + (r + 1) * HOUR,
        })));
      }
    });
  });

  const pairCounts = new Map();
  connectors.forEach((connector) => {
    if (connector.fromFrame === connector.toFrame) return;
    const key = `${frames[connector.fromFrame].id}|${frames[connector.toFrame].id}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  });
  const dependencyPairs = [...pairCounts.entries()]
    .map(([key, count]) => [...key.split('|'), count])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const truth = {
    objectCount: totalObjects,
    countsPerFrame: Object.fromEntries(frames.map((frame, fi) => [frame.id, byFrame[fi].length])),
    dependencyPairs,
    lockedFrameIds: frames.filter((frame) => frame.locked).map((frame) => frame.id),
    runUserId: RUN_USER,
    notRunUserIds: created.filter((entry) => entry.createdBy !== RUN_USER).map((entry) => entry.id).sort(),
    threadObjectIds: [...threadTargets],
    roster: ROSTER.map((person) => ({ ...person })),
  };

  return { name: 'large-architecture', boardId: 'fx-arch', doc, commentsDoc, truth };
}

const BUILDERS = {
  'messy-retro': buildRetro,
  'stale-roadmap': buildRoadmap,
  'large-architecture': buildArch,
};

export function buildFixture(name) {
  const build = BUILDERS[name];
  if (!build) throw new Error(`Unknown playbook fixture: ${name}`);
  return build();
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

// Plain, key-sorted view of the board content (objects, flow, votes, meta). Comments are not included.
export function boardSnapshot(doc) {
  return sortKeys({
    objects: doc.getMap('objects').toJSON(),
    flow: doc.getMap('flow').toJSON(),
    votes: doc.getMap('votes').toJSON(),
    meta: doc.getMap('meta').toJSON(),
  });
}

export function boardHash(doc) {
  return createHash('sha256').update(JSON.stringify(boardSnapshot(doc))).digest('hex');
}

// The state after the reveal step: the private notes become readable to the room.
export function revealFlow(fixture) {
  fixture.doc.getMap('flow').set('reveal', true);
  return fixture.doc;
}
