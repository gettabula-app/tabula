import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj, ShapeKind, Step, StepMode } from './types';
import { newId } from './store';
import { STICKY_COLORS } from './palette';
import { instantiate, type CustomTemplate, type TemplateLabel } from './custom-templates';
import { KANBAN, layoutContainer, ranksBetween } from '../shared/containers';
import { cardContentHeight } from './markup';
import { mergeTemplateLabels } from './labels';

export interface TemplateDef {
  id: string;
  name: string;
  category: 'Retrospective' | 'Ideation' | 'Discussion' | 'Prioritisation' | 'Planning' | 'Discovery' | 'Strategy' | 'Risk';
  description: string;
  build: (b: Builder) => void;
}

/** A lane of a template kanban, with its cards (titles, an optional description and label names). */
export interface TemplateLane {
  name: string;
  stage?: 'todo' | 'doing' | 'done';
  wip?: number;
  wipMode?: 'warn' | 'block';
  fill?: string;
  cards?: { title: string; desc?: string; labels?: string[]; fill?: string }[];
}

const TINT = {
  mint: '#E6F7EF', sky: '#E4EFFF', butter: '#FFF6D6', peach: '#FFE9E0', lilac: '#F0EAFF', mist: '#F3F5F7', rose: '#FFE8F0',
};
/** The colours of the template labels (docs/kanban.md, Templates: Bug, Feature, Chore). */
const LABEL_COLORS: Record<string, string> = { Bug: 'pink', Feature: 'blue', Chore: 'grey' };
const ST = Object.fromEntries(STICKY_COLORS.map((c) => [c.name.toLowerCase(), c.fill])) as Record<string, string>;

/** What a Builder reads from the board: the local user and the board fonts. */
export interface BuilderHost {
  user: { id: string };
  store: { getMeta(): Pick<BoardMeta, 'bodyFont' | 'headingFont'> };
}

/** Collects objects and steps for a template, positioned from an origin. */
export class Builder {
  objs: Obj[] = [];
  steps: Step[] = [];
  /** The labels its cards use, merged by name into the board's when it is placed (docs/kanban.md, Templates). */
  labels: TemplateLabel[] = [];
  constructor(private app: BuilderHost, readonly ox: number, readonly oy: number) {}

  private base(type: BaseObj['type'], x: number, y: number, w: number, h: number, extra: Partial<BaseObj>): BaseObj {
    const o: BaseObj = {
      id: newId(), type, x: this.ox + x, y: this.oy + y, w, h, rotation: 0, z: '',
      createdBy: this.app.user.id, updatedAt: Date.now(), font: this.app.store.getMeta().bodyFont, ...extra,
    };
    this.objs.push(o);
    return o;
  }

  frame(name: string, x: number, y: number, w: number, h: number, fill = '#FFFFFF', parent?: Id): Id {
    return this.base('frame', x, y, w, h, { name, fill, font: this.app.store.getMeta().headingFont, parent }).id;
  }

  text(text: string, x: number, y: number, w: number, size = 16, weight = 400, parent?: Id, color?: string): Id {
    const lines = Math.max(1, Math.ceil((text.length * size * 0.52) / w) + (text.match(/\n/g)?.length ?? 0));
    return this.base('text', x, y, w, lines * size * 1.3, {
      text, fontSize: size, fontWeight: weight, parent, textColor: color,
      font: size >= 28 ? this.app.store.getMeta().headingFont : this.app.store.getMeta().bodyFont,
    }).id;
  }

  sticky(text: string, x: number, y: number, fill = ST.yellow, parent?: Id, size = 160): Id {
    return this.base('sticky', x, y, size, size, { text, fill, parent, fontSize: 18 }).id;
  }

  shape(kind: ShapeKind, text: string, x: number, y: number, w: number, h: number, fill = '#FFFFFF', parent?: Id, extra: Partial<BaseObj> = {}): Id {
    return this.base('shape', x, y, w, h, { kind, text, fill, parent, ...extra }).id;
  }

  /** A template label by name (a palette key colour), made once. Returns its template id. */
  label(name: string, color: string): string {
    const have = this.labels.find((l) => l.name === name);
    if (have) return have.id;
    const id = `l${this.labels.length + 1}`;
    this.labels.push({ id, name, color });
    return id;
  }

  /**
   * A kanban with its lanes and cards (docs/kanban.md, Templates), laid out as the board lays it out: each card's height
   * is stored from its content, as the app stores it, and the stored rectangles are the layout's. Returns its id.
   */
  kanban(name: string, x: number, y: number, lanes: TemplateLane[], labelColors: Record<string, string> = {}): Id {
    const meta = this.app.store.getMeta();
    const now = Date.now();
    const container: BaseObj = {
      id: newId(), type: 'container', layout: 'kanban', name, x: this.ox + x, y: this.oy + y, w: 0, h: 0, rotation: 0, z: '',
      createdBy: this.app.user.id, updatedAt: now, font: meta.headingFont,
    };
    const laneRanks = ranksBetween(null, null, lanes.length, container.id);
    const laneObjs: BaseObj[] = [];
    const cards: BaseObj[] = [];
    const w = KANBAN.laneW - KANBAN.lanePad * 2;
    lanes.forEach((l, i) => {
      const lane: BaseObj = {
        id: newId(), type: 'lane', parent: container.id, rank: laneRanks[i], name: l.name, x: 0, y: 0, w: 0, h: 0, rotation: 0, z: '',
        createdBy: this.app.user.id, updatedAt: now, font: meta.bodyFont,
      };
      if (l.stage) lane.stage = l.stage;
      if (l.wip) lane.wip = l.wip;
      if (l.wip && l.wipMode === 'block') lane.wipMode = 'block';
      if (l.fill) lane.fill = l.fill;
      laneObjs.push(lane);
      const ranks = ranksBetween(null, null, l.cards?.length ?? 0, lane.id);
      (l.cards ?? []).forEach((c, j) => {
        const card: BaseObj = {
          id: newId(), type: 'card', parent: lane.id, rank: ranks[j], text: c.title, x: 0, y: 0, w, h: 0, rotation: 0, z: '',
          createdBy: this.app.user.id, updatedAt: now, font: meta.bodyFont,
        };
        if (c.desc) card.desc = c.desc;
        if (c.fill) card.fill = c.fill;
        if (c.labels?.length) card.labels = c.labels.map((n) => this.label(n, labelColors[n] ?? 'grey'));
        card.h = cardContentHeight(card, w);
        cards.push(card);
      });
    });
    const layout = layoutContainer(container, laneObjs, cards)!;
    container.w = layout.w;
    container.h = layout.h;
    for (const o of [...laneObjs, ...cards]) Object.assign(o, layout.rects.get(o.id));
    this.objs.push(container, ...laneObjs, ...cards);
    return container.id;
  }

