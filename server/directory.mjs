import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normaliseEmail } from './config.mjs';

export { normaliseEmail };

export const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const USER_ROLES = ['owner', 'admin', 'member', 'guest'];
const TEAM_ROLES = ['admin', 'member'];
const SHARE_ROLES = ['editor', 'commenter', 'viewer'];
const PRINCIPAL_TYPES = ['user', 'team'];
const DAY_MS = 24 * 60 * 60 * 1000;
const RANK_ROLE = { 4: 'owner', 3: 'editor', 2: 'commenter', 1: 'viewer' };

// A share role the CASE does not know ranks 0, which grants nothing.
const shareRank = (column) => `CASE ${column} WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END`;

export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX invites_team ON invites(team_id);
  CREATE TABLE login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX boards_owner ON boards(owner_id);
  CREATE INDEX boards_team ON boards(team_id);
  CREATE TABLE board_shares (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team')),
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    PRIMARY KEY (board_id, principal_type, principal_id)
  );
  CREATE INDEX board_shares_principal ON board_shares(principal_type, principal_id);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // SQLite cannot alter a CHECK constraint, so board_shares is rebuilt to allow the 'commenter' role.
  `
  CREATE TABLE board_shares_new (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team')),
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
    PRIMARY KEY (board_id, principal_type, principal_id)
  );
  INSERT INTO board_shares_new (board_id, principal_type, principal_id, role)
    SELECT board_id, principal_type, principal_id, role FROM board_shares;
  DROP TABLE board_shares;
  ALTER TABLE board_shares_new RENAME TO board_shares;
  CREATE INDEX board_shares_principal ON board_shares(principal_type, principal_id);
  `,
];

const newId = () => crypto.randomBytes(16).toString('base64url');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const validToken = (token) => typeof token === 'string' && token.length > 0 && token.length <= 256;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const toUser = (r) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: Boolean(r.disabled),
  createdAt: r.created_at,
});
const toTeam = (r) => ({ id: r.id, name: r.name, archived: Boolean(r.archived), createdAt: r.created_at });
const toBoard = (r) => ({
  id: r.id,
  title: r.title,
  ownerId: r.owner_id,
  teamId: r.team_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});
const toInvite = (r) => ({
  id: r.id,
  teamId: r.team_id,
  role: r.role,
  createdBy: r.created_by,
  expiresAt: r.expires_at,
  maxUses: r.max_uses,
  uses: r.uses,
  revoked: Boolean(r.revoked),
  createdAt: r.created_at,
});
const inviteActive = (invite, now) =>
  !invite.revoked && invite.expiresAt > now && (invite.maxUses == null || invite.uses < invite.maxUses);

