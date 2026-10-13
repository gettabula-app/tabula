import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FIXTURE_NAMES,
  FIXTURE_NOW,
  INJECTION_STRINGS,
  ROSTER,
  boardHash,
  boardSnapshot,
  buildFixture,
  revealFlow,
} from '../scripts/lib/playbook-fixtures.mjs';

// The tests rebuild every answer from the Y.Doc with their own copy of the rules, so the generator's truth is checked
// against the board and not against itself.

const DAY = 86400000;
const TODAY = new Date(FIXTURE_NOW).toISOString().slice(0, 10);
const ACTION = /\b(we should|vi borde)\b/i;

type Obj = Record<string, any>;

function objectsOf(doc: Y.Doc): Map<string, Obj> {
  const out = new Map<string, Obj>();
  doc.getMap('objects').forEach((value: any, id: string) => out.set(id, value.toJSON()));
  return out;
}

function sortedIds(list: string[]): string[] {
  return [...list].sort();
}

function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const year = date.getUTCFullYear();
  return `${year}-W${Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1}`;
}

function stems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-zåäö]+/)
      .filter(Boolean)
      .map((word) => word.replace(/s$/, '')),
  );
}

function jaccard(a: string, b: string): number {
  const left = stems(a);
  const right = stems(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

const retro = buildFixture('messy-retro');
const roadmap = buildFixture('stale-roadmap');
const arch = buildFixture('large-architecture');

describe('playbook fixtures: shape', () => {
  it('builds the three named fixtures with their board ids', () => {
    expect(FIXTURE_NAMES).toEqual(['messy-retro', 'stale-roadmap', 'large-architecture']);
    expect([retro.boardId, roadmap.boardId, arch.boardId]).toEqual(['fx-retro', 'fx-roadmap', 'fx-arch']);
    expect(ROSTER.map((person) => person.id)).toEqual(['p-anna', 'p-bo', 'p-cem', 'p-dara', 'p-elin', 'p-farid']);
    expect(new Set(ROSTER.map((person) => person.color)).size).toBe(6);
    expect(INJECTION_STRINGS).toHaveLength(4);
  });
});

describe('playbook fixtures: messy-retro', () => {
  const objects = objectsOf(retro.doc);
  const publicNotes = [...objects].filter(([, o]) => o.type === 'sticky' && !o.privateStep);
  const privateNotes = [...objects].filter(([, o]) => o.type === 'sticky' && o.privateStep === 's-private');
  const frameIds = new Set([...objects].filter(([, o]) => o.type === 'frame').map(([id]) => id));

  it('has three frames and the exact note counts', () => {
    expect([...objects.values()].filter((o) => o.type === 'frame').map((o) => o.name).sort()).toEqual([
      'Ideas', 'To improve', 'Went well',
    ]);
    expect(publicNotes).toHaveLength(70);
    expect(privateNotes).toHaveLength(9);
    expect(publicNotes.every(([, o]) => frameIds.has(o.parent))).toBe(true);
    expect(new Set(publicNotes.map(([, o]) => o.createdBy))).toEqual(new Set(ROSTER.map((person) => person.id)));
  });

  it('has exactly 6 near-duplicate pairs, 2 injection notes, 8 one-word notes and 10 action notes', () => {
    const publicIds = publicNotes.map(([id]) => id);
    const pairs = retro.truth.duplicatePairs as string[][];
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs.flat()).size).toBe(12);
    for (const [a, b] of pairs) {
      expect(objects.get(a)?.text).not.toBe(objects.get(b)?.text);
      expect(jaccard(objects.get(a)!.text, objects.get(b)!.text)).toBeGreaterThanOrEqual(0.5);
    }

    const injected = publicNotes.filter(([, o]) => INJECTION_STRINGS.some((s) => o.text.includes(s))).map(([id]) => id);
    expect(injected).toHaveLength(2);
    expect(sortedIds(retro.truth.injectionNoteIds)).toEqual(sortedIds(injected));

    const oneWord = publicNotes.filter(([, o]) => o.text.trim().split(/\s+/).length === 1).map(([id]) => id);
    expect(oneWord).toHaveLength(8);
    expect(sortedIds(retro.truth.oneWordNoteIds)).toEqual(sortedIds(oneWord));

    const actions = publicNotes.filter(([, o]) => ACTION.test(o.text)).map(([id]) => id);
    expect(actions).toHaveLength(10);
    expect(sortedIds(retro.truth.actionNoteIds)).toEqual(sortedIds(actions));
    for (const id of publicIds) expect(objects.has(id)).toBe(true);
  });

  it('keeps the public notes free of exact duplicates (compared in lowercase)', () => {
    const groups = new Map<string, string[]>();
    for (const [id, o] of publicNotes) {
      const key = String(o.text).toLowerCase().trim();
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    const copies = [...groups.values()].filter((ids) => ids.length > 1);
    const intended = (retro.truth.duplicatePairs as string[][]).map((pair) => sortedIds(pair).join('|'));
    for (const ids of copies) expect(intended).toContain(sortedIds(ids).join('|'));
  });

  it('gives each theme its own notes, and the themes cover every themed note exactly once', () => {
    const themes = retro.truth.themes as { id: string; noteIds: string[] }[];
    expect(themes).toHaveLength(7);
    const seen = new Map<string, string>();
    for (const theme of themes) {
      for (const id of theme.noteIds) {
        expect(seen.has(id), `${id} is in two themes`).toBe(false);
        seen.set(id, theme.id);
      }
    }
    const excluded = new Set([...retro.truth.injectionNoteIds, ...retro.truth.oneWordNoteIds]);
    const themed = publicNotes.map(([id]) => id).filter((id) => !excluded.has(id));
    expect(themed).toHaveLength(60);
    expect(sortedIds([...seen.keys()])).toEqual(sortedIds(themed));
  });

  it('has 9 private notes, each with a unique canary that appears only in private note text', () => {
    const canaries = retro.truth.canaries as { id: string; text: string }[];
    expect(canaries).toHaveLength(9);
    expect(new Set(canaries.map((c) => c.text)).size).toBe(9);
    expect(sortedIds(canaries.map((c) => c.id))).toEqual(sortedIds(privateNotes.map(([id]) => id)));
    for (const canary of canaries) {
      expect(canary.text).toMatch(/^CANARY-RETRO-\d-[0-9a-f]{8}$/);
      expect(objects.get(canary.id)?.text).toContain(canary.text);
    }

    const snapshot = boardSnapshot(retro.doc);
    const publicObjects = Object.fromEntries([...objects].filter(([, o]) => !o.privateStep));
    expect(JSON.stringify({ ...snapshot, objects: publicObjects })).not.toContain('CANARY-RETRO');
    // Nine canaries in the whole board, each once, all inside private notes.
    expect(JSON.stringify(snapshot).split('CANARY-RETRO')).toHaveLength(10);
  });

  it('has private notes flagged with privateStep, and reveal stays false until revealFlow', () => {
    for (const id of retro.truth.privateNoteIds as string[]) expect(objects.get(id)?.privateStep).toBe('s-private');
    const flow = retro.doc.getMap('flow');
    expect(flow.get('reveal')).toBe(false);
    expect((flow.get('steps') as Obj[]).map((step) => step.id)).toEqual(['s-private', 's-vote']);
    expect((flow.get('steps') as Obj[])[1]).toMatchObject({ mode: 'vote', votesPerPerson: 12 });
    // the stored votes respect the step's own limit, so the vote is a state the app could have produced
    const perPerson = new Map<string, number>();
    retro.doc.getMap('votes').forEach((v: unknown) => { const vote = v as { userId: string }; perPerson.set(vote.userId, (perPerson.get(vote.userId) ?? 0) + 1); });
    expect(Math.max(...perPerson.values())).toBeLessThanOrEqual(12);

    const fresh = buildFixture('messy-retro');
    expect(revealFlow(fresh).getMap('flow').get('reveal')).toBe(true);
  });

  it('has 60 votes on 20 distinct public notes, 1 to 5 each, from different people', () => {
    const votes = Object.values(retro.doc.getMap('votes').toJSON()) as Obj[];
    expect(votes).toHaveLength(60);
    const byItem = new Map<string, string[]>();
    for (const vote of votes) byItem.set(vote.itemId, [...(byItem.get(vote.itemId) ?? []), vote.userId]);
    expect(byItem.size).toBe(20);
    const publicIds = new Set(publicNotes.map(([id]) => id));
    for (const [itemId, users] of byItem) {
      expect(publicIds.has(itemId)).toBe(true);
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(users.length).toBeLessThanOrEqual(5);
      expect(new Set(users).size).toBe(users.length);
      expect(retro.truth.voteCounts[itemId]).toBe(users.length);
    }
  });

  it('ranks the top themes by summed votes, ties by theme id', () => {
    const voteCounts: Record<string, number> = {};
    for (const vote of Object.values(retro.doc.getMap('votes').toJSON()) as Obj[]) {
      voteCounts[vote.itemId] = (voteCounts[vote.itemId] ?? 0) + 1;
    }
    const scored = (retro.truth.themes as { id: string; noteIds: string[] }[])
      .map((theme) => ({ id: theme.id, score: theme.noteIds.reduce((sum, id) => sum + (voteCounts[id] ?? 0), 0) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map((theme) => theme.id);
    expect(retro.truth.topThemeIds).toEqual(scored);
  });

  it('has the open-actions container with 5 cards: 3 ownerless (1 overdue), 2 owned (1 due in the future)', () => {
    const cards = [...objects].filter(([, o]) => o.type === 'card');
    expect(cards).toHaveLength(5);
    expect(objects.get('k-actions')).toMatchObject({ layout: 'kanban' });
    const ownerless = cards.filter(([, o]) => !o.ownerId);
    const owned = cards.filter(([, o]) => o.ownerId);
    expect(ownerless).toHaveLength(3);
    expect(ownerless.filter(([, o]) => o.due < TODAY)).toHaveLength(1);
    expect(owned).toHaveLength(2);
    expect(owned.filter(([, o]) => o.due > TODAY)).toHaveLength(1);
    expect(retro.truth.openActions.map((a: Obj) => a.id).sort()).toEqual(cards.map(([id]) => id).sort());
  });
});

describe('playbook fixtures: stale-roadmap', () => {
  const objects = objectsOf(roadmap.doc);
  // Y.Map iteration order is not insertion order, so sort the cards by id.
  const cards = [...objects].filter(([, o]) => o.type === 'card').sort(([a], [b]) => a.localeCompare(b));
  const laneName = new Map([...objects].filter(([, o]) => o.type === 'lane').map(([id, o]) => [id, o.name as string]));
  const laneOf = (card: Obj) => laneName.get(card.parent) ?? '';
  const notDone = (card: Obj) => laneOf(card) !== 'Done';

  it('has four lanes with 12, 14, 12 and 7 cards', () => {
    const lanes = [...objects].filter(([, o]) => o.type === 'lane');
    expect(lanes.map(([, o]) => [o.name, o.stage])).toEqual([
      ['Now', 'doing'], ['Next', 'todo'], ['Later', 'todo'], ['Done', 'done'],
    ]);
    const perLane = new Map<string, number>();
    for (const [, card] of cards) perLane.set(laneOf(card), (perLane.get(laneOf(card)) ?? 0) + 1);
    expect(Object.fromEntries(perLane)).toEqual({ Now: 12, Next: 14, Later: 12, Done: 7 });
    expect(cards).toHaveLength(45);
    expect(cards[0][0]).toBe('c-001');
    expect(cards.map(([id]) => id).sort().at(-1)).toBe('c-045');
  });

  it('recomputes stale, ownerless, overdue and changed-in-7-days sets that match the truth', () => {
    const stale = cards.filter(([, c]) => notDone(c) && FIXTURE_NOW - c.updatedAt > 14 * DAY).map(([id]) => id);
    const ownerless = cards.filter(([, c]) => notDone(c) && !c.ownerId).map(([id]) => id);
    const overdue = cards.filter(([, c]) => notDone(c) && c.due < TODAY).map(([id]) => id);
    const changed = cards.filter(([, c]) => notDone(c) && FIXTURE_NOW - c.updatedAt <= 7 * DAY).map(([id]) => id);
    expect(stale).toHaveLength(8);
    expect(ownerless).toHaveLength(14);
    expect(overdue).toHaveLength(5);
    expect(changed).toHaveLength(10);
    expect(sortedIds(roadmap.truth.staleIds)).toEqual(sortedIds(stale));
    expect(sortedIds(roadmap.truth.ownerlessIds)).toEqual(sortedIds(ownerless));
    expect(sortedIds(roadmap.truth.overdueIds)).toEqual(sortedIds(overdue));
    expect(sortedIds(roadmap.truth.changedLast7Ids)).toEqual(sortedIds(changed));
    // The sets overlap, so a playbook that only reads one flag per card is caught.
    expect(stale.filter((id) => ownerless.includes(id)).length).toBeGreaterThan(0);
    expect(overdue.filter((id) => stale.includes(id)).length).toBeGreaterThan(0);
  });

  it('recomputes the Now-lane clashes: 2 pairs, 4 cards, same owner and ISO week', () => {
    const now = cards.filter(([, c]) => laneOf(c) === 'Now' && c.ownerId);
    const groups = new Map<string, string[]>();
    for (const [id, c] of now) {
      const key = `${c.ownerId}|${isoWeek(c.due)}`;
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    const pairs: string[][] = [];
    for (const ids of groups.values()) {
      for (let a = 0; a < ids.length; a += 1) {
        for (let b = a + 1; b < ids.length; b += 1) pairs.push(sortedIds([ids[a], ids[b]]));
      }
    }
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.flat()).size).toBe(4);
    expect(sortedIds(roadmap.truth.clashPairs.flat())).toEqual(sortedIds(pairs.flat()));
    expect(roadmap.truth.clashPairs.map((p: string[]) => sortedIds(p))).toEqual(pairs);
  });

  it('has the blocker sticky connected to exactly the card in the truth, and the lane map is right', () => {
    const { stickyId, cardId } = roadmap.truth.blocked;
    expect(objects.get(stickyId)).toMatchObject({
      type: 'sticky', text: 'BLOCKED: waiting for the payment provider contract',
    });
    const links = [...objects].filter(([, o]) => o.type === 'connector');
    expect(links.filter(([, o]) => o.from.id === stickyId && o.to.id === cardId)).toHaveLength(1);
    expect(laneOf(objects.get(cardId)!)).toBe('Now');
    for (const [id, card] of cards) expect(roadmap.truth.laneOfCard[id]).toBe(laneOf(card));
  });

  it('gives every card a sortable rank and a due date in ISO form', () => {
    const owned = cards.filter(([, card]) => card.ownerId);
    expect(cards.every(([, card]) => /^\d{4}-\d{2}-\d{2}$/.test(card.due))).toBe(true);
    expect(cards.every(([, card]) => /^a\d{2}$/.test(card.rank))).toBe(true);
    expect(owned.every(([, card]) => card.ownerKind === 'person')).toBe(true);
  });
});

describe('playbook fixtures: large-architecture', () => {
  const objects = objectsOf(arch.doc);
  const byType = (type: string) => [...objects].filter(([, o]) => o.type === type);
  const frames = byType('frame');
  const stickies = byType('sticky');
  const connectors = byType('connector');
  const parentOf = new Map(stickies.map(([id, o]) => [id, o.parent as string]));

  it('has 12 frames, 220 stickies, 12 UML classes and 150 connectors', () => {
    expect(frames).toHaveLength(12);
    expect(stickies).toHaveLength(220);
    expect(byType('uml-class')).toHaveLength(12);
    expect(connectors).toHaveLength(150);
    expect(objects.size).toBe(394);
    expect(arch.truth.objectCount).toBe(394);
  });

  it('puts 12 to 25 stickies in each frame, matching the truth', () => {
    const counts = new Map<string, number>();
    for (const [, o] of stickies) counts.set(o.parent, (counts.get(o.parent) ?? 0) + 1);
    for (const [, n] of counts) expect(n >= 12 && n <= 25).toBe(true);
    expect(Object.fromEntries(counts)).toEqual(arch.truth.countsPerFrame);
  });

  it('has one UML class per frame with 2 to 4 attributes and operations', () => {
    const umls = byType('uml-class');
    expect(new Set(umls.map(([, o]) => o.parent)).size).toBe(12);
    for (const [, uml] of umls) {
      expect(uml.attributes.length).toBeGreaterThanOrEqual(2);
      expect(uml.attributes.length).toBeLessThanOrEqual(4);
      expect(uml.operations.length).toBeGreaterThanOrEqual(2);
      expect(uml.operations.length).toBeLessThanOrEqual(4);
    }
  });

  it('has 110 inter-frame and 40 intra-frame connectors, with a few labels, and the truth pairs match', () => {
    const inter = connectors.filter(([, c]) => parentOf.get(c.from.id) !== parentOf.get(c.to.id));
    const intra = connectors.filter(([, c]) => parentOf.get(c.from.id) === parentOf.get(c.to.id));
    expect(inter).toHaveLength(110);
    expect(intra).toHaveLength(40);
    expect(connectors.filter(([, c]) => c.label).length).toBeGreaterThan(0);
    for (const [, c] of connectors) {
      expect(c.from.kind).toBe('bound');
      expect(c.to.kind).toBe('bound');
    }
    const counts = new Map<string, number>();
    for (const [, c] of inter) {
      const key = `${parentOf.get(c.from.id)}|${parentOf.get(c.to.id)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const pairs = [...counts].map(([key, n]) => [...key.split('|'), n]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
    expect(pairs).toEqual(arch.truth.dependencyPairs);
  });

  it('has exactly 2 locked frames and run-user authorship near 40 percent', () => {
    const locked = frames.filter(([, o]) => o.locked === true).map(([id]) => id);
    expect(locked).toHaveLength(2);
    expect(sortedIds(arch.truth.lockedFrameIds)).toEqual(sortedIds(locked));

    const creators = [...objects.values()].map((o) => o.createdBy);
    const runShare = creators.filter((id) => id === 'p-anna').length / creators.length;
    expect(runShare).toBeGreaterThan(0.35);
    expect(runShare).toBeLessThan(0.45);
    const notRun = [...objects].filter(([, o]) => o.createdBy !== 'p-anna').map(([id]) => id);
    expect(sortedIds(arch.truth.notRunUserIds)).toEqual(sortedIds(notRun));
    expect(arch.truth.runUserId).toBe('p-anna');
  });

  it('has exactly 20 comment threads on distinct objects, with replies on a few', () => {
    const threads = arch.commentsDoc.getMap('threads');
    expect(threads.size).toBe(20);
    const anchors: string[] = [];
    let withReplies = 0;
    threads.forEach((thread: any) => {
      const anchor = thread.get('anchor').obj as string;
      anchors.push(anchor);
      expect(objects.has(anchor)).toBe(true);
      const replies = thread.get('replies') as Y.Map<any>;
      if (replies.size > 0) withReplies += 1;
      replies.forEach((reply: any) => {
        expect(reply.get('text')).toBeTruthy();
        expect(Number(reply.get('createdAt'))).toBeGreaterThan(0);
        expect(reply.get('authorId')).toMatch(/^p-/);
      });
    });
    expect(new Set(anchors).size).toBe(20);
    expect(withReplies).toBeGreaterThanOrEqual(3);
    expect(sortedIds(arch.truth.threadObjectIds)).toEqual(sortedIds(anchors));
  });

  it('refers only to ids that exist in the board', () => {
    const ids = new Set(objects.keys());
    for (const id of Object.keys(arch.truth.countsPerFrame)) expect(ids.has(id)).toBe(true);
    for (const id of arch.truth.lockedFrameIds) expect(ids.has(id)).toBe(true);
    for (const id of arch.truth.notRunUserIds) expect(ids.has(id)).toBe(true);
    for (const id of arch.truth.threadObjectIds) expect(ids.has(id)).toBe(true);
    for (const [from, to] of arch.truth.dependencyPairs) {
      expect(ids.has(from)).toBe(true);
      expect(ids.has(to)).toBe(true);
    }
  });
});

describe('playbook fixtures: determinism, speed and hygiene', () => {
  it('gives the same board hash and truth for every rebuild', () => {
    for (const name of FIXTURE_NAMES) {
      const first = buildFixture(name);
      const second = buildFixture(name);
      expect(boardHash(second.doc)).toBe(boardHash(first.doc));
      expect(second.truth).toEqual(first.truth);
      expect(JSON.stringify(second.commentsDoc.getMap('threads').toJSON())).toBe(
        JSON.stringify(first.commentsDoc.getMap('threads').toJSON()),
      );
    }
  });

  it('builds all three fixtures in under two seconds', () => {
    const started = Date.now();
    for (const name of FIXTURE_NAMES) buildFixture(name);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('has no secret-like field names and no email addresses in any fixture', () => {
    const secretKey = /secret|token|passw|api_?key|credential|private_?key/i;
    const emailShape = /[\w.+-]+@[\w-]+\.\w+/;
    for (const fixture of [retro, roadmap, arch]) {
      const snapshot = boardSnapshot(fixture.doc);
      const keys = keysDeep(snapshot).concat(keysDeep(fixture.commentsDoc.getMap('threads').toJSON()));
      expect(keys.filter((key) => secretKey.test(key))).toEqual([]);
      const text = JSON.stringify([snapshot, fixture.commentsDoc.getMap('threads').toJSON(), fixture.truth]);
      expect(emailShape.test(text)).toBe(false);
    }
  });
});
