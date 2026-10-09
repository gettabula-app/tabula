import { generateNKeysBetween } from 'fractional-indexing';
import { layoutContainer } from '../../shared/containers';
import { anchorFor, type Author } from '../comments';
import { cardContentHeight } from '../markup';
import { USER_COLORS } from '../palette';
import { Builder } from '../templates';
import type { BoardApp } from '../app';
import type { BaseObj, ConnectorObj, Obj, Step } from '../types';

const SEEDED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);

// These are the ids consumed by Builder.kanban and then Comments.addThread/reply. Keeping the
// platform helpers in use means the demo data follows the same model as boards made by hand.
const GENERATED_IDS = [
  'demo-k001', 'demo-l001', 'demo-c001', 'demo-c002', 'demo-l002', 'demo-c003', 'demo-c004',
  'demo-l003', 'demo-c005', 'demo-c006', 'demo-t001', 'demo-r001', 'demo-t002', 'demo-r002', 'demo-t003',
];
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_';

function withFixedSeedEntropy<T>(run: () => T): T {
  const originalNow = Date.now;
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalCrypto = globalThis.crypto;
  let next = 0;
  const deterministicCrypto = new Proxy(originalCrypto, {
    get(target, key) {
      if (key === 'getRandomValues') {
        return <T extends ArrayBufferView>(array: T): T => {
          const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          const fallback = `demo-x${String(next - GENERATED_IDS.length + 1).padStart(3, '0')}`;
          const id = GENERATED_IDS[next] ?? fallback;
          next++;
          for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, ID_CHARS.indexOf(id[i % id.length]));
          return array;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Crypto;

  let patchedCrypto = false;
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: deterministicCrypto });
    patchedCrypto = true;
    Date.now = () => SEEDED_AT;
    return run();
  } finally {
    Date.now = originalNow;
    if (patchedCrypto) {
      if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  }
}

function base(
  id: string, type: BaseObj['type'], x: number, y: number, w: number, h: number,
  createdBy: string, extra: Partial<BaseObj> = {},
): BaseObj {
  return { id, type, x, y, w, h, rotation: 0, z: '', createdBy, updatedAt: SEEDED_AT, ...extra };
}

function frame(id: string, name: string, x: number, y: number, w: number, h: number, createdBy: string, fill: string): BaseObj {
  return base(id, 'frame', x, y, w, h, createdBy, { name, fill, font: 'cabinet-grotesk' });
}

function sticky(id: string, text: string, x: number, y: number, fill: string, parent: string, createdBy: string): BaseObj {
  return base(id, 'sticky', x, y, 150, 130, createdBy, {
    text, fill, parent, fontSize: 18, fontWeight: 500, textColor: '#1D1A12', align: 'center', valign: 'middle',
  });
}

function connector(
  id: string, from: string, to: string, route: ConnectorObj['route'], createdBy: string,
  extra: Partial<ConnectorObj> = {}, parent?: string,
): ConnectorObj {
  return {
    id, type: 'connector', z: '', from: { kind: 'bound', id: from, anchor: 'auto' },
    to: { kind: 'bound', id: to, anchor: 'auto' }, route, startHead: 'none', endHead: 'arrow',
    stroke: '#5B6672', strokeWidth: 2, createdBy, updatedAt: SEEDED_AT, parent, ...extra,
  };
}

const ICONS = [
  {
    id: 'demo-icon-sparkles', ref: 'lucide:sparkles', color: '#7A5AF8',
    body: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4m2-2h-4"/><circle cx="4" cy="20" r="2"/></g>',
  },
  {
    id: 'demo-icon-lightbulb', ref: 'lucide:lightbulb', color: '#C98A00',
    body: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 14c.2-1 .7-1.7 1.5-2.5c1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5c.7.7 1.3 1.5 1.5 2.5m0 4h6m-5 4h4"/>',
  },
  {
    id: 'demo-icon-heart', ref: 'lucide:heart', color: '#D3332D',
    body: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
  },
  {
    id: 'demo-icon-message', ref: 'lucide:message-circle', color: '#326DD3',
    body: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092a10 10 0 1 0-4.777-4.719"/>',
  },
  {
    id: 'demo-icon-rocket', ref: 'lucide:rocket', color: '#1B8151',
    body: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/></g>',
  },
] as const;

const STICKERS = [
  {
    id: 'demo-sticker-heart', ref: 'fluent-emoji-flat:heart-suit',
    body: '<path fill="#f8312f" d="M21.008 5.162c-2.84.509-5.011 3.905-5.011 3.905s-2.18-3.396-5.012-3.905c-7.012-1.25-9.903 4.993-8.732 9.64c1.73 6.863 10.053 13.014 12.834 14.916c.55.376 1.27.376 1.83 0c2.791-1.902 11.113-8.053 12.834-14.916c1.16-4.647-1.73-10.89-8.743-9.64"/>',
  },
  {
    id: 'demo-sticker-star', ref: 'fluent-emoji-flat:star',
    body: '<path fill="#fcd53f" d="m18.7 4.627l2.247 4.31a2.27 2.27 0 0 0 1.686 1.189l4.746.65c2.538.35 3.522 3.479 1.645 5.219l-3.25 2.999a2.23 2.23 0 0 0-.683 2.04l.793 4.398c.441 2.45-2.108 4.36-4.345 3.24l-4.536-2.25a2.28 2.28 0 0 0-2.006 0l-4.536 2.25c-2.238 1.11-4.786-.79-4.345-3.24l.793-4.399c.14-.75-.12-1.52-.682-2.04l-3.251-2.998c-1.877-1.73-.893-4.87 1.645-5.22l4.746-.65a2.23 2.23 0 0 0 1.686-1.189l2.248-4.309c1.144-2.17 4.264-2.17 5.398 0"/>',
  },
] as const;

function makeObjects(app: BoardApp): { objects: Obj[]; labels: { id: string; name: string; color: string; order: number }[] } {
  const me = app.user.id;
  const objects: Obj[] = [];
  const wellId = 'demo-well-frame';
  const improveId = 'demo-improve-frame';
  const flowId = 'demo-flow-frame';
  const toolkitId = 'demo-toolkit-frame';
  const wellIds = ['demo-well-1', 'demo-well-2', 'demo-well-3', 'demo-well-4', 'demo-well-5'];

  objects.push(
    base('demo-title', 'text', 40, 25, 1030, 55, me, {
      text: 'A board to play with', font: 'cabinet-grotesk', fontSize: 40, fontWeight: 700,
      textColor: '#18212B', align: 'left', valign: 'middle',
    }),
    base('demo-instructions', 'text', 40, 96, 1080, 38, me, {
      text: 'Try it: click, drag, double-click, Cmd/Ctrl+G to group, place a dot, then Esc.',
      fontSize: 17, fontWeight: 400, textColor: '#5B6672', align: 'left', valign: 'middle',
    }),
    frame(wellId, 'What went well', 40, 190, 530, 430, me, '#FFF8D7'),
    frame(improveId, 'To improve', 620, 190, 530, 430, me, '#F6F1FF'),
    frame(flowId, 'A tiny flow', 40, 660, 1110, 290, me, '#F5F8FC'),
    frame(toolkitId, 'More to try', 40, 990, 400, 650, me, '#F7F8FA'),
  );

  const wellNotes = [
    ['People jumped in early', '#FFE16B', 65, 270],
    ['A clear first click', '#FFA3C4', 245, 270],
    ['The canvas feels calm', '#A3D2FF', 410, 270],
    ['Good keyboard shortcuts', '#FFE16B', 155, 430],
    ['We can share a laugh', '#FFA3C4', 410, 430],
  ] as const;
  wellNotes.forEach(([text, fill, x, y], i) => objects.push(sticky(wellIds[i], text, x, y, fill, wellId, me)));

  const improvements = [
    ['Name the next action', '#CDB8FF', 650, 275],
    ['Add a keyboard hint', '#FFE16B', 890, 275],
    ['Tighten the toolbar', '#FFA3C4', 650, 445],
    ['Show one sample board', '#BCE88C', 890, 445],
  ] as const;
  improvements.forEach(([text, fill, x, y], i) => objects.push(sticky(`demo-improve-${i + 1}`, text, x, y, fill, improveId, me)));

  const flowShapes = [
    base('demo-flow-start', 'shape', 75, 770, 145, 84, me, { parent: flowId, kind: 'rect', text: 'Start here', fill: '#DDF5E8', fontSize: 17, align: 'center' }),
    base('demo-flow-decision', 'shape', 335, 758, 150, 108, me, { parent: flowId, kind: 'diamond', text: 'Pick a note', fill: '#FFF2C2', fontSize: 17, align: 'center' }),
    base('demo-flow-feedback', 'shape', 605, 770, 145, 84, me, { parent: flowId, kind: 'ellipse', text: 'Add a dot', fill: '#DCEBFF', fontSize: 17, align: 'center' }),
    base('demo-flow-done', 'shape', 865, 770, 170, 84, me, { parent: flowId, kind: 'rounded', text: 'See what wins', fill: '#FFE2D6', fontSize: 17, align: 'center' }),
  ];
  objects.push(...flowShapes);
  objects.push(
    connector('demo-flow-link-1', 'demo-flow-start', 'demo-flow-decision', 'straight', me, {}, flowId),
    connector('demo-flow-link-2', 'demo-flow-decision', 'demo-flow-feedback', 'elbow', me, { label: 'yes' }, flowId),
    connector('demo-flow-link-3', 'demo-flow-feedback', 'demo-flow-done', 'straight', me, {}, flowId),
    connector('demo-sticky-to-frame', wellIds[4], improveId, 'elbow', me, { label: 'share an idea' }, wellId),
  );

  ICONS.forEach((icon, i) => {
    const positions = [[70, 1070], [170, 1070], [270, 1070], [70, 1155], [170, 1155]] as const;
    const [x, y] = positions[i];
    objects.push(base(icon.id, 'icon', x, y, 56, 56, me, {
      parent: toolkitId, ref: icon.ref, body: icon.body, viewBox: [0, 0, 24, 24],
      stroke: icon.color, textColor: icon.color,
    }));
  });
  STICKERS.forEach((icon, i) => {
    const x = i === 0 ? 270 : 70;
    const y = i === 0 ? 1155 : 1240;
    objects.push(base(icon.id, 'icon', x, y, 64, 64, me, {
      parent: toolkitId, ref: icon.ref, body: icon.body, viewBox: [0, 0, 32, 32], sticker: true,
    }));
  });
  objects.push(base('demo-font-example', 'text', 70, 1335, 330, 48, me, {
    parent: toolkitId, text: 'A bigger headline', font: 'cabinet-grotesk', fontSize: 28, fontWeight: 700,
    textColor: '#18212B', align: 'left', valign: 'middle',
  }));

  const groupId = 'demo-crew';
  objects.push(base(groupId, 'group', 0, 0, 0, 0, me, { name: 'Workshop crew', parent: toolkitId }));
  [
    ['demo-crew-marta', 'Marta', USER_COLORS[0], 65],
    ['demo-crew-jonas', 'Jonas', USER_COLORS[1], 175],
    ['demo-crew-you', 'You', USER_COLORS[2], 285],
  ].forEach(([id, name, fill, x]) => objects.push(base(id as string, 'shape', x as number, 1510, 100, 66, me, {
    parent: groupId, kind: 'ellipse', text: name as string, fill: fill as string, textColor: '#FFFFFF',
    fontSize: 14, fontWeight: 600, align: 'center', valign: 'middle',
  })));

  const builder = new Builder({ user: app.user, store: app.store }, 470, 990);
  const containerId = builder.kanban('How we will improve', 0, 0, [
    { name: 'To do', stage: 'todo', cards: [
      { title: 'Sketch the next screen', labels: ['Feature'] },
      { title: 'Pick a color palette', labels: ['Chore'] },
    ] },
    { name: 'Doing', stage: 'doing', cards: [
      { title: 'Wire up the demo board', desc: 'Keep the first visit quick to explore.', labels: ['Feature'] },
      { title: 'Check keyboard shortcuts', labels: ['Chore'] },
    ] },
    { name: 'Done', stage: 'done', cards: [
      { title: 'Seed a starter board', labels: ['Feature'] },
      { title: 'Keep changes in memory', labels: ['Chore'] },
    ] },
  ], { Feature: 'blue', Chore: 'grey' });
  const container = builder.objs.find((o) => o.id === containerId && o.type === 'container') as BaseObj;
  const lanes = builder.objs.filter((o): o is BaseObj => o.type === 'lane');
  const cards = builder.objs.filter((o): o is BaseObj => o.type === 'card');
  const ownerCard = cards.find((card) => card.text === 'Wire up the demo board')!;
  Object.assign(ownerCard, { ownerId: 'demo-marta', ownerName: 'Marta', due: '2026-10-16' });
  ownerCard.h = cardContentHeight(ownerCard, ownerCard.w);
  const layout = layoutContainer(container, lanes, cards)!;
  container.w = layout.w;
  container.h = layout.h;
  for (const o of [...lanes, ...cards]) Object.assign(o, layout.rects.get(o.id));
  objects.push(...builder.objs);

  const labels = builder.labels.map((label, order) => ({
    id: label.name === 'Feature' ? 'demo-label-feature' : 'demo-label-chore',
    name: label.name,
    color: label.color,
    order,
  }));
  const labelIds = new Map(builder.labels.map((label) => [label.id, label.name === 'Feature' ? 'demo-label-feature' : 'demo-label-chore']));
  for (const card of cards) if (card.labels) card.labels = card.labels.map((id) => labelIds.get(id)!).filter(Boolean);

  const zs = generateNKeysBetween(null, null, objects.length);
  objects.forEach((o, i) => { o.z = zs[i]; });
  return { objects, labels };
}

function createComments(app: BoardApp) {
  const authorMarta: Author = { id: 'demo-marta', name: 'Marta', color: USER_COLORS[0] };
  const authorJonas: Author = { id: 'demo-jonas', name: 'Jonas', color: USER_COLORS[1] };
  const anchor = (id: string) => {
    const obj = app.store.get(id);
    if (!obj || obj.type === 'connector') throw new Error(`Missing demo comment anchor: ${id}`);
    const rect = app.store.geometry(obj);
    return anchorFor({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, { ...obj, ...rect } as BaseObj);
  };
  const first = app.comments.addThread(authorMarta, anchor('demo-well-1'), 'I like that the first action is obvious.');
  if (!first) throw new Error('Could not add demo comments.');
  app.comments.reply(first, authorJonas, 'Same — it feels easy to scan.');
  const second = app.comments.addThread(authorJonas, anchor('demo-flow-decision'), 'Could this card show one keyboard tip?');
  if (!second) throw new Error('Could not add demo comments.');
  app.comments.reply(second, authorMarta, 'Good call.');
  const third = app.comments.addThread(authorMarta, anchor('demo-well-4'), 'Try a dot on a sticky, then add your own.');
  if (!third) throw new Error('Could not add demo comments.');
}

function seed(app: BoardApp) {
  const { objects, labels } = makeObjects(app);
  const voteId = 'demo-vote-step';
  const pollId = 'demo-next-poll';
  const pollStepId = 'demo-poll-step';
  const pollOptions = [
    { id: 'demo-poll-option-groups', text: 'Groups and connectors' },
    { id: 'demo-poll-option-planning', text: 'Templates and kanban' },
    { id: 'demo-poll-option-facilitation', text: 'Polls and facilitation' },
  ];
  const voteStep: Step = {
    id: voteId, title: 'Dot vote', instructions: 'Use your three dots on the notes you want to build on.',
    mode: 'vote', frameId: 'demo-well-frame', votesPerPerson: 3, voteScope: 'selection',
    voteItems: ['demo-well-1', 'demo-well-2', 'demo-well-3', 'demo-well-4', 'demo-well-5'],
  };
  const pollStep: Step = {
    id: pollStepId, title: 'Which feature should we show next?', instructions: 'Choose one option.',
    mode: 'poll', pollId,
  };

  app.store.undo.stopCapturing();
  app.store.transact(() => {
    app.store.meta.set('name', 'Try Tabula');
    app.store.meta.set('demoSeeded', true);
    labels.forEach((label) => app.store.labels.set(label.id, label));
    objects.forEach((o) => app.store.create(o));

    app.store.flow.set('steps', [voteStep, pollStep]);
    app.store.flow.set('active', 0);
    app.store.flow.set('timer', null);
    app.store.flow.set('reveal', false);
    app.store.flow.set('focus', null);
    app.store.flow.set('stepStartedAt', SEEDED_AT);
    app.store.flow.set('results', null);

    app.store.votes.set(`${voteId}:demo-marta:demo-dot-1`, { itemId: 'demo-well-1', userId: 'demo-marta', stepId: voteId });
    app.store.votes.set(`${voteId}:demo-jonas:demo-dot-1`, { itemId: 'demo-well-3', userId: 'demo-jonas', stepId: voteId });

    app.store.polls.set(pollId, {
      id: pollId, question: 'Which feature should we show next?', options: pollOptions,
      multiple: false, anonymous: false, revealed: false, createdAt: SEEDED_AT, createdBy: 'demo-marta',
    });
    app.store.pollAnswers.set(`${pollId}:demo-marta`, {
      pollId, userId: 'demo-marta', optionIds: [pollOptions[0].id], updatedAt: SEEDED_AT, name: 'Marta', color: USER_COLORS[0],
    });
    app.store.pollAnswers.set(`${pollId}:demo-jonas`, {
      pollId, userId: 'demo-jonas', optionIds: [pollOptions[2].id], updatedAt: SEEDED_AT, name: 'Jonas', color: USER_COLORS[1],
    });
  });
  app.store.undo.stopCapturing();
  app.store.undo.clear();

  createComments(app);
  // The first paint may run before the SVG has a measured viewport. Fit on the next frame.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => app.zoomToFit());
  else app.zoomToFit();
}

/** Seeds a fresh in-memory demo board. Existing boards are left alone. */
export function seedDemo(app: BoardApp): void {
  if (app.store.meta.get('demoSeeded') === true || app.store.cache.size > 0) return;
  withFixedSeedEntropy(() => seed(app));
}