  step(title: string, instructions: string, mode: StepMode, minutes?: number, frameId?: Id, votesPerPerson?: number) {
    this.steps.push({ id: newId(), title, instructions, mode, durationSec: minutes ? minutes * 60 : undefined, frameId, votesPerPerson });
  }

  /** Title + subtitle above the template. */
  header(title: string, subtitle: string, w: number) {
    this.text(title, 0, -150, w, 40, 700);
    this.text(subtitle, 0, -88, Math.min(w, 760), 17, 400, undefined, '#5B6672');
  }

  /** Equal columns inside an outer frame. Returns column frame ids. */
  columns(outer: Id, names: { name: string; hint: string; fill: string }[], x: number, y: number, colW: number, colH: number, gap = 32): Id[] {
    return names.map((c, i) => {
      const cx = x + i * (colW + gap);
      const id = this.frame(c.name, cx, y, colW, colH, c.fill, outer);
      this.text(c.hint, cx + 24, y + 24, colW - 48, 15, 400, id, '#5B6672');
      return id;
    });
  }
}

const RETRO_STEPS = (b: Builder, outer: Id, actions: Id) => {
  b.step('Silent writing', 'Add one note per thought in each column. Notes stay hidden from others until the reveal.', 'private-write', 7, outer);
  b.step('Reveal and read', 'Reveal all notes. Each person reads theirs aloud in under a minute.', 'discuss', 8, outer);
  b.step('Group similar notes', 'Drag notes about the same thing next to each other. Name each group with a text label.', 'cluster', 5, outer);
  b.step('Dot vote', 'Click the notes or groups you most want to act on. You have 3 votes; shift-click removes one.', 'vote', 3, outer, 3);
  b.step('Agree actions', 'For the top-voted items, write one action each with an owner and a date.', 'write', 10, actions);
};

function retroLayout(b: Builder, title: string, subtitle: string, cols: { name: string; hint: string; fill: string }[], colW = 380) {
  const gap = 32;
  const w = cols.length * colW + (cols.length - 1) * gap + 64;
  b.header(title, subtitle, w);
  const outer = b.frame(title, 0, 0, w, 720, TINT.mist);
  b.columns(outer, cols, 32, 32, colW, 656, gap);
  const actions = b.frame('Actions', w + 80, 0, 480, 720, TINT.lilac);
  b.text('One action per note: what, who, by when.', w + 104, 24, 432, 15, 400, actions, '#5B6672');
  RETRO_STEPS(b, outer, actions);
}

function grid2x2(b: Builder, title: string, subtitle: string, cells: { name: string; hint: string; fill: string }[], cell = 520) {
  const gap = 24;
  const w = cell * 2 + gap + 64;
  b.header(title, subtitle, w);
  const outer = b.frame(title, 0, 0, w, cell * 2 + gap + 64, TINT.mist);
  cells.forEach((c, i) => {
    const x = 32 + (i % 2) * (cell + gap), y = 32 + Math.floor(i / 2) * (cell + gap);
    const id = b.frame(c.name, x, y, cell, cell, c.fill, outer);
    b.text(c.hint, x + 24, y + 24, cell - 48, 15, 400, id, '#5B6672');
  });
  return outer;
}


/** One block of a canvas: a frame at a grid position (in units of `u` wide and `v` high) with a hint at the top. */
interface CanvasBlock { name: string; hint: string; fill: string; c: number; r: number; cs?: number; rs?: number }