function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > MIGRATIONS.length) {
    throw new Error(`directory was written by a newer Mira (schema ${version}, this build knows ${MIGRATIONS.length})`);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDirectory(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  migrate(db);

  /** @type {Map<string, import('node:sqlite').StatementSync>} */
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const get = (sql, ...params) => stmt(sql).get(...params);
  const all = (sql, ...params) => stmt(sql).all(...params);
  const run = (sql, ...params) => Number(stmt(sql).run(...params).changes);

  let closed = false;
  let depth = 0;
  function transaction(fn) {
    const nested = depth > 0;
    const savepoint = `sp${depth}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      else db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  // users

  function getUser(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM users WHERE id = ?', id) : undefined;
    return row ? toUser(row) : null;
  }

  function getUserByEmail(email) {
    const e = normaliseEmail(email);
    const row = e ? get('SELECT * FROM users WHERE email = ?', e) : undefined;
    return row ? toUser(row) : null;
  }

  function createUser(fields) {
    const { email, name, role } = fields;
    const e = normaliseEmail(email);
    if (!e) throw new Error('invalid email');
    if (!USER_ROLES.includes(role)) throw new Error('invalid role');
    const id = newId();
    run(
      'INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      id,
      e,
      text(name, 100) || e.split('@')[0],
      role,
      Date.now(),
    );
    return getUser(id);
  }

  const listUsers = () => all('SELECT * FROM users ORDER BY created_at, email').map(toUser);

  const countOwners = () => Number(get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").n);

  function updateUser(id, patch) {
    if (!getUser(id)) throw new Error('user not found');
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const name = text(patch.name, 100);
      if (!name) throw new Error('invalid name');
      sets.push('name = ?');
      params.push(name);
    }
    if (patch.role !== undefined) {
      if (!USER_ROLES.includes(patch.role)) throw new Error('invalid role');
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(patch.disabled ? 1 : 0);
    }
    transaction(() => {
      if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      if (patch.disabled) revokeUserSessions(id);
    });
    return getUser(id);
  }

  function removeUser(id) {
    const user = getUser(id);
    if (!user) return;
    transaction(() => {
      run('DELETE FROM login_tokens WHERE email = ?', user.email);
      run("DELETE FROM board_shares WHERE principal_type = 'user' AND principal_id = ?", id);
      run('DELETE FROM users WHERE id = ?', id);
    });
  }

  // login tokens

  function createLoginToken(fields) {
    const { email, inviteId, ttlMs, now = Date.now() } = fields;
    const e = normaliseEmail(email);
    if (!e) throw new Error('invalid email');
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    const token = newToken();
    run('DELETE FROM login_tokens WHERE expires_at < ?', now - DAY_MS);
    run(
      'INSERT INTO login_tokens (token_hash, email, invite_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      hashToken(token),
      e,
      inviteId ?? null,
      now + ttlMs,
      now,
    );
    return token;
  }

  function consumeLoginToken(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const hash = hashToken(token);
    return transaction(() => {
      const row = get('SELECT email, invite_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?', hash);
      if (!row || row.used_at != null || row.expires_at <= now) return null;
      const changed = run('UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now, hash);
      return changed === 1 ? { email: row.email, inviteId: row.invite_id } : null;
    });
  }

  // sessions

  function createSession(userId, { ttlMs, now = Date.now() }) {
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    const id = newId();
    const token = newToken();
    run('DELETE FROM sessions WHERE expires_at < ?', now - DAY_MS);
    run(
      'INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)',
      id,
      hashToken(token),
      userId,
      now,
      now,
      now + ttlMs,
    );
    return { id, token, expiresAt: now + ttlMs };
  }

  // expires_at - last_seen is the session lifetime: last_seen is only written when the expiry slides
  function getSession(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const row = get(
      `SELECT s.id AS session_id, s.last_seen, s.expires_at AS session_expires,
              u.id, u.email, u.name, u.role, u.disabled, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked = 0`,
      hashToken(token),
    );
    if (!row || row.session_expires <= now || row.disabled) return null;
    let expiresAt = row.session_expires;
    let extended = false;
    const lifetime = row.session_expires - row.last_seen;
    if (lifetime > 0 && expiresAt - now < lifetime / 2) {
      expiresAt = now + lifetime;
      run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', now, expiresAt, row.session_id);
      extended = true;
    }
    return { id: row.session_id, user: toUser(row), expiresAt, extended };
  }

  function revokeSession(id) {
    if (typeof id === 'string') run('UPDATE sessions SET revoked = 1 WHERE id = ?', id);
  }

  function revokeUserSessions(userId) {
    return run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', userId);
  }

  // teams

  function getTeam(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM teams WHERE id = ?', id) : undefined;
    return row ? toTeam(row) : null;
  }

  function createTeam({ name, creatorId }) {
    const clean = text(name, 100);
    if (!clean) throw new Error('invalid name');
    const id = newId();
    transaction(() => {
      run('INSERT INTO teams (id, name, archived, created_at) VALUES (?, ?, 0, ?)', id, clean, Date.now());
      run("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'admin')", id, creatorId);
    });
    return getTeam(id);
  }

  const withRole = (r) => ({ ...toTeam(r), role: r.role ?? null, memberCount: Number(r.member_count) });
  const TEAM_COLUMNS = `t.id, t.name, t.archived, t.created_at, tm.role,
    (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count`;

  function listTeamsFor(userId) {
    return all(
      `SELECT ${TEAM_COLUMNS} FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        ORDER BY t.name COLLATE NOCASE, t.created_at`,
      userId,
    ).map(withRole);
  }

  function listAllTeams(forUserId) {
    return all(
      `SELECT ${TEAM_COLUMNS} FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        ORDER BY t.name COLLATE NOCASE, t.created_at`,
      forUserId ?? null,
    ).map(withRole);
  }

  function updateTeam(id, patch) {
    if (!getTeam(id)) throw new Error('team not found');
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const name = text(patch.name, 100);
      if (!name) throw new Error('invalid name');
      sets.push('name = ?');
      params.push(name);
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      params.push(patch.archived ? 1 : 0);
    }
    if (sets.length) run(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return getTeam(id);
  }

  function addTeamMember(teamId, userId, role) {
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    run(
      'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role',
      teamId,
      userId,
      role,
    );
  }

  function removeTeamMember(teamId, userId) {
    run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  }

  function setTeamRole(teamId, userId, role) {
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    if (run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId) === 0) {
      throw new Error('not a team member');
    }
  }

  function getTeamRole(teamId, userId) {
    if (typeof teamId !== 'string' || typeof userId !== 'string') return null;
    return get('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId)?.role ?? null;
  }

  function listTeamMembers(teamId) {
    return all(
      `SELECT u.id, u.name, u.email, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY u.name COLLATE NOCASE, u.email`,
      teamId,
    ).map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role }));
  }

  const countTeamAdmins = (teamId) =>
    Number(get("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'", teamId).n);

  // invites

  function createInvite(fields) {
    const { teamId, role, createdBy, ttlMs, maxUses, now = Date.now() } = fields;
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    if (maxUses != null && !(Number.isInteger(maxUses) && maxUses > 0)) throw new Error('invalid maxUses');
    const id = newId();
    const token = newToken();
    run(
      `INSERT INTO invites (id, token_hash, team_id, role, created_by, expires_at, max_uses, uses, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      id,
      hashToken(token),
      teamId,
      role,
      createdBy ?? null,
      now + ttlMs,
      maxUses ?? null,
      now,
    );
    return { id, token, expiresAt: now + ttlMs };
  }

  function findInvite(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const row = get('SELECT * FROM invites WHERE token_hash = ?', hashToken(token));
    const invite = row ? toInvite(row) : null;
    return invite && inviteActive(invite, now) ? invite : null;
  }

  function findInviteById(id, now = Date.now()) {
    if (typeof id !== 'string') return null;
    const row = get('SELECT * FROM invites WHERE id = ?', id);
    const invite = row ? toInvite(row) : null;
    return invite && inviteActive(invite, now) ? invite : null;
  }

  function recordInviteUse(id) {
    run('UPDATE invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)', id);
  }

  function listInvites(teamId, now = Date.now()) {
    return all('SELECT * FROM invites WHERE team_id = ? ORDER BY created_at DESC, id', teamId)
      .map(toInvite)
      .filter((invite) => inviteActive(invite, now));
  }

  function revokeInvite(id) {
    run('UPDATE invites SET revoked = 1 WHERE id = ?', id);
  }

  // boards

  function getBoard(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM boards WHERE id = ?', id) : undefined;
    return row ? toBoard(row) : null;
  }
  const boardTitle = (title) => text(title, 200) || 'Untitled board';

  function createBoard(fields) {
    const { id, title, ownerId, teamId } = fields;
    if (typeof id !== 'string' || !BOARD_ID_RE.test(id)) throw new Error('invalid board id');
    if (typeof ownerId !== 'string') throw new Error('board needs an owner');
    const now = Date.now();
    run(
      'INSERT INTO boards (id, title, owner_id, team_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      id,
      boardTitle(title),
      ownerId,
      teamId ?? null,
      now,
      now,
    );
    return getBoard(id);
  }

  function updateBoard(id, patch) {
    if (!getBoard(id)) throw new Error('board not found');
    const sets = ['updated_at = ?'];
    const params = [Date.now()];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(boardTitle(patch.title));
    }
    if (patch.teamId !== undefined) {
      sets.push('team_id = ?');
      params.push(patch.teamId);
    }
    run(`UPDATE boards SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return getBoard(id);
  }

  function deleteBoard(id) {
    run('UPDATE boards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), id);
  }

  // the title comes straight from a client-controlled document, so it is bounded like every other title
  function touchBoard(id, fields) {
    const title = fields?.title;
    if (typeof id !== 'string') return;
    if (title === undefined) run('UPDATE boards SET updated_at = ? WHERE id = ?', Date.now(), id);
    else run('UPDATE boards SET updated_at = ?, title = ? WHERE id = ?', Date.now(), boardTitle(title), id);
  }

  // Guests only ever see boards shared with them, so team membership grants them nothing.
  function boardRole(boardId, userId) {
    const user = getUser(userId);
    if (!user || user.disabled) return null;
    const board = getBoard(boardId);
    if (!board) return null;
    if (user.role === 'owner' || user.role === 'admin') return 'owner';
    if (board.deletedAt != null) return null;
    if (board.ownerId === user.id) return 'owner';
    let rank = 0;
    if (board.teamId && user.role !== 'guest') {
      const teamRole = getTeamRole(board.teamId, user.id);
      if (teamRole === 'admin') return 'owner';
      if (teamRole === 'member') rank = 3;
    }
    const shared = get(
      `SELECT MAX(${shareRank('role')}) AS rank FROM board_shares
        WHERE board_id = ? AND (
          (principal_type = 'user' AND principal_id = ?)
          OR (principal_type = 'team' AND principal_id IN (SELECT team_id FROM team_members WHERE user_id = ?)))`,
      board.id,
      user.id,
      user.id,
    );
    return RANK_ROLE[Math.max(rank, Number(shared.rank ?? 0))] ?? null;
  }

  function listBoardsFor(user) {
    const current = getUser(user?.id);
    if (!current || current.disabled) return [];
    if (current.role === 'owner' || current.role === 'admin') {
      return all('SELECT * FROM boards WHERE deleted_at IS NULL ORDER BY updated_at DESC, id').map((r) => ({
        ...toBoard(r),
        role: 'owner',
      }));
    }
    const rows = all(
      `SELECT * FROM (
         SELECT b.*, MAX(
           CASE WHEN b.owner_id = $uid THEN 4 ELSE 0 END,
           CASE WHEN $member = 1 THEN CASE tm.role WHEN 'admin' THEN 4 WHEN 'member' THEN 3 ELSE 0 END ELSE 0 END,
           COALESCE((SELECT MAX(${shareRank('s.role')}) FROM board_shares s
                      WHERE s.board_id = b.id AND (
                        (s.principal_type = 'user' AND s.principal_id = $uid)
                        OR (s.principal_type = 'team' AND s.principal_id IN (SELECT team_id FROM team_members WHERE user_id = $uid)))), 0)
         ) AS level
           FROM boards b LEFT JOIN team_members tm ON tm.team_id = b.team_id AND tm.user_id = $uid
          WHERE b.deleted_at IS NULL
       ) WHERE level > 0 ORDER BY updated_at DESC, id`,
      { uid: current.id, member: current.role === 'guest' ? 0 : 1 },
    );
    return rows.map((r) => ({ ...toBoard(r), role: RANK_ROLE[r.level] }));
  }

  function shareBoard(boardId, { principalType, principalId, role }) {
    if (!PRINCIPAL_TYPES.includes(principalType)) throw new Error('invalid principal type');
    if (!SHARE_ROLES.includes(role)) throw new Error('invalid role');
    if (!(principalType === 'user' ? getUser(principalId) : getTeam(principalId))) throw new Error('principal not found');
    run(
      `INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (board_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
      boardId,
      principalType,
      principalId,
      role,
    );
  }

  function unshareBoard(boardId, principalType, principalId) {
    run('DELETE FROM board_shares WHERE board_id = ? AND principal_type = ? AND principal_id = ?', boardId, principalType, principalId);
  }

  function listShares(boardId) {
    return all(
      `SELECT s.principal_type, s.principal_id, s.role,
              CASE s.principal_type WHEN 'user' THEN u.name ELSE t.name END AS name
         FROM board_shares s
         LEFT JOIN users u ON s.principal_type = 'user' AND u.id = s.principal_id
         LEFT JOIN teams t ON s.principal_type = 'team' AND t.id = s.principal_id
        WHERE s.board_id = ? ORDER BY s.principal_type, name COLLATE NOCASE, s.principal_id`,
      boardId,
    ).map((r) => ({ principalType: r.principal_type, principalId: r.principal_id, name: r.name, role: r.role }));
  }

  // audit

  function audit(actorId, action, detail = {}) {
    run('INSERT INTO audit (ts, actor_id, action, detail) VALUES (?, ?, ?, ?)', Date.now(), actorId ?? null, action, JSON.stringify(detail ?? {}));
  }

  function listAudit(limit = 100) {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
    return all('SELECT id, ts, actor_id, action, detail FROM audit ORDER BY id DESC LIMIT ?', n).map((r) => ({
      id: r.id,
      ts: r.ts,
      actorId: r.actor_id,
      action: r.action,
      detail: JSON.parse(r.detail),
    }));
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      db.close();
    },
    transaction,
    createUser,
    getUser,
    getUserByEmail,
    listUsers,
    countOwners,
    updateUser,
    removeUser,
    createLoginToken,
    consumeLoginToken,
    createSession,
    getSession,
    revokeSession,
    revokeUserSessions,
    createTeam,
    getTeam,
    listTeamsFor,
    listAllTeams,
    updateTeam,
    addTeamMember,
    removeTeamMember,
    setTeamRole,
    getTeamRole,
    listTeamMembers,
    countTeamAdmins,
    createInvite,
    findInvite,
    findInviteById,
    recordInviteUse,
    listInvites,
    revokeInvite,
    createBoard,
    getBoard,
    listBoardsFor,
    updateBoard,
    deleteBoard,
    touchBoard,
    boardRole,
    shareBoard,
    unshareBoard,
    listShares,
    audit,
    listAudit,
  };
}
