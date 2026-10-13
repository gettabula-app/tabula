// Board data as the real client writes it, for test/sync-validate.test.ts and scripts/sync-validate-report.mjs. Every
// fixture is built by the client's own code (the Store, the template Builder, the demo seed, the kanban and comment
// functions) or, where that code needs a whole BoardApp, by a literal copied from the call site that is named next to it.
// A fixture is a list of changes in the shape validateChangedKeys takes; nothing here validates.

import * as Y from 'yjs';
import { Builder, TEMPLATES } from '../src/templates';
import { Store, newId } from '../src/store';
import { tableFromGrid } from '../shared/tables';
import { Comments } from '../src/comments';
import { seedDemo } from '../src/demo/seed';
import { addCard, editCard, newKanban, stickiesToCards } from '../src/containers';
import { createLabel } from '../src/labels';
import { createTrackerFrame } from '../src/tracker-frame';
import { checkPoll } from '../src/polls';
import { builtinToCustom } from '../src/template-file';
import { instantiate } from '../src/custom-templates';
import { layout, parseMermaid } from '../src/mermaid';
import { SHAPE_KINDS } from '../src/shapes';
import { RELATIONS, UML_ELEMENTS } from '../src/uml';
import { USER_COLORS } from '../src/palette';
import { BUILTIN_FONTS } from '../src/font-policy';
import { UNFURL_ERRORS } from '../server/sync-validate.mjs';
import type { BoardApp } from '../src/app';
import type { BaseObj, ConnectorObj, Obj, ObjType } from '../src/types';

export interface Change {
  kind: string;
  key: string;
  value: unknown;
  isNew?: boolean;
  fields?: string[];
  prev?: Record<string, unknown>;
  replyIds?: string[];
}
export interface Fixture {
  name: string;
  /** The user the relay would see as the writer. */
  writer: { id: string; name: string; color: string };
  changes: Change[];
  /** Context fields to add for this fixture (a policy, for example). */
  ctx?: Record<string, unknown>;
}

const USER = { id: 'u1', name: 'Lea Brandt', color: USER_COLORS[0] };

/** Every key of the board maps and the comment threads of a store, as creation changes. */
export function changesOf(store: Store, comments?: Comments): Change[] {
  const out: Change[] = [];
  store.objects.forEach((m, key) => out.push({ kind: 'object', key, value: m.toJSON(), isNew: true }));
  store.meta.forEach((value, key) => out.push({ kind: 'meta', key, value: toPlain(value), isNew: true }));
  store.flow.forEach((value, key) => out.push({ kind: 'flow', key, value: toPlain(value), isNew: true }));
  store.votes.forEach((value, key) => out.push({ kind: 'vote', key, value, isNew: true }));
  store.polls.forEach((value, key) => out.push({ kind: 'poll', key, value, isNew: true }));
  store.pollAnswers.forEach((value, key) => out.push({ kind: 'pollAnswer', key, value, isNew: true }));
  store.pollState.forEach((value, key) => out.push({ kind: 'pollState', key, value, isNew: true }));
  store.labels.forEach((value, key) => out.push({ kind: 'label', key, value, isNew: true }));
  if (comments) comments.threads.forEach((m, key) => out.push({ kind: 'thread', key, value: m.toJSON(), isNew: true }));
  return out;
}

const toPlain = (v: unknown): unknown => (v instanceof Y.AbstractType ? v.toJSON() : v);

// ---------------------------------------------------------------- the built-in templates