/** Lay blocks out on a grid inside an outer frame; returns the block frame ids by name. */
function canvasBlocks(b: Builder, outer: Id, blocks: CanvasBlock[], u: number, v: number, gap = 16, pad = 24): Record<string, Id> {
  const ids: Record<string, Id> = {};
  for (const k of blocks) {
    const x = pad + k.c * (u + gap), y = pad + k.r * (v + gap);
    const w = (k.cs ?? 1) * u + ((k.cs ?? 1) - 1) * gap, h = (k.rs ?? 1) * v + ((k.rs ?? 1) - 1) * gap;
    const id = b.frame(k.name, x, y, w, h, k.fill, outer);
    b.text(k.hint, x + 20, y + 20, w - 40, 15, 400, id, '#5B6672');
    ids[k.name] = id;
  }
  return ids;
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'start-stop-continue', name: 'Start / Stop / Continue', category: 'Retrospective',
    description: 'Decide what the team should begin, drop and keep doing.',
    build: (b) => retroLayout(b, 'Start / Stop / Continue', 'Sprint retrospective, about 40 minutes', [
      { name: 'Start', hint: 'What should we begin doing?', fill: TINT.mint },
      { name: 'Stop', hint: 'What is slowing us down that we should drop?', fill: TINT.peach },
      { name: 'Continue', hint: 'What is working that we should keep?', fill: TINT.sky },
    ]),
  },
  {
    id: '4ls', name: '4Ls', category: 'Retrospective',
    description: 'Liked, Learned, Lacked, Longed for — a balanced look back.',
    build: (b) => retroLayout(b, '4Ls retrospective', 'Liked, learned, lacked, longed for, about 45 minutes', [
      { name: 'Liked', hint: 'What did you enjoy?', fill: TINT.mint },
      { name: 'Learned', hint: 'What did you learn?', fill: TINT.sky },
      { name: 'Lacked', hint: 'What was missing?', fill: TINT.peach },
      { name: 'Longed for', hint: 'What do you wish we had?', fill: TINT.lilac },
    ], 320),
  },
  {
    id: 'mad-sad-glad', name: 'Mad / Sad / Glad', category: 'Retrospective',
    description: 'Surface how the sprint felt before deciding what to change.',
    build: (b) => retroLayout(b, 'Mad / Sad / Glad', 'Feelings-first retrospective, about 40 minutes', [
      { name: 'Mad', hint: 'What frustrated you?', fill: TINT.peach },
      { name: 'Sad', hint: 'What disappointed you?', fill: TINT.sky },
      { name: 'Glad', hint: 'What made you happy?', fill: TINT.mint },
    ]),
  },
  {
    id: 'sailboat', name: 'Sailboat', category: 'Retrospective',
    description: 'What pushes us forward, holds us back, and what risks lie ahead.',
    build: (b) => {
      const w = 1400;
      b.header('Sailboat retrospective', 'Wind, anchors, rocks and the island we are sailing to, about 45 minutes', w);
      const outer = b.frame('Sailboat', 0, 0, w, 820, TINT.sky);
      const island = b.frame('Island: our goal', 980, 40, 380, 300, TINT.mint, outer);
      b.text('Where are we heading?', 1004, 64, 330, 15, 400, island, '#5B6672');
      const wind = b.frame('Wind: what helps', 40, 40, 520, 300, '#FFFFFF', outer);
      b.text('What is pushing us forward?', 64, 64, 470, 15, 400, wind, '#5B6672');
      const anchors = b.frame('Anchors: what holds us back', 40, 400, 520, 380, TINT.peach, outer);
      b.text('What is slowing us down?', 64, 424, 470, 15, 400, anchors, '#5B6672');
      const rocks = b.frame('Rocks: risks ahead', 980, 400, 380, 380, TINT.butter, outer);
      b.text('What could sink us?', 1004, 424, 330, 15, 400, rocks, '#5B6672');
      b.shape('trapezoid', '', 620, 520, 300, 90, '#FFFFFF', outer, { rotation: Math.PI });
      b.shape('triangle', 'Team', 700, 330, 150, 180, '#FFFFFF', outer, { fontSize: 18, fontWeight: 600 });
      const actions = b.frame('Actions', w + 80, 0, 480, 820, TINT.lilac);
      RETRO_STEPS(b, outer, actions);
    },
  },
  {
    id: 'crazy-8s', name: 'Crazy 8s', category: 'Ideation',
    description: 'Eight fast sketches in eight minutes, then share and vote.',
    build: (b) => {
      const cell = 300, gap = 20, w = cell * 4 + gap * 3 + 64;
      b.header('Crazy 8s', 'Fold your thinking into 8 sketches, one minute each, about 25 minutes', w);
      const outer = b.frame('Crazy 8s', 0, 0, w, cell * 2 + gap + 64, TINT.mist);
      for (let i = 0; i < 8; i++) {
        const x = 32 + (i % 4) * (cell + gap), y = 32 + Math.floor(i / 4) * (cell + gap);
        b.frame(`Idea ${i + 1}`, x, y, cell, cell, '#FFFFFF', outer);
      }
      b.step('Frame the problem', 'Read the problem statement together. Agree on what a good idea must do.', 'discuss', 3, outer);
      b.step('Sketch 8 ideas', 'One idea per panel, one minute each. Use the pen or notes. Rough is fine.', 'write', 8, outer);
      b.step('Share', 'Each person walks through their panels in 2 minutes.', 'discuss', 10, outer);
      b.step('Vote', 'Click the ideas worth prototyping. 3 votes each.', 'vote', 3, outer, 3);
    },
  },
  {
    id: 'affinity', name: 'Brainstorm + affinity map', category: 'Ideation',
    description: 'Generate ideas silently, cluster them into themes, vote on themes.',
    build: (b) => {
      const w = 1500;
      b.header('Brainstorm', 'Write ideas, then group them into themes, about 35 minutes', w);
      const prompt = b.shape('rounded', 'How might we …?', 0, 0, w, 120, TINT.butter, undefined, { fontSize: 28, fontWeight: 700, stroke: 'none' });
      void prompt;
      const ideas = b.frame('Ideas', 0, 180, 700, 760, '#FFFFFF');
      b.text('Drop every idea here, one per note.', 24, 204, 640, 15, 400, ideas, '#5B6672');
      const groups = b.frame('Themes', 780, 180, 720, 760, TINT.mist);
      b.text('Move notes here into groups and name each group.', 804, 204, 660, 15, 400, groups, '#5B6672');
      b.step('Silent brainstorm', 'Write as many ideas as you can, one per note. Quantity over quality.', 'private-write', 8, ideas);
      b.step('Reveal', 'Reveal the ideas and read them quietly.', 'discuss', 4, ideas);
      b.step('Cluster', 'Move notes into the Themes frame. Put similar ideas together and name each group.', 'cluster', 10, groups);
      b.step('Vote on themes', 'Click the themes or ideas we should pursue. 3 votes each.', 'vote', 3, groups, 3);
    },
  },
  {
    id: 'lean-coffee', name: 'Lean Coffee', category: 'Discussion',
    description: 'An agenda-less meeting: propose topics, vote, discuss in timeboxes.',
    build: (b) => {
      const cols = [
        { name: 'To discuss', hint: 'Propose topics, one per note.', fill: TINT.butter },
        { name: 'Discussing', hint: 'Move the top-voted topic here.', fill: TINT.sky },
        { name: 'Done', hint: 'Topics we have covered, with takeaways.', fill: TINT.mint },
      ];
      const w = 3 * 380 + 2 * 32 + 64;
      b.header('Lean Coffee', 'Topics come from the group; time boxes keep it moving, 45–60 minutes', w);
      const outer = b.frame('Lean Coffee', 0, 0, w, 720, TINT.mist);
      const [todo, doing] = b.columns(outer, cols, 32, 32, 380, 656);
      b.step('Propose topics', 'Write the topics you want to talk about, one per note, in To discuss.', 'write', 5, todo);
      b.step('Vote', 'Click the topics you most want to discuss. 2 votes each.', 'vote', 3, todo, 2);
      b.step('Discuss topic 1', 'Move the top topic to Discussing. Talk for 8 minutes, then decide: continue or move on.', 'discuss', 8, doing);
      b.step('Discuss topic 2', 'Next topic. 8 minutes.', 'discuss', 8, doing);
      b.step('Discuss topic 3', 'Next topic. 8 minutes.', 'discuss', 8, doing);
      b.step('Wrap up', 'Write one takeaway for each topic in Done.', 'write', 5, outer);
    },
  },
  {
    id: 'impact-effort', name: 'Impact / Effort matrix', category: 'Prioritisation',
    description: 'Place ideas by impact and effort to find quick wins.',
    build: (b) => {
      const outer = grid2x2(b, 'Impact / Effort', 'Place each item by how much it helps and how hard it is, about 30 minutes', [
        { name: 'Quick wins', hint: 'High impact, low effort — do these first.', fill: TINT.mint },
        { name: 'Big bets', hint: 'High impact, high effort — plan these.', fill: TINT.sky },
        { name: 'Fill-ins', hint: 'Low impact, low effort — do if there is time.', fill: TINT.butter },
        { name: 'Money pit', hint: 'Low impact, high effort — avoid.', fill: TINT.peach },
      ]);
      b.text('Effort →', 32, 1152, 400, 16, 600, outer, '#5B6672');
      b.step('Add items', 'Write one item per note in any quadrant.', 'write', 5, outer);
      b.step('Place items', 'Move each note to where its impact and effort put it. Discuss disagreements.', 'cluster', 10, outer);
      b.step('Pick quick wins', 'Vote for the items we commit to next. 3 votes each.', 'vote', 3, outer, 3);
    },
  },
  {
    id: 'moscow', name: 'MoSCoW', category: 'Prioritisation',
    description: 'Sort requirements into Must, Should, Could and Won’t.',
    build: (b) => {
      const cols = [
        { name: 'Must have', hint: 'Without these, the release fails.', fill: TINT.peach },
        { name: 'Should have', hint: 'Important, but there is a workaround.', fill: TINT.butter },
        { name: 'Could have', hint: 'Nice to have if time allows.', fill: TINT.sky },
        { name: 'Won’t have (this time)', hint: 'Agreed out of scope for now.', fill: TINT.mist },
      ];
      const w = 4 * 320 + 3 * 32 + 64;
      b.header('MoSCoW prioritisation', 'Agree what is in and out for the release, about 30 minutes', w);
      const outer = b.frame('MoSCoW', 0, 0, w, 720, '#FFFFFF');
      b.columns(outer, cols, 32, 32, 320, 656);
      b.step('List requirements', 'Write each requirement on a note in Could have.', 'write', 5, outer);
      b.step('Sort', 'Move each note to the column it belongs in. Musts need a reason.', 'cluster', 15, outer);
      b.step('Challenge the Musts', 'Read each Must aloud. Could the release ship without it?', 'discuss', 10, outer);
    },
  },
  {
    id: 'story-map', name: 'User story map', category: 'Planning',
    description: 'Lay out the user journey, break it into stories, slice releases.',
    build: (b) => {
      const w = 1680;
      b.header('User story map', 'Backbone of activities, tasks under them, releases as horizontal slices, about 60 minutes', w);
      const outer = b.frame('Story map', 0, 0, w, 1040, TINT.mist);
      const acts = b.frame('Activities (backbone)', 32, 32, w - 64, 200, '#FFFFFF', outer);
      ['Discover', 'Sign up', 'Set up', 'Use', 'Share'].forEach((a, i) => b.sticky(a, 56 + i * 320, 64, ST.orange, acts, 140));
      const tasks = b.frame('User tasks', 32, 264, w - 64, 220, '#FFFFFF', outer);
      b.text('Under each activity, the steps a user takes.', 56, 288, 600, 15, 400, tasks, '#5B6672');
      const r1 = b.frame('Release 1: minimum lovable', 32, 516, w - 64, 240, TINT.mint, outer);
      b.text('Stories that must ship first.', 56, 540, 600, 15, 400, r1, '#5B6672');
      const r2 = b.frame('Release 2', 32, 788, w - 64, 220, TINT.sky, outer);
      void r2;
      b.step('Backbone', 'Agree the main activities left to right in the order users do them.', 'write', 10, acts);
      b.step('User tasks', 'Under each activity, add the tasks a user performs.', 'write', 15, tasks);
      b.step('Stories', 'Under each task, add stories. Put the most essential ones highest.', 'write', 15, outer);
      b.step('Slice releases', 'Move stories into release lanes. Release 1 is the thinnest useful slice.', 'cluster', 15, outer);
    },
  },
  {
    id: 'journey', name: 'Customer journey map', category: 'Discovery',
    description: 'Stages across, what customers do, think and feel down.',
    build: (b) => {
      const stages = ['Discover', 'Consider', 'Buy', 'Use', 'Advocate'];
      const colW = 280, gap = 16, x0 = 200, w = x0 + stages.length * (colW + gap) + 16;
      b.header('Customer journey map', 'Walk one persona through each stage, about 60 minutes', w);
      const outer = b.frame('Journey', 0, 0, w, 1140, '#FFFFFF');
      stages.forEach((s, i) => b.shape('terminator', s, x0 + i * (colW + gap), 32, colW, 64, '#18212B', outer, { textColor: '#FFFFFF', stroke: 'none', fontWeight: 600 }));
      const rows: [string, string][] = [['Actions', TINT.sky], ['Thoughts', TINT.lilac], ['Feelings', TINT.butter], ['Pain points', TINT.peach], ['Opportunities', TINT.mint]];
      const ids: Id[] = [];
      rows.forEach(([name, fill], i) => {
        const y = 128 + i * 200;
        b.text(name, 24, y + 20, 160, 18, 700, outer);
        ids.push(b.frame(name, x0, y, w - x0 - 16, 184, fill, outer));
      });
      b.step('Persona and goal', 'Agree who the customer is and what they are trying to do.', 'discuss', 5, outer);
      b.step('Actions', 'For each stage, what does the customer do?', 'write', 10, ids[0]);
      b.step('Thoughts and feelings', 'What are they thinking and feeling at each stage?', 'write', 10, outer);
      b.step('Pain points', 'Where does it go wrong for them?', 'write', 8, ids[3]);
      b.step('Vote', 'Which pain points matter most? 3 votes each.', 'vote', 3, ids[3], 3);
      b.step('Opportunities', 'For the top pain points, write opportunities to fix them.', 'write', 10, ids[4]);
    },
  },
  {
    id: 'empathy', name: 'Empathy map', category: 'Discovery',
    description: 'What a user says, thinks, does and feels.',
    build: (b) => {
      const outer = grid2x2(b, 'Empathy map', 'Build shared understanding of one user, about 30 minutes', [
        { name: 'Says', hint: 'Quotes and things they told us.', fill: TINT.sky },
        { name: 'Thinks', hint: 'What occupies their mind?', fill: TINT.lilac },
        { name: 'Does', hint: 'Actions and behaviour we observed.', fill: TINT.mint },
        { name: 'Feels', hint: 'Worries, hopes, frustrations.', fill: TINT.peach },
      ], 480);
      b.shape('ellipse', 'User', 32 + 480 - 70 + 12, 32 + 480 - 70 + 12, 140, 140, '#FFFFFF', outer, { fontSize: 20, fontWeight: 700 });
      b.step('Write', 'Add notes to each quadrant from research and interviews.', 'write', 10, outer);
      b.step('Discuss', 'What surprised us? Where do Says and Does disagree?', 'discuss', 10, outer);
      b.step('Insights', 'Vote for the insights that should shape our next decision.', 'vote', 3, outer, 3);
    },
  },
  {
    id: 'swot', name: 'SWOT', category: 'Strategy',
    description: 'Strengths, weaknesses, opportunities and threats.',
    build: (b) => {
      const outer = grid2x2(b, 'SWOT analysis', 'Internal strengths and weaknesses, external opportunities and threats, about 40 minutes', [
        { name: 'Strengths', hint: 'What do we do well?', fill: TINT.mint },
        { name: 'Weaknesses', hint: 'Where are we weak?', fill: TINT.peach },
        { name: 'Opportunities', hint: 'What could we take advantage of?', fill: TINT.sky },
        { name: 'Threats', hint: 'What could hurt us?', fill: TINT.butter },
      ]);
      const actions = b.frame('Actions', 1188, 0, 420, 1128, TINT.lilac);
      b.step('Write', 'Add notes to every quadrant.', 'private-write', 10, outer);
      b.step('Reveal and discuss', 'Reveal and read each quadrant.', 'discuss', 10, outer);
      b.step('Vote', 'Which items matter most? 3 votes each.', 'vote', 3, outer, 3);
      b.step('Actions', 'Turn the top items into actions.', 'write', 10, actions);
    },
  },
  {
    id: 'premortem', name: 'Pre-mortem', category: 'Risk',
    description: 'Imagine the project failed, find out why, prevent it.',
    build: (b) => {
      const w = 1560;
      b.header('Pre-mortem', 'It is six months from now and the project has failed. Why?, about 45 minutes', w);
      const outer = b.frame('Pre-mortem', 0, 0, w, 760, TINT.mist);
      const [causes, groups, mitig] = b.columns(outer, [
        { name: 'Why it failed', hint: 'Every reason you can imagine, one per note.', fill: TINT.peach },
        { name: 'Risk themes', hint: 'Group the causes into themes.', fill: TINT.butter },
        { name: 'Mitigations', hint: 'What will we do now to prevent each top risk?', fill: TINT.mint },
      ], 32, 32, 474, 696);
      b.step('Imagine failure', 'Write every reason the project could have failed. Notes stay private until reveal.', 'private-write', 8, causes);
      b.step('Reveal', 'Reveal and read the causes aloud.', 'discuss', 8, causes);
      b.step('Group into themes', 'Move causes into themes and name them.', 'cluster', 8, groups);
      b.step('Vote on top risks', 'Which risks are most likely and most damaging? 3 votes each.', 'vote', 3, groups, 3);
      b.step('Mitigations', 'Write one mitigation per top risk, with an owner.', 'write', 10, mitig);
    },
  },
  {
    id: 'business-model-canvas', name: 'Business Model Canvas', category: 'Strategy',
    description: 'Nine blocks that describe how a business creates, delivers and earns value.',
    build: (b) => {
      const u = 340, v = 300, gap = 16, pad = 24;
      const w = pad * 2 + 5 * u + 4 * gap, h = pad * 2 + 3 * v + 2 * gap;
      b.header('Business Model Canvas', 'Describe one business model on one page, fill customers first, about 90 minutes', w);
      const outer = b.frame('Business Model Canvas', 0, 0, w, h, TINT.mist);
      const blk = canvasBlocks(b, outer, [
        { name: 'Key partners', hint: 'Who are our key partners and suppliers? Which activities do they perform for us?', fill: TINT.lilac, c: 0, r: 0, rs: 2 },
        { name: 'Key activities', hint: 'What must we do to deliver the value proposition?', fill: TINT.sky, c: 1, r: 0 },
        { name: 'Key resources', hint: 'What assets do we need: people, money, IP, equipment?', fill: TINT.sky, c: 1, r: 1 },
        { name: 'Value propositions', hint: 'What value do we deliver? Which problem do we solve, for whom?', fill: TINT.butter, c: 2, r: 0, rs: 2 },
        { name: 'Customer relationships', hint: 'How do we get, keep and grow customers?', fill: TINT.rose, c: 3, r: 0 },
        { name: 'Channels', hint: 'How do customers find us, buy and get the product?', fill: TINT.rose, c: 3, r: 1 },
        { name: 'Customer segments', hint: 'Who are we creating value for? Who is the most important customer?', fill: TINT.mint, c: 4, r: 0, rs: 2 },
        { name: 'Cost structure', hint: 'What are the most important costs? Which resources and activities cost most?', fill: TINT.peach, c: 0, r: 2, cs: 2, rs: 1 },
        { name: 'Revenue streams', hint: 'What do customers pay for, how, and how much?', fill: TINT.mint, c: 2, r: 2, cs: 3, rs: 1 },
      ], u, v, gap, pad);
      b.step('Customers', 'Who are the customer segments? Write one note per segment in Customer segments, then say which matters most.', 'write', 10, blk['Customer segments']);
      b.step('Value', 'For the main segment, what do we offer and which problem does it solve?', 'write', 10, blk['Value propositions']);
      b.step('Reaching customers', 'How do we reach them (Channels) and what relationship do they expect?', 'write', 10, blk['Channels']);
      b.step('Money in', 'What do customers pay for, and how much?', 'write', 8, blk['Revenue streams']);
      b.step('Making it work', 'Key activities, resources and partners we need to deliver the value.', 'write', 15, blk['Key activities']);
      b.step('Costs', 'The largest costs of the activities and resources above.', 'write', 8, blk['Cost structure']);
      b.step('Riskiest assumptions', 'Click the notes that we are least sure about. 3 votes each.', 'vote', 3, outer, 3);
      b.step('Next experiments', 'For the top assumptions, discuss one cheap test each.', 'discuss', 10, outer);
    },
  },
  {
    id: 'lean-canvas', name: 'Lean Canvas', category: 'Strategy',
    description: 'A one-page plan for a startup idea: problem, solution, key metrics and unfair advantage.',
    build: (b) => {
      const u = 340, v = 300, gap = 16, pad = 24;
      const w = pad * 2 + 5 * u + 4 * gap, h = pad * 2 + 3 * v + 2 * gap;
      b.header('Lean Canvas', 'Test an idea on one page, start with the problem, about 60 minutes', w);
      const outer = b.frame('Lean Canvas', 0, 0, w, h, TINT.mist);
      const blk = canvasBlocks(b, outer, [
        { name: 'Problem', hint: 'Top three problems. Existing alternatives: how are they solved today?', fill: TINT.peach, c: 0, r: 0, rs: 2 },
        { name: 'Solution', hint: 'The top three features that answer those problems.', fill: TINT.sky, c: 1, r: 0 },
        { name: 'Key metrics', hint: 'The few numbers that tell us it works.', fill: TINT.sky, c: 1, r: 1 },
        { name: 'Unique value proposition', hint: 'One clear, compelling message that says why you are different and worth buying. High-level concept: X for Y.', fill: TINT.butter, c: 2, r: 0, rs: 2 },
        { name: 'Unfair advantage', hint: 'Something that cannot easily be copied or bought.', fill: TINT.lilac, c: 3, r: 0 },
        { name: 'Channels', hint: 'The path to your customers.', fill: TINT.rose, c: 3, r: 1 },
        { name: 'Customer segments', hint: 'Target customers and users. Early adopters: who are the first ten?', fill: TINT.mint, c: 4, r: 0, rs: 2 },
        { name: 'Cost structure', hint: 'Fixed and variable costs, customer acquisition, hosting, people.', fill: TINT.peach, c: 0, r: 2, cs: 2, rs: 1 },
        { name: 'Revenue streams', hint: 'Revenue model, lifetime value, revenue, gross margin.', fill: TINT.mint, c: 2, r: 2, cs: 3, rs: 1 },
      ], u, v, gap, pad);
      b.step('Customer and problem', 'Start with the early adopters and the top three problems they have. One note each.', 'write', 12, blk['Problem']);
      b.step('Existing alternatives', 'How do they solve each problem today? Add it to the Problem block.', 'write', 6, blk['Problem']);
      b.step('Value proposition', 'Write the single message. Draft three versions, then pick one.', 'write', 10, blk['Unique value proposition']);
      b.step('Solution and metrics', 'Features for the top problems, and the metrics that show it works.', 'write', 12, blk['Solution']);
      b.step('Channels and advantage', 'How will you reach early adopters? What is hard to copy?', 'write', 8, blk['Channels']);
      b.step('Costs and revenue', 'Rough costs and revenue streams. Numbers can be guesses.', 'write', 8, blk['Revenue streams']);
      b.step('Riskiest assumption', 'Click the notes you are least sure about. 3 votes each.', 'vote', 3, outer, 3);
    },
  },
  {
    id: 'service-blueprint', name: 'Service Blueprint', category: 'Discovery',
    description: 'Customer actions on top, the visible and hidden work that supports each stage below.',
    build: (b) => {
      const stages = ['Awareness', 'Sign up', 'Service delivery', 'Follow-up'];
      const colW = 320, gap = 16, x0 = 200, w = x0 + stages.length * (colW + gap) + 16;
      const rowH = 176;
      b.header('Service Blueprint', 'Map one service end to end, front and back, about 90 minutes', w);
      const rows: { name: string; fill: string }[] = [
        { name: 'Physical evidence', fill: TINT.butter },
        { name: 'Customer actions', fill: TINT.sky },
        { name: 'Frontstage actions', fill: TINT.mint },
        { name: 'Backstage actions', fill: TINT.lilac },
        { name: 'Support processes', fill: TINT.mist },
      ];
      // the line of visibility sits between frontstage and backstage and takes extra room
      const lineAfter = 2, lineH = 72;
      const h = 112 + rows.length * (rowH + 16) + lineH + 16;
      const outer = b.frame('Service blueprint', 0, 0, w, h, '#FFFFFF');
      stages.forEach((s, i) => b.shape('terminator', s, x0 + i * (colW + gap), 24, colW, 64, '#18212B', outer, { textColor: '#FFFFFF', stroke: 'none', fontWeight: 600 }));
      const ids: Record<string, Id> = {};
      let y = 112;
      rows.forEach((r, i) => {
        b.text(r.name, 24, y + 20, 160, 18, 700, outer);
        ids[r.name] = b.frame(r.name, x0, y, w - x0 - 16, rowH, r.fill, outer);
        y += rowH + 16;
        if (i === lineAfter) {
          b.shape('rect', '', 24, y + 8, w - 48, 4, '#18212B', outer, { stroke: 'none' });
          b.text('Line of visibility: above it the customer sees the work, below it they do not', x0, y + 20, w - x0 - 16, 14, 600, outer, '#5B6672');
          y += lineH;
        }
      });
      b.step('Customer and service', 'Agree who the customer is and which service you are mapping. Name the stages.', 'discuss', 8, outer);
      b.step('Customer actions', 'For each stage, what does the customer do? One note per action.', 'write', 12, ids['Customer actions']);
      b.step('Frontstage', 'What do staff and the interface do that the customer sees?', 'write', 12, ids['Frontstage actions']);
      b.step('Backstage', 'What happens out of sight to make each frontstage action possible?', 'write', 12, ids['Backstage actions']);
      b.step('Support and evidence', 'Which systems, teams and partners support it? What does the customer see or touch?', 'write', 10, ids['Support processes']);
      b.step('Fail points', 'Mark the places where it goes wrong or waits. 3 votes each.', 'vote', 3, outer, 3);
      b.step('Improvements', 'For the top fail points, agree one change each, with an owner.', 'discuss', 10, outer);
    },
  },
  {
    id: 'design-sprint', name: 'Design Sprint agenda', category: 'Planning',
    description: 'Five days from map to test, with the first day set up as a timed session.',
    build: (b) => {
      const days: { name: string; fill: string; items: string }[] = [
        { name: 'Monday: Map', fill: TINT.sky, items: 'Long-term goal\nSprint questions\nMap the journey\nAsk the experts\nHow might we… notes\nPick a target' },
        { name: 'Tuesday: Sketch', fill: TINT.butter, items: 'Lightning demos\nNotes\nCrazy 8s\nSolution sketch' },
        { name: 'Wednesday: Decide', fill: TINT.lilac, items: 'Art museum\nHeat map vote\nSpeed critiques\nStraw poll\nDecider vote\nStoryboard' },
        { name: 'Thursday: Prototype', fill: TINT.mint, items: 'Pick tools and roles\nBuild the prototype\nTrial run\nWrite the interview script' },
        { name: 'Friday: Test', fill: TINT.peach, items: 'Five customer interviews\nWatch together\nTake notes\nFind patterns\nDecide next steps' },
      ];
      const colW = 340, gap = 24, pad = 32;
      const w = pad * 2 + days.length * colW + (days.length - 1) * gap;
      b.header('Design Sprint agenda', 'One week, one big question. Run Monday as a session, about 5 hours', w);
      const outer = b.frame('Design Sprint', 0, 0, w, 840, TINT.mist);
      const goal = b.frame('Long-term goal and sprint questions', pad, pad, w - pad * 2, 160, '#FFFFFF', outer);
      b.text('Where do we want to be in six months or a year? What could stop us? Turn each risk into a question.', pad + 24, pad + 24, w - pad * 2 - 48, 15, 400, goal, '#5B6672');
      const cols: Id[] = [];
      days.forEach((d, i) => {
        const x = pad + i * (colW + gap), y = pad + 160 + gap;
        const f = b.frame(d.name, x, y, colW, 840 - y - pad, d.fill, outer);
        cols.push(f);
        b.text(d.items, x + 24, y + 24, colW - 48, 17, 500, f);
        b.text('Notes and outputs', x + 24, y + 260, colW - 48, 15, 400, f, '#5B6672');
      });
      const map = cols[0];
      b.step('Long-term goal', 'Agree where we want to be in six months to a year. Write it in the top frame.', 'discuss', 10, goal);
      b.step('Sprint questions', 'What must be true for the goal to happen? What could go wrong? Write each as a question.', 'private-write', 10, goal);
      b.step('Map', 'Draw the customer journey from first contact to goal. Keep it to 5 to 15 steps.', 'write', 30, map);
      b.step('How might we', 'Add a note for every idea or problem you hear while experts talk. One per note.', 'private-write', 20, map);
      b.step('Vote on notes', 'Click the notes that matter most. 2 votes each.', 'vote', 3, map, 2);
      b.step('Pick a target', 'The decider chooses one customer and one moment on the map to focus the sprint on.', 'discuss', 10, map);
    },
  },
  // kanbans (docs/kanban.md, Templates): a container with lanes and cards, and a few labels merged into the board's
  {
    id: 'kanban', name: 'Kanban', category: 'Planning',
    description: 'To do, Doing and Done. Add cards, give them owners and due dates, and move them across as work moves.',
    build: (b) => {
      b.kanban('Kanban', 0, 0, [
        { name: 'To do', stage: 'todo', cards: [{ title: 'Write the first card', labels: ['Chore'] }, { title: 'Drag a card to Doing when you start it' }] },
        { name: 'Doing', stage: 'doing', cards: [{ title: 'Open a card to add an owner, a due date and labels' }] },
        { name: 'Done', stage: 'done' },
      ], LABEL_COLORS);
    },
  },
  {
    id: 'sprint-board', name: 'Sprint board', category: 'Planning',
    description: 'Backlog, Sprint, In review and Done, with at most three cards in review at a time.',
    build: (b) => {
      b.kanban('Sprint board', 0, 0, [
        { name: 'Backlog', stage: 'todo', cards: [{ title: 'Sketch the next feature', labels: ['Feature'] }, { title: 'Tidy up old tickets', labels: ['Chore'] }] },
        { name: 'Sprint', stage: 'doing', fill: 'blue', cards: [{ title: 'Pick this sprint\u2019s goal', labels: ['Feature'] }] },
        { name: 'In review', stage: 'doing', wip: 3, fill: 'violet' },
        { name: 'Done', stage: 'done', fill: 'green' },
      ], LABEL_COLORS);
    },
  },
  {
    id: 'bug-triage', name: 'Bug triage', category: 'Planning',
    description: 'New reports in, sorted into confirmed, in progress, fixed or won\u2019t fix, with labels for the kind of work.',
    build: (b) => {
      b.kanban('Bug triage', 0, 0, [
        { name: 'New', stage: 'todo', cards: [{ title: 'Paste a new report here', labels: ['Bug'] }] },
        { name: 'Confirmed', stage: 'todo', fill: 'orange', cards: [{ title: 'Steps to reproduce written down', labels: ['Bug'] }] },
        { name: 'In progress', stage: 'doing', wip: 3 },
        { name: 'Fixed', stage: 'done', fill: 'green' },
        { name: 'Won\u2019t fix', stage: 'done', fill: 'grey' },
      ], LABEL_COLORS);
    },
  },
  {
    id: 'personal-tasks', name: 'Personal tasks', category: 'Planning',
    description: 'Your own list: what is next, what you are on today, and what you finished.',
    build: (b) => {
      b.kanban('My tasks', 0, 0, [
        { name: 'Next', stage: 'todo', cards: [{ title: 'Something to do this week' }] },
        { name: 'Today', stage: 'doing', wip: 3, wipMode: 'block', fill: 'yellow' },
        { name: 'Done', stage: 'done' },
      ], LABEL_COLORS);
    },
  },
];

