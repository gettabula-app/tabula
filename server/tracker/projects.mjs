import { ticketAccess } from './access.mjs';
import {
  actorInfo, cleanText, conflict, forbidden, getDb, inTransaction, invalid, limitExceeded, newId,
  notFound, requireWritable, utcStartOfDay, validCalendarDate,
} from './shared.mjs';

const PROJECT_STATES = new Set(['planned', 'started', 'paused', 'completed', 'canceled']);
const MILESTONE_STATES = new Set(['planned', 'started', 'completed']);
const PROJECT_LIMIT = 200;
const MILESTONE_LIMIT = 50;
const TRACKER_CHECK = Object.freeze({ id: 'tracker-access-check' });

function requireRead(actor) {
  ticketAccess(actor, TRACKER_CHECK);
}

function requireTrackerWrite(actor) {
  if (ticketAccess(actor, TRACKER_CHECK) !== 'write') throw forbidden('This tracker is read-only for this actor.');
}

function projectState(value, path = 'state', fallback = 'planned') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !PROJECT_STATES.has(value)) throw invalid(path, `Must be one of ${[...PROJECT_STATES].join(', ')}`);
  return value;
}

function milestoneState(value, path = 'state', fallback = 'planned') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !MILESTONE_STATES.has(value)) throw invalid(path, `Must be one of ${[...MILESTONE_STATES].join(', ')}`);
  return value;
}

function ownerUserId(db, actor, value, path = 'owner') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid(path, 'Use "me", a member name, or an email address');
  const name = cleanText(value, { path, min: 1, max: 200 });
  const info = actorInfo(actor);
  if (name.toLowerCase() === 'me') {
    if (!info.userId) throw invalid(path, 'The current actor has no member account');
    const self = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0").get(info.userId);
    if (!self) throw invalid(path, 'The current actor is not an active workspace member');
    return self.id;
  }
  const matches = db.prepare(
    `SELECT id FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0
      AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) ORDER BY id`,
  ).all(name, name);
  if (matches.length > 1) throw invalid(path, 'Member name is ambiguous; use an email address');
  if (matches.length === 1) return matches[0].id;
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(name)) throw invalid(path, 'Pass a member name or email, not a user id');
  throw invalid(path, 'No active workspace member matches this name or email');
}