const host = { user: { id: USER.id }, store: { getMeta: () => ({ bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' }) } };

export function templateFixtures(): Fixture[] {
  return TEMPLATES.map((def) => {
    const builder = new Builder(host, 0, 0);
    def.build(builder);
    const store = new Store(new Y.Doc());
    let z = 0;
    store.transact(() => {
      for (const o of builder.objs) store.create({ ...o, z: o.z || `a${(z++).toString(36)}` } as Obj);
      builder.labels.forEach((l, i) => store.labels.set(l.id, { id: l.id, name: l.name, color: l.color, order: i }));
    });
    const changes = changesOf(store);
    if (builder.steps.length) changes.push({ kind: 'flow', key: 'steps', value: builder.steps, isNew: true });
    return { name: `template:${def.id}`, writer: USER, changes };
  });
}

// ---------------------------------------------------------------- the demo board

function demoApp(): BoardApp {
  const bounds = { x: 40, y: 25, w: 1110, h: 525 };
  return {
    store: new Store(new Y.Doc()),
    comments: new Comments(new Y.Doc()),
    user: { id: 'demo-visitor', name: 'Visitor', color: USER_COLORS[0] },
    zoomToFit: () => undefined,
    selection: [],
    on: () => undefined,
    emit: () => undefined,
    setSelection: () => undefined,
    r: {
      size: () => ({ w: 1280, h: 800, left: 0, top: 0 }),
      contentBounds: () => bounds,
      setCamera: () => undefined,
      setOverlay: () => undefined,
      invalidateAll: () => undefined,
    },
  } as unknown as BoardApp;
}

export function demoFixture(): Fixture {
  const app = demoApp();
  seedDemo(app);
  return { name: 'demo:seed', writer: { id: 'demo-visitor', name: 'Visitor', color: USER_COLORS[0] }, changes: changesOf(app.store, app.comments) };
}

// ---------------------------------------------------------------- one object of every kind, as the client creates it

/** BoardApp.makeObj without the app: the defaults every new object gets (src/app.ts). */
function make(store: Store, type: ObjType, rect: { x: number; y: number; w: number; h: number }, extra: Partial<BaseObj> = {}): BaseObj {
  return {
    id: newId(), type, x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0, z: store.topZ(), createdBy: USER.id, updatedAt: Date.now(),
    font: 'satoshi', ...extra,
  };
}

export interface ClientObjects {
  store: Store;
  comments: Comments;
  /** Objects by a label that names what they are, for tests. */
  byLabel: Map<string, BaseObj | ConnectorObj>;
}

/** The ClientObjects of a real Store: every object type the client can create, every shape kind, relation and UML element. */
export function clientObjects(): ClientObjects {
  const store = new Store(new Y.Doc());
  const comments = new Comments(new Y.Doc());
  const byLabel = new Map<string, BaseObj | ConnectorObj>();
  const put = (label: string, o: BaseObj | ConnectorObj) => {
    store.transact(() => store.create(o as Obj));
    byLabel.set(label, o);
    return o;
  };
  const rect = { x: 10, y: 20, w: 192, h: 192 };

  const frame = put('frame', make(store, 'frame', { x: 0, y: 0, w: 960, h: 600 }, { name: 'Frame', fill: '#FFFFFF', font: 'cabinet-grotesk' })) as BaseObj;
  put('text', make(store, 'text', { x: 20, y: 20, w: 240, h: 28 }, { text: 'Heading', fontSize: 28, fontWeight: 700, textColor: '#112233', align: 'center', valign: 'middle', parent: frame.id }));
  put('sticky', make(store, 'sticky', rect, { text: 'Idea', fill: '#FFE16B', parent: frame.id }));
  // a Markdown block (src/markdown.ts): its source is the text field
  put('markdown', make(store, 'markdown', { x: 20, y: 60, w: 360, h: 200 }, { text: '# Plan\n\n- [ ] one\n- [x] two\n\n| a | b |\n| - | - |\n| 1 | 2 |', fontSize: 16, textColor: '#112233', parent: frame.id }));
  // a table (shared/tables.mjs): header flags, then rows, columns, a width and cells as keys of their own
  put('table', make(store, 'table', { x: 20, y: 280, w: 320, h: 80 }, { headerRow: true, fontSize: 15, parent: frame.id, ...tableFromGrid([['Name', 'Note'], ['Ann', '**bold** and `code`']], (() => { let i = 0; return () => `t${++i}`; })()), 'w:t1': 200 } as never));
  put('sticky:private', make(store, 'sticky', rect, { text: 'Hidden', fill: '#BCE88C', privateStep: 'step1' }));
  put('sticky:locked', make(store, 'sticky', rect, { text: 'Locked', fill: '#E2E6EB', locked: true, hidden: true, flipX: true, flipY: true }));
  for (const { kind } of SHAPE_KINDS) put(`shape:${kind}`, make(store, 'shape', { x: 0, y: 0, w: 160, h: 100 }, { kind, text: kind, fill: '#FFFFFF', stroke: '#112233', strokeWidth: 2, dash: 'dashed', opacity: 0.8 }));
  for (const def of UML_ELEMENTS) put(def.type + (def.label !== def.type ? `:${def.label}` : ''), make(store, def.type, { x: 0, y: 0, w: def.w, h: def.h }, { ...def.defaults }));
  put('icon', make(store, 'icon', { x: 0, y: 0, w: 64, h: 64 }, { ref: 'mdi:home', body: '<path d="M0 0h24v24H0z" fill="currentColor"/>', viewBox: [0, 0, 24, 24] }));
  put('sticker', make(store, 'icon', { x: 0, y: 0, w: 96, h: 96 }, { ref: 'fluent-emoji:smile', body: '<circle cx="12" cy="12" r="10"/>', viewBox: [0, 0, 24, 24], sticker: true }));
  // src/ui/image-add.ts
  put('image', make(store, 'image', { x: 0, y: 0, w: 320, h: 200 }, { asset: 'a'.repeat(64), mime: 'image/png', nw: 1280, nh: 800, alt: 'A diagram' }));
  put('image:pending', make(store, 'image', { x: 0, y: 0, w: 320, h: 200 }, { asset: 'pending:AbCdEfGh1', mime: 'image/webp', nw: 640, nh: 400 }));
  // BoardApp.penObj
  put('path', make(store, 'path', { x: 5, y: 5, w: 30, h: 12 }, { points: [0, 0, 10.5, 4.5, 30, 12], stroke: '#111827', strokeWidth: 3 }));
  // an empty group is removed by the store at once, so the group and a member are created in one transaction (src/app.ts groupSelection)
  const group = { id: newId(), type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: store.topZ(), createdBy: USER.id, updatedAt: Date.now(), name: 'Crew' } as BaseObj;
  const member = make(store, 'sticky', rect, { text: 'Member', fill: '#8FE3CA', parent: group.id });
  store.transact(() => {
    store.create(group as Obj);
    store.create(member as Obj);
  });
  byLabel.set('group', group);
  byLabel.set('sticky:grouped', member);
  // BoardApp.connectorFrom
  const a = byLabel.get('sticky')!;
  const b = byLabel.get('shape:rect')!;
  put('connector', {
    id: newId(), type: 'connector', z: store.topZ(), from: { kind: 'bound', id: a.id, anchor: 'auto' }, to: { kind: 'free', x: 400, y: 300 },
    route: 'elbow', startHead: 'none', endHead: 'arrow', dash: 'solid', stroke: 'var(--ink, #112233)', strokeWidth: 2, relation: undefined,
    createdBy: USER.id, updatedAt: Date.now(),
  } as ConnectorObj);
  for (const relation of Object.keys(RELATIONS) as (keyof typeof RELATIONS)[]) {
    const rel = RELATIONS[relation];
    put(`connector:${relation}`, {
      id: newId(), type: 'connector', z: store.topZ(), from: { kind: 'bound', id: a.id, anchor: 'right' }, to: { kind: 'bound', id: b.id, anchor: 'left' },
      route: 'straight', startHead: rel.startHead, endHead: rel.endHead, dash: rel.dash, stroke: '#112233', strokeWidth: 1.5, relation,
      label: rel.text ?? '', createdBy: USER.id, updatedAt: Date.now(),
    } as ConnectorObj);
  }

  // every font id the client writes: the Fontshare slugs of the offline list (src/font-policy.ts) and `system`
  for (const slug of [...BUILTIN_FONTS.map((f) => f.slug), 'system']) put(`font:${slug}`, make(store, 'text', { x: 0, y: 0, w: 200, h: 24 }, { text: slug, font: slug }));
  // link cards (docs/link-cards.md; the client is not merged yet, so these follow the object model table)
  const link = (label: string, extra: Record<string, unknown>) => put(label, {
    id: newId(), type: 'link', x: 0, y: 0, w: 320, h: 112, rotation: 0, z: store.topZ(), createdBy: USER.id, updatedAt: Date.now(), url: 'https://example.com/page', ...extra,
  } as unknown as BaseObj);
  link('link:pending', { unfurl: 'pending' });
  link('link:off', { unfurl: 'off' });
  link('link:ok', {
    unfurl: 'ok', title: 'A page', description: 'About it', siteName: 'example.com', image: 'a'.repeat(64), imageW: 1200, imageH: 630, icon: 'b'.repeat(64),
    finalUrl: 'https://www.example.com/page', fetchedAt: Date.now(), edited: ['title', 'description'],
  });
  for (const error of UNFURL_ERRORS) link(`link:failed:${error}`, { unfurl: 'failed', unfurlError: error });

  // kanban: containers.ts builds it
  const { container, lanes } = newKanban({ x: 0, y: 900 }, { z: store.topZ(), createdBy: USER.id, headingFont: 'cabinet-grotesk', bodyFont: 'satoshi' });
  store.transact(() => {
    store.create(container as Obj);
    lanes.forEach((l) => store.create(l as Obj));
  });
  byLabel.set('container', container);
  lanes.forEach((l, i) => byLabel.set(`lane:${i}`, l));
  const bug = createLabel(store, 'Bug', 'pink')!;
  const cardId = addCard(store, lanes[0].id, 'Write the report', { createdBy: USER.id, font: 'satoshi' })!;
  editCard(store, cardId, { desc: 'Details', owner: { id: 'u2', name: 'Marta Lund' }, due: '2026-01-16', labels: [bug], link: 'https://example.com/a?b=c', fill: 'blue' });
  const freeOwner = addCard(store, lanes[1].id, 'Free-text owner', { createdBy: USER.id, font: 'satoshi' })!;
  editCard(store, freeOwner, { owner: { name: 'Somebody Else' } });
  byLabel.set('card', store.get(cardId) as BaseObj);
  byLabel.set('card:free-owner', store.get(freeOwner) as BaseObj);
  // sticky to card in place (src/containers.ts stickyToCardFields)
  const conv = put('sticky:convert', make(store, 'sticky', rect, { text: 'Fix the login\nSteps to repeat', fill: '#A3D2FF' }));
  stickiesToCards(store, [conv.id], () => ({ lane: lanes[2].id, index: 0 }), USER.id);
  byLabel.set('card:converted', store.get(conv.id) as BaseObj);

  // src/tracker-frame.ts
  createTrackerFrame(store, { x: 2000, y: 0 });

  // comments (src/comments.ts)
  const author = { id: USER.id, name: USER.name, color: USER.color };
  const t = comments.addThread(author, { x: 10, y: 20, obj: a.id, fx: 0.5, fy: 0.25 }, 'Looks good')!;
  comments.reply(t, author, 'Thanks');
  comments.addThread(author, { x: 1, y: 2 }, 'A pin on empty canvas');
  comments.editThread(t, 'Looks good, edited');
  comments.setResolved(t, true, author);

  // session state (src/store.ts setFlow, src/flow.ts, src/polls.ts)
  const poll = checkPoll({ question: 'Which?', options: ['One', 'Two'], multiple: false, anonymous: false });
  const pollId = newId();
  const options = poll.options.map((text) => ({ id: newId(), text }));
  store.polls.set(pollId, {
    id: pollId, question: poll.question, options, multiple: false, anonymous: false, revealed: false, createdAt: Date.now(), createdBy: USER.id,
  });
  store.pollState.set(`${pollId}:openedAt`, Date.now());
  store.pollState.set(`${pollId}:revealed`, true);
  store.pollAnswers.set(`${pollId}:${USER.id}`, { pollId, userId: USER.id, optionIds: [options[0].id], updatedAt: Date.now(), name: USER.name, color: USER.color });
  store.setFlow({
    steps: [
      { id: 's1', title: 'Write', instructions: 'Add notes', mode: 'write', durationSec: 300 },
      { id: 's2', title: 'Private', instructions: 'Quietly', mode: 'private-write', frameId: frame.id },
      { id: 's3', title: 'Vote', instructions: 'Dots', mode: 'vote', votesPerPerson: 3, voteScope: 'selection', voteItems: [a.id], quick: true },
      { id: 's4', title: 'Poll', instructions: 'Ask', mode: 'poll', pollId },
      { id: 's5', title: 'Cluster', instructions: 'Group', mode: 'cluster' },
      { id: 's6', title: 'Discuss', instructions: 'Talk', mode: 'discuss' },
    ],
    active: 2,
    timer: { startedAt: Date.now(), durationMs: 300_000 },
    reveal: false,
    focus: { x: 1, y: 2, zoom: 1, ts: Date.now(), by: USER.id },
    stepStartedAt: Date.now(),
    results: 's3',
  });
  store.votes.set(`s3:${USER.id}:${newId()}`, { itemId: a.id, userId: USER.id, stepId: 's3' });
  store.setMeta({ name: 'A board', gridType: 'lines', gridSize: 32, snap: false, headingFont: 'cabinet-grotesk', bodyFont: 'satoshi', stickyColors: ['#112233'] });
  store.syncFeatures();
  return { store, comments, byLabel };
}

export function clientFixture(): Fixture {
  const { store, comments } = clientObjects();
  return { name: 'client:all-types', writer: USER, changes: changesOf(store, comments) };
}

// ---------------------------------------------------------------- other write paths

/** Custom-template insert (src/templates.ts insertCustomTemplate): builtinToCustom, then instantiate with fresh ids. */
export function customTemplateFixtures(): Fixture[] {
  return TEMPLATES.map((def) => {
    const content = builtinToCustom(def, USER.id).content;
    const { objects, steps } = instantiate(content, { x: 0, y: 0 }, USER.id);
    const store = new Store(new Y.Doc());
    let z = 0;
    store.transact(() => objects.forEach((o) => store.create({ ...o, z: `a${(z++).toString(36)}` } as Obj)));
    const changes = changesOf(store);
    if (steps.length) changes.push({ kind: 'flow', key: 'steps', value: steps, isNew: true });
    return { name: `custom-template:${def.id}`, writer: USER, changes };
  });
}

const MERMAID: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Do it]\n  B -->|no| D((End))',
  class: 'classDiagram\n  class Animal {\n    +String name\n    +eat() void\n  }\n  Animal <|-- Dog',
  state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy\n  Busy --> [*]',
  sequence: 'sequenceDiagram\n  actor Ann\n  participant Bob\n  Ann->>Bob: Hello\n  Bob-->>Ann: Hi',
};

/** Mermaid import (src/mermaid.ts layout) with the factory the app gives it (BoardApp.makeObj, BoardApp.connectorFrom). */
export function mermaidFixtures(): Fixture[] {
  return Object.entries(MERMAID).map(([name, source]) => {
    const store = new Store(new Y.Doc());
    const objs = layout(parseMermaid(source), { x: 0, y: 0 }, {
      box: (type, x, y, w, h, extra) => make(store, type, { x, y, w, h }, extra),
      connector: (from, to, extra) => ({
        id: newId(), type: 'connector', z: store.topZ(), from, to, route: 'elbow', startHead: 'none', endHead: 'arrow', createdBy: USER.id, updatedAt: Date.now(), ...extra,
      } as ConnectorObj),
    });
    let z = 0;
    store.transact(() => objs.forEach((o) => store.create({ ...o, z: `a${(z++).toString(36)}` } as Obj)));
    return { name: `mermaid:${name}`, writer: USER, changes: changesOf(store) };
  });
}

/** An AI-proposed sticky as src/ai-apply.ts writes it: createdBy is the person who asked, proposedBy names the run. */
export function aiFixture(): Fixture {
  const store = new Store(new Y.Doc());
  store.transact(() => store.create(make(store, 'sticky', { x: 0, y: 0, w: 192, h: 192 }, {
    text: 'Proposed', fill: '#FFE16B', proposedBy: { feature: 'cluster', by: { id: USER.id, name: USER.name } },
  }) as Obj));
  return { name: 'ai:proposed-sticky', writer: USER, changes: changesOf(store) };
}

/**
 * Somebody deletes another person's sticky and then undoes it: the key comes back with its original createdBy, which is
 * not the writer's. With the default policy that is a `forged_author`; the `member` policy accepts it.
 */
export function undoRestoreFixtures(): Fixture[] {
  const store = new Store(new Y.Doc());
  const theirs = make(store, 'sticky', { x: 0, y: 0, w: 192, h: 192 }, { text: 'Theirs', fill: '#FFE16B', createdBy: 'u2' });
  store.transact(() => store.create(theirs as Obj));
  store.undo.stopCapturing();
  store.transact(() => store.objects.delete(theirs.id));
  store.undo.stopCapturing();
  store.undo.undo();
  const restored = store.objects.get(theirs.id)?.toJSON();
  const changes: Change[] = restored ? [{ kind: 'object', key: theirs.id, value: restored, isNew: true }] : [];
  return [
    { name: 'scenario:undo-restore (default policy)', writer: USER, changes },
    { name: 'scenario:undo-restore (createdByPolicy=member)', writer: USER, changes, ctx: { createdByPolicy: 'member' } },
  ];
}

export function allFixtures(): Fixture[] {
  return [clientFixture(), demoFixture(),  aiFixture(), ...undoRestoreFixtures(), ...mermaidFixtures(), ...templateFixtures(), ...customTemplateFixtures()];
}