/** Template ids with this prefix name a saved template; anything else is a built-in id. */
export const CUSTOM_PREFIX = 'custom:';

/** The category a saved template gets when none of the built-in ones fits. */
export const CUSTOM_CATEGORY = 'Custom';

/** The built-in categories, in the order the templates first use them. */
export const CATEGORIES: TemplateDef['category'][] = [...new Set(TEMPLATES.map((t) => t.category))];

/** Where a template goes: to the right of existing content, snapped to the grid. */
function templateOrigin(app: BoardApp) {
  const content = app.r.contentBounds();
  const ox = content ? content.x + content.w + 400 : Math.round(app.r.viewport().x + 80);
  const oy = content ? content.y + 160 : Math.round(app.r.viewport().y + 200);
  return { x: Math.round(ox / 24) * 24, y: Math.round(oy / 24) * 24 };
}

/** Create the objects in one undo step, replace the flow when `steps` is given, and fly to them. */
function place(app: BoardApp, objs: Obj[], steps: Step[] | null, labels: readonly TemplateLabel[] = []) {
  const zs = app.store.topZs(objs.length);
  objs.forEach((o, i) => (o.z = zs[i]));
  app.store.undo.stopCapturing();
  app.store.transact(() => {
    // the template's labels join the board's by name, and its cards take the board's ids (docs/kanban.md, Templates)
    const cards = objs.filter((o): o is BaseObj => o.type === 'card' && !!(o as BaseObj).labels?.length);
    if (cards.length) {
      const ids = mergeTemplateLabels(app.store, labels);
      for (const card of cards) {
        const next = card.labels!.map((id) => ids.get(id)).filter((id): id is Id => !!id);
        if (next.length) card.labels = next;
        else {
          delete card.labels;
          card.h = cardContentHeight(card, card.w);
        }
      }
    }
    objs.forEach((o) => app.store.create(o));
  });
  if (steps) {
    const existing = app.flow.state().steps;
    // A board runs one session at a time; a new template replaces the old flow.
    app.flow.setSteps(steps);
    if (existing.length) app.flow.end();
  }
  app.setSelection([]);
  const bounds = app.r.contentBounds(objs.map((o) => o.id));
  if (bounds) app.r.flyTo(bounds, 60, 1);
}

/** Add a template to the board, to the right of existing content. */
export function insertTemplate(app: BoardApp, def: TemplateDef) {
  const o = templateOrigin(app);
  const b = new Builder(app, o.x, o.y);
  def.build(b);
  // a template without steps leaves the board's session as it is, as a saved one does
  place(app, b.objs, b.steps.length ? b.steps : null, b.labels);
  return b;
}

/** Add a saved template to the board like a built-in one; the board's flow is replaced only when the template has steps. */
export function insertCustomTemplate(app: BoardApp, t: CustomTemplate) {
  const { objects, steps } = instantiate(t.content, templateOrigin(app), app.user.id);
  const now = Date.now();
  for (const o of objects) o.updatedAt = now;
  place(app, objects, steps.length ? steps : null, t.content.labels);
  return objects;
}