function projectJson(db, row) {
  const owner = row.owner_user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.owner_user_id) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    owner: owner ? { userId: row.owner_user_id, name: owner.name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function milestoneJson(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    name: row.name,
    description: row.description,
    due: row.due_at == null ? null : new Date(row.due_at).toISOString().slice(0, 10),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function projectRow(db, projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId.trim()) ?? null;
}

function milestoneRow(db, milestoneId) {
  if (typeof milestoneId !== 'string' || !milestoneId.trim()) return null;
  return db.prepare(
    `SELECT m.*, p.name AS project_name FROM milestones m
      LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`,
  ).get(milestoneId.trim()) ?? null;
}

function ensureActiveNameAvailable(db, name, excludingId = null) {
  const existing = db.prepare(
    'SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL AND id IS NOT ?',
  ).get(name, excludingId);
  if (existing) throw conflict('An active project with this name already exists', 'name');
}

/** @param {any} options */
export function createProject({ directory, db: dbArg, actor, name, description = '', state, owner = null, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  const cleanName = cleanText(name, { path: 'name', min: 1, max: 100, singleLine: true });
  const cleanDescription = cleanText(description, { path: 'description', max: 20_000, trim: false });
  const cleanState = projectState(state);
  const ownerId = ownerUserId(db, actor, owner);
  return inTransaction({ directory, db }, () => {
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL').get().n) >= PROJECT_LIMIT) {
      throw limitExceeded(`A workspace can have at most ${PROJECT_LIMIT} active projects`, 'name');
    }
    ensureActiveNameAvailable(db, cleanName);
    const id = newId();
    db.prepare(
      `INSERT INTO projects (id, name, description, state, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, cleanName, cleanDescription, cleanState, ownerId, now, now);
    return projectJson(db, projectRow(db, id));
  });
}

/** @param {any} options */
export function updateProject({ directory, db: dbArg, actor, projectId, patch, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch', 'Must be an object');
  const allowed = new Set(['name', 'description', 'state', 'owner', 'archived']);
  for (const field of Object.keys(patch)) if (!allowed.has(field)) throw invalid(`patch.${field}`, 'Unsupported project field');
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw invalid('patch.archived', 'Must be true or false');
  return inTransaction({ directory, db }, () => {
    const row = projectRow(db, projectId);
    if (!row) throw notFound('Project not found', 'projectId');
    const next = {
      name: patch.name === undefined ? row.name : cleanText(patch.name, { path: 'patch.name', min: 1, max: 100, singleLine: true }),
      description: patch.description === undefined ? row.description : cleanText(patch.description, { path: 'patch.description', max: 20_000, trim: false }),
      state: projectState(patch.state, 'patch.state', row.state),
      ownerId: patch.owner === undefined ? row.owner_user_id : ownerUserId(db, actor, patch.owner, 'patch.owner'),
      archivedAt: patch.archived === undefined ? row.archived_at ?? null : (patch.archived ? (row.archived_at ?? now) : null),
    };
    const wasActive = row.archived_at == null;
    const willBeActive = next.archivedAt == null;
    if (!wasActive && willBeActive && Number(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL').get().n) >= PROJECT_LIMIT) {
      throw limitExceeded(`A workspace can have at most ${PROJECT_LIMIT} active projects`, 'projectId');
    }
    if (willBeActive && (!wasActive || next.name.toLocaleLowerCase('en-US') !== row.name.toLocaleLowerCase('en-US'))) {
      ensureActiveNameAvailable(db, next.name, row.id);
    }
    if (next.name === row.name && next.description === row.description && next.state === row.state &&
      next.ownerId === row.owner_user_id && next.archivedAt === (row.archived_at ?? null)) return projectJson(db, row);
    db.prepare(
      `UPDATE projects SET name = ?, description = ?, state = ?, owner_user_id = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.description, next.state, next.ownerId, next.archivedAt, now, row.id);
    return projectJson(db, projectRow(db, row.id));
  });
}

/** @param {any} options */
export function archiveProject(options = {}) {
  return updateProject({ ...options, patch: { ...options.patch, archived: true } });
}

/** @param {any} options */
export function restoreProject(options = {}) {
  return updateProject({ ...options, patch: { ...options.patch, archived: false } });
}

/** @param {any} options */
export function listProjects({ directory, db: dbArg, actor, includeArchived = false } = {}) {
  requireRead(actor);
  if (typeof includeArchived !== 'boolean') throw invalid('includeArchived', 'Must be true or false');
  const db = getDb({ directory, db: dbArg });
  const rows = db.prepare(
    `SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY name COLLATE NOCASE, id`,
  ).all();
  return rows.map((row) => projectJson(db, row));
}

function resolveMilestoneProject(db, reference) {
  if (typeof reference !== 'string' || !reference.trim()) throw invalid('projectId', 'A project is required');
  const value = cleanText(reference, { path: 'projectId', min: 1, max: 100 });
  const byId = db.prepare('SELECT id, name FROM projects WHERE id = ? AND archived_at IS NULL').get(value);
  if (byId) return byId;
  const byName = db.prepare('SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(value);
  if (byName) return byName;
  throw invalid('projectId', 'No active project matches this id or name');
}

function milestoneDue(value, path = 'due', allowNull = false) {
  if (allowNull && value === null) return null;
  if (!validCalendarDate(value)) throw invalid(path, 'Must be a calendar-valid YYYY-MM-DD date');
  return utcStartOfDay(value);
}

/** @param {any} options */
export function createMilestone({ directory, db: dbArg, actor, projectId, project, name, description = '', due, state, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  const projectRowValue = resolveMilestoneProject(db, projectId ?? project);
  const cleanName = cleanText(name, { path: 'name', min: 1, max: 100, singleLine: true });
  const cleanDescription = cleanText(description, { path: 'description', max: 20_000, trim: false });
  const dueAt = milestoneDue(due);
  const cleanState = milestoneState(state);
  return inTransaction({ directory, db }, () => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL').get(projectRowValue.id)) {
      throw invalid('projectId', 'Project is archived or unavailable');
    }
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ? AND archived_at IS NULL').get(projectRowValue.id).n) >= MILESTONE_LIMIT) {
      throw limitExceeded(`A project can have at most ${MILESTONE_LIMIT} active milestones`, 'projectId');
    }
    const id = newId();
    db.prepare(
      `INSERT INTO milestones (id, project_id, name, description, start_at, due_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(id, projectRowValue.id, cleanName, cleanDescription, dueAt, cleanState, now, now);
    return milestoneJson(milestoneRow(db, id));
  });
}

/** @param {any} options */
export function updateMilestone({ directory, db: dbArg, actor, milestoneId, patch, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch', 'Must be an object');
  const allowed = new Set(['name', 'description', 'due', 'state', 'archived']);
  for (const field of Object.keys(patch)) if (!allowed.has(field)) throw invalid(`patch.${field}`, 'Unsupported milestone field');
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw invalid('patch.archived', 'Must be true or false');
  return inTransaction({ directory, db }, () => {
    const row = milestoneRow(db, milestoneId);
    if (!row) throw notFound('Milestone not found', 'milestoneId');
    const next = {
      name: patch.name === undefined ? row.name : cleanText(patch.name, { path: 'patch.name', min: 1, max: 100, singleLine: true }),
      description: patch.description === undefined ? row.description : cleanText(patch.description, { path: 'patch.description', max: 20_000, trim: false }),
      dueAt: patch.due === undefined ? row.due_at ?? null : milestoneDue(patch.due, 'patch.due', true),
      state: milestoneState(patch.state, 'patch.state', row.state),
      archivedAt: patch.archived === undefined ? row.archived_at ?? null : (patch.archived ? (row.archived_at ?? now) : null),
    };
    if (row.archived_at != null && next.archivedAt == null && Number(db.prepare(
      'SELECT COUNT(*) AS n FROM milestones WHERE project_id = ? AND archived_at IS NULL',
    ).get(row.project_id).n) >= MILESTONE_LIMIT) {
      throw limitExceeded(`A project can have at most ${MILESTONE_LIMIT} active milestones`, 'milestoneId');
    }
    if (next.name === row.name && next.description === row.description && next.dueAt === (row.due_at ?? null) &&
      next.state === row.state && next.archivedAt === (row.archived_at ?? null)) return milestoneJson(row);
    db.prepare(
      `UPDATE milestones SET name = ?, description = ?, due_at = ?, state = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    ).run(next.name, next.description, next.dueAt, next.state, next.archivedAt, now, row.id);
    return milestoneJson(milestoneRow(db, row.id));
  });
}

