import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj, ShapeKind, Step, StepMode } from './types';
import { newId } from './store';
import { STICKY_COLORS } from './palette';

export interface TemplateDef {
  id: string;
  name: string;
  category: 'Retrospective' | 'Ideation' | 'Discussion' | 'Prioritisation' | 'Planning' | 'Discovery' | 'Strategy' | 'Risk';
  description: string;
  build: (b: Builder) => void;
}

const TINT = {
  mint: '#E6F7EF', sky: '#E4EFFF', butter: '#FFF6D6', peach: '#FFE9E0', lilac: '#F0EAFF', mist: '#F3F5F7', rose: '#FFE8F0',
};
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
];

/** Add a template to the board, to the right of existing content. */
export function insertTemplate(app: BoardApp, def: TemplateDef) {
  const content = app.r.contentBounds();
  const ox = content ? content.x + content.w + 400 : Math.round(app.r.viewport().x + 80);
  const oy = content ? content.y + 160 : Math.round(app.r.viewport().y + 200);
  const b = new Builder(app, Math.round(ox / 24) * 24, Math.round(oy / 24) * 24);
  def.build(b);
  const zs = app.store.topZs(b.objs.length);
  b.objs.forEach((o, i) => (o.z = zs[i]));
  app.store.undo.stopCapturing();
  app.store.transact(() => b.objs.forEach((o) => app.store.create(o)));
  const existing = app.flow.state().steps;
  // A board runs one session at a time; a new template replaces the old flow.
  app.flow.setSteps(b.steps);
  if (existing.length) app.flow.end();
  app.setSelection([]);
  const bounds = app.r.contentBounds(b.objs.map((o) => o.id));
  if (bounds) app.r.flyTo(bounds, 60, 1);
  return b;
}
