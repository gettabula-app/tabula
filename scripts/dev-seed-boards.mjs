#!/usr/bin/env node
// DEV ONLY. Seeds a fresh, throwaway accounts-mode directory with a realistic Boards home: people, teams, boards, shares
// and last editors. Every run deletes and recreates the data dir, so nothing here reaches real data.
//
//   node scripts/dev-seed-boards.mjs     seeds .dev-data/boards-real (rows and content; no pictures: the app draws them)
//   npm run dev:boards-real              the same seed, then the relay and the app (scripts/dev-boards-real.mjs)
//
// The rows are written through server/directory.mjs, the module the relay opens, so the schema is the real one.
// The boards with a template get their real content (their .yjs files), from the app's own modules
// (scripts/dev-board-content.mjs). A board with no template opens blank (server/relay.mjs, Room). No picture is seeded or
// drawn here: the pictures come from the app (scripts/dev-board-warm.mjs drives it at launch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDirectory } from '../server/directory.mjs';
import { seedBoardContent } from './dev-board-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_ROOT = path.join(root, '.dev-data');
export const DEFAULT_DATA_DIR = path.join(DEV_ROOT, 'boards-real');
const TEMPLATES_SRC = path.join(root, 'src', 'templates.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Login links are single use (server/directory.mjs consumeLoginToken), so the TTL only matters until the link is first opened. */
const LINK_TTL_MS = 365 * DAY;

/** Owner address; the same value scripts/dev-boards-real.mjs passes as TABULA_OWNER_EMAIL. */
export const OWNER_EMAIL = 'owner@example.com';

const PEOPLE = [
  { key: 'maja', email: OWNER_EMAIL, name: 'Maja Holm', role: 'owner' },
  { key: 'omar', email: 'omar@example.com', name: 'Omar Haddad', role: 'member' },
  { key: 'lin', email: 'lin@example.com', name: 'Lin Chen', role: 'member' },
  { key: 'eva', email: 'eva@example.com', name: 'Eva Novak', role: 'member' },
  { key: 'ben', email: 'ben@example.com', name: 'Ben Okafor', role: 'member' },
  { key: 'pia', email: 'pia@example.com', name: 'Pia Larsen', role: 'guest' },
];

// Maja creates every team she is in, so she is admin of each. Platform is created by Omar, so Maja is not a member.
// Growth has no boards and only Maja.
const TEAMS = [
  { key: 'design', name: 'Design team', creator: 'maja', members: [['omar', 'member'], ['lin', 'member'], ['eva', 'member']] },
  { key: 'retro', name: 'Retro team', creator: 'maja', members: [['omar', 'member'], ['ben', 'member']] },
  { key: 'growth', name: 'Growth team', creator: 'maja', members: [] },
  { key: 'platform', name: 'Platform team', creator: 'omar', members: [['ben', 'member']] },
];

const LONG_TITLE = 'Retro: the v5 launch, the Friday deploy that rolled back twice, the on-call handoff gaps, and the three changes we want before the next release train starts';

// `created` and `edit.ago` are milliseconds before the seed runs. `template` is a built-in id from src/templates.ts, or null
// for a board with no image yet. An `edit` is a last editor: `who` is a person key (stored by user id), `agent` is a name.
const BOARDS = [
  // Design team: 9 boards
  { id: 'q4-roadmap', title: 'Q4 roadmap', owner: 'lin', team: 'design', template: 'kanban', created: 40 * DAY, edit: { who: 'eva', ago: 2 * HOUR } },
  { id: 'q4-roadmap-copy', title: 'Q4 roadmap copy', owner: 'lin', team: 'design', template: null, created: 1 * DAY },
  { id: 'design-system-audit', title: 'Design system audit', owner: 'eva', team: 'design', template: 'kanban', created: 9 * DAY, edit: { who: 'omar', ago: 12 * MIN } },
  { id: 'onboarding-research', title: 'Onboarding flow research', owner: 'lin', team: 'design', template: 'journey', created: 21 * DAY, edit: { agent: 'Claude', ago: 35 * MIN } },
  { id: 'competitor-swot-autumn', title: 'Competitor SWOT, autumn', owner: 'eva', team: 'design', template: 'swot', created: 25 * DAY, edit: { who: 'lin', ago: 3 * DAY } },
  { id: 'accessibility-checkout', title: 'Accessibility review: checkout', owner: 'omar', team: 'design', template: 'premortem', created: 14 * DAY },
  { id: 'design-sprint-onboarding', title: 'Design sprint: onboarding', owner: 'lin', team: 'design', template: 'design-sprint', created: 18 * DAY, edit: { who: 'maja', ago: 4 * DAY } },
  { id: 'mobile-nav-ideas', title: 'Mobile nav ideas', owner: 'eva', team: 'design', template: 'crazy-8s', created: 11 * DAY, edit: { who: 'eva', ago: 6 * DAY } },
  { id: 'untitled-new', title: 'Untitled board', owner: 'eva', team: 'design', template: null, created: 8 * MIN },
  // Retro team: 3 boards
  { id: 'sprint-42-retro', title: 'Sprint 42 retro', owner: 'ben', team: 'retro', template: 'mad-sad-glad', created: 13 * DAY, edit: { who: 'omar', ago: 5 * HOUR } },
  { id: 'retro-v5-launch', title: LONG_TITLE, owner: 'maja', team: 'retro', template: 'mad-sad-glad', created: 10 * DAY, edit: { agent: 'Claude', ago: 9 * DAY } },
  { id: 'team-health-check', title: 'Team health check', owner: 'omar', team: 'retro', template: 'mad-sad-glad', created: 30 * DAY, edit: { who: 'ben', ago: 14 * DAY } },
  // Platform team: 3 boards, Maja is not a member (an invalid drop target for her)
  { id: 'platform-sprint', title: 'Platform sprint board', owner: 'omar', team: 'platform', template: 'kanban', created: 6 * DAY, edit: { who: 'ben', ago: 25 * MIN } },
  { id: 'platform-cost-model', title: 'Platform cost model', owner: 'ben', team: 'platform', template: 'lean-canvas', created: 5 * DAY, edit: { agent: 'Claude', ago: 1 * DAY } },
  { id: 'tech-debt-lean-coffee', title: 'Tech debt lean coffee', owner: 'ben', team: 'platform', template: 'lean-coffee', created: 12 * DAY, edit: { who: 'omar', ago: 2 * DAY } },
  // Maja's personal boards: 3
  // The privacy board: the everyone's-view tests (scripts/dev-board-content.mjs privacyObjects); content only, no template
  { id: 'preview-privacy-test', title: 'Preview privacy test', owner: 'maja', team: null, template: null, created: 1 * DAY, edit: { who: 'maja', ago: 30 * MIN } },
  { id: 'maja-weekly-plan', title: 'Weekly plan', owner: 'maja', team: null, template: 'sprint-board', created: 3 * DAY, edit: { who: 'maja', ago: 50 * MIN } },
  { id: 'maja-new-hire-empathy', title: '🧭 New-hire empathy map', owner: 'maja', team: null, template: 'empathy', created: 20 * DAY, edit: { who: 'maja', ago: 7 * DAY } },
  { id: 'maja-scratch', title: 'Scratch', owner: 'maja', team: null, template: null, created: 2 * HOUR },
  // Personal boards of others, shared with Maja: 2 as viewer, 1 as commenter
  { id: 'omar-launch-plan-ar', title: 'خطة الإطلاق للربع الأول', owner: 'omar', team: null, template: 'swot', created: 28 * DAY, edit: { who: 'omar', ago: 21 * DAY } },
  { id: 'eva-portfolio-notes', title: 'Portfolio case study notes', owner: 'eva', team: null, template: 'lean-canvas', created: 42 * DAY },
  { id: 'ben-onboarding-buddy', title: 'Onboarding buddy pairs', owner: 'ben', team: null, template: 'empathy', created: 15 * DAY, edit: { who: 'ben', ago: 11 * DAY } },
];

// Board shares. Maja is the workspace owner, so she sees every board as owner; her shares are data only.
// Pia is a guest and sees only what is shared with her. Omar, a member, shows the viewer role on a board he does not own.
const SHARES = [
  { board: 'omar-launch-plan-ar', to: 'maja', role: 'viewer' },
  { board: 'eva-portfolio-notes', to: 'maja', role: 'viewer' },
  { board: 'ben-onboarding-buddy', to: 'maja', role: 'commenter' },
  { board: 'q4-roadmap', to: 'pia', role: 'viewer' },
  { board: 'onboarding-research', to: 'pia', role: 'viewer' },
  { board: 'design-sprint-onboarding', to: 'pia', role: 'commenter' },
  { board: 'maja-weekly-plan', to: 'omar', role: 'viewer' },
  { board: 'q4-roadmap', team: 'growth', role: 'viewer' },
  { board: 'preview-privacy-test', to: 'omar', role: 'commenter' },
];

/** Every template id a seeded board uses must exist in src/templates.ts (the built-in list). */
export function builtInTemplateIds(source = fs.readFileSync(TEMPLATES_SRC, 'utf8')) {
  return new Set([...source.matchAll(/^\s+id: '([^']+)',\s*name:/gm)].map((m) => m[1]));
}

function assertInsideDevRoot(dataDir) {
  const rel = path.relative(DEV_ROOT, path.resolve(dataDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to reset ${dataDir}: the seed only recreates directories inside ${DEV_ROOT}`);
  }
}

/**
 * Recreates the data dir and seeds it. Returns the ids and one single-use sign-in token per persona (plus a `smoke`
 * token for curl checks), so the caller can print links without parsing output.
 * @param {{ dataDir?: string, now?: number }} [options]
 */
export function seed({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  assertInsideDevRoot(dataDir);
  const known = builtInTemplateIds();
  for (const b of BOARDS) {
    if (b.template !== null && !known.has(b.template)) throw new Error(`board ${b.id} uses template ${b.template}, which is not built in`);
    if (b.title.length > 200) throw new Error(`board ${b.id} title is over 200 characters`);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const directory = openDirectory(path.join(dataDir, 'directory.sqlite'));
  try {
    const user = {};
    for (const p of PEOPLE) user[p.key] = directory.createUser({ email: p.email, name: p.name, role: p.role });

    const team = {};
    for (const t of TEAMS) {
      team[t.key] = directory.createTeam({ name: t.name, creatorId: user[t.creator].id });
      for (const [who, role] of t.members) directory.addTeamMember(team[t.key].id, user[who].id, role);
    }

    for (const b of BOARDS) {
      directory.createBoard({
        id: b.id,
        title: b.title,
        ownerId: user[b.owner].id,
        teamId: b.team ? team[b.team].id : null,
      });
      let editedAt = null;
      if (b.edit) {
        editedAt = now - b.edit.ago;
        const by = b.edit.agent ? { by: b.edit.agent, kind: 'agent' } : { by: user[b.edit.who].id, kind: 'person' };
        directory.touchBoard(b.id, { editor: { ...by, at: editedAt } });
      }
      // createBoard and touchBoard stamp updated_at with the real clock; put the seeded times back so the home sorts as designed.
      const createdAt = now - b.created;
      directory.db.prepare('UPDATE boards SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, editedAt ?? createdAt, b.id);
    }

    for (const s of SHARES) {
      if (s.team) directory.shareBoard(s.board, { principalType: 'team', principalId: team[s.team].id, role: s.role });
      else directory.shareBoard(s.board, { principalType: 'user', principalId: user[s.to].id, role: s.role });
    }

    const tokens = {};
    for (const key of ['maja', 'omar', 'pia']) {
      tokens[key] = directory.createLoginToken({ email: PEOPLE.find((p) => p.key === key).email, ttlMs: LINK_TTL_MS, now });
    }
    tokens.smoke = directory.createLoginToken({ email: OWNER_EMAIL, ttlMs: LINK_TTL_MS, now });


    return {
      dataDir,
      people: PEOPLE.map((p) => ({ ...p, id: user[p.key].id })),
      teams: TEAMS.map((t) => ({ ...t, id: team[t.key].id })),
      boards: BOARDS,
      shares: SHARES,
      tokens,
    };
  } finally {
    directory.close();
  }
}

/**
 * The rows (seed), then the content of the boards that have a template (seedBoardContent). Returns the seed's result with
 * `content`: one entry per board written.
 * @param {{ dataDir?: string, now?: number }} [options]
 */
export async function seedAll(options = {}) {
  const result = seed(options);
  result.content = await seedBoardContent({ dataDir: result.dataDir, boards: result.boards, people: result.people });
  return result;
}

/** A table of the seeded data, for the terminal. */
export function describeSeed(result) {
  const name = (key) => PEOPLE.find((p) => p.key === key)?.name ?? key;
  const teamName = (key) => (key ? TEAMS.find((t) => t.key === key)?.name ?? key : 'personal');
  const lines = [];
  lines.push(`seeded ${result.boards.length} boards, ${result.teams.length} teams, ${result.people.length} people in ${result.dataDir}`);
  lines.push('');
  lines.push('people:');
  for (const p of PEOPLE) {
    lines.push(`  ${p.name.padEnd(14)} ${p.email.padEnd(20)} ${p.role}`);
  }
  lines.push('');
  lines.push('teams:');
  for (const t of TEAMS) {
    const members = [`${name(t.creator)} (admin)`, ...t.members.map(([who, role]) => `${name(who)} (${role})`)];
    const boards = BOARDS.filter((b) => b.team === t.key).length;
    lines.push(`  ${t.name.padEnd(14)} ${String(boards).padStart(2)} boards  ${members.join(', ')}`);
  }
  lines.push('');
  lines.push('boards:');
  for (const b of BOARDS) {
    const editor = !b.edit ? 'none' : b.edit.agent ? `${b.edit.agent} (agent)` : `${name(b.edit.who)} (person)`;
    const shares = SHARES.filter((s) => s.board === b.id).map((s) => `${s.team ? teamName(s.team) : name(s.to)}:${s.role}`);
    lines.push(`  ${b.id.padEnd(26)} ${String(b.template ?? 'no content').padEnd(14)} ${teamName(b.team).padEnd(14)} owner ${name(b.owner).padEnd(13)} edited ${editor}${shares.length ? `  shared ${shares.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await seedAll();
  console.log(describeSeed(result));
  console.log(`\ncontent: ${result.content.length} boards with a template (${result.content.reduce((n, c) => n + c.objects, 0)} objects)`);
}