/** @param {any} options */
export function archiveMilestone(options = {}) {
  return updateMilestone({ ...options, patch: { ...options.patch, archived: true } });
}

/** @param {any} options */
export function restoreMilestone(options = {}) {
  return updateMilestone({ ...options, patch: { ...options.patch, archived: false } });
}

/** @param {any} options */
export function listMilestones({ directory, db: dbArg, actor, projectId, includeArchived = false } = {}) {
  requireRead(actor);
  if (typeof includeArchived !== 'boolean') throw invalid('includeArchived', 'Must be true or false');
  const db = getDb({ directory, db: dbArg });
  const project = projectRow(db, projectId);
  if (!project) throw notFound('Project not found', 'projectId');
  const rows = db.prepare(
    `SELECT m.*, p.name AS project_name FROM milestones m
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE m.project_id = ? ${includeArchived ? '' : 'AND m.archived_at IS NULL'}
      ORDER BY m.due_at, m.name COLLATE NOCASE, m.id`,
  ).all(project.id);
  return rows.map(milestoneJson);
}

export const PROJECT_LIMITS = Object.freeze({ nameCodePoints: 100, markdownCodePoints: 20_000, activeProjects: PROJECT_LIMIT, activeMilestonesPerProject: MILESTONE_LIMIT });
