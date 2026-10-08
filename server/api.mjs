// HTTP API of accounts mode (see docs/accounts.md). Every permission rule lives here, server side:
// the client only mirrors it. Handlers are synchronous after the body is read, so each
// check-then-act sequence runs without interleaving with another request.

import fs from 'node:fs';
import { BOARD_ID_RE } from './directory.mjs';
import { SeatLimitError } from './auth.mjs';
import { CloudError, addsSeat, validateLimits, validateNotify } from './cloud.mjs';
import { createMailer } from './mailer.mjs';
import { MAX_ACTIVE_TOKENS, MAX_TOKEN_BOARDS, SCOPES, TOKEN_BOARD_ID_RE } from './tokens.mjs';

const MAX_BODY = 64 * 1024;
const DRAIN_LIMIT = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ROLES = ['owner', 'admin', 'member', 'guest'];
const TEAM_ROLES = ['admin', 'member'];
const SHARE_ROLES = ['editor', 'commenter', 'viewer'];
const TOKEN_FIELDS = ['name', 'scope', 'boardIds', 'days'];
const PRINCIPAL_TYPES = ['user', 'team'];
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CONTROL_RE = /\p{Cc}/u;
const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;
const AUDIT_MAX_ACTION = 100;

const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
})();

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'bad_request', message);
const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
const conflict = (code, message) => new HttpError(409, code, message);

const isAdmin = (user) => user.role === 'owner' || user.role === 'admin';
const userView = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const boardView = (b, role) => ({
  id: b.id,
  title: b.title,
  teamId: b.teamId,
  ownerId: b.ownerId ?? null,
  role,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

function cleanText(value, field, min, max) {
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`);
  const text = value.trim();
  if (text.length < min || text.length > max || CONTROL_RE.test(text)) {
    throw badRequest(`${field} must be ${min === 0 ? 'at most' : `${min} to`} ${max} characters, without control characters`);
  }
  return text;
}

function oneOf(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function idField(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw badRequest(`${field} must be an id`);
  return value;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tooLarge = () => new HttpError(413, 'payload_too_large', 'The request body is too large');

    if (Number(req.headers['content-length']) > DRAIN_LIMIT) {
      req.resume();
      done(reject, tooLarge());
      return;
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > DRAIN_LIMIT) done(reject, tooLarge());
    });
    req.on('end', () => {
      if (size > MAX_BODY) return done(reject, tooLarge());
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done(resolve, {});
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return done(reject, badRequest('The request body is not valid JSON'));
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return done(reject, badRequest('The request body must be a JSON object'));
      }
      done(resolve, data);
    });
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, new HttpError(400, 'bad_request', 'The request was aborted')));
  });
}

function compile(method, pattern, options, handler) {
  return { method, parts: pattern.split('/'), handler, ...options };
}

export function createApi({ directory, auth, config, roomExists, events, liveStats = () => ({ rooms: 0, connections: 0 }), cloud = null, history = null, mailer = createMailer(config) }) {
  const emit = (name, payload) => {
    try {
      events.emit(name, payload);
    } catch (err) {
      console.error(`api: listener for ${name} failed:`, err?.message ?? err);
    }
  };
  const audit = (user, action, detail) => directory.audit(user.id, action, detail);

  function clientIp(req) {
    if (config.trustProxy) {
      const header = req.headers['x-forwarded-for'];
      const entries = String(Array.isArray(header) ? header.join(',') : (header ?? ''))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (entries.length) return entries[entries.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // Teams a caller cannot see do not exist for them (404); visible but not manageable is 403.
  function teamFor(user, id, { manage = false } = {}) {
    const team = directory.getTeam(id);
    const role = team ? directory.getTeamRole(team.id, user.id) : null;
    if (!team || (role === null && !isAdmin(user))) throw notFound('Team not found');
    if (manage && role !== 'admin' && !isAdmin(user)) throw forbidden('Only team admins can do that');
    return { team, role };
  }

  function teamView(teamId, userId) {
    const team = directory.getTeam(teamId);
    return {
      id: team.id,
      name: team.name,
      role: directory.getTeamRole(teamId, userId),
      memberCount: directory.listTeamMembers(teamId).length,
      archived: team.archived,
    };
  }

  // Deleted boards are gone for every API call, workspace admins included.
  function boardFor(user, id, { own = false } = {}) {
    const board = directory.getBoard(id);
    const role = board && board.deletedAt == null ? directory.boardRole(board.id, user.id) : null;
    if (!board || role === null) throw notFound('Board not found');
    if (own && role !== 'owner') throw forbidden('Only the board owner can do that');
    return { board, role };
  }

  const requireAdmin = (user) => {
    if (!isAdmin(user)) throw forbidden('Only workspace admins can do that');
  };

  // The users and teams a caller may learn about: themselves, their teams and the people in them.
  function visiblePrincipals(user) {
    if (isAdmin(user)) return null;
    const teams = new Set();
    const users = new Set([user.id]);
    for (const team of directory.listTeamsFor(user.id)) {
      teams.add(team.id);
      for (const member of directory.listTeamMembers(team.id)) users.add(member.userId);
    }
    return { teams, users };
  }

  const canSee = (visible, type, id) => visible === null || (type === 'team' ? visible.teams : visible.users).has(id);

  const hasOtherActiveOwner = (userId) => directory.listUsers().some((u) => u.id !== userId && u.role === 'owner' && !u.disabled);

  // Acting on an owner is for owners, the same rule as PATCH and DELETE /api/members/:id.
  const guardOwner = (user, target, action) => {
    if (target.role === 'owner' && user.role !== 'owner') throw forbidden(`Only an owner can ${action} an owner`);
  };

  const memberView = (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled,
    teams: directory.listTeamsFor(u.id).map((t) => ({ id: t.id, name: t.name, role: t.role })),
  });

  const tokenView = (t) => ({
    id: t.id,
    name: t.name,
    scope: t.scope,
    boardIds: t.boardIds,
    hint: t.hint,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
  });

  // Hosted workspaces (docs/cloud.md): the message names the limit so an admin knows what to do about it.
  const seatLimited = (problem) =>
    conflict('seat_limit', `All ${cloud.limits().seatLimit} seats are in use, so ${problem}. Remove or disable someone, or ask the workspace owner to add seats under billing.`);

  // ------------------------------------------------------------ handlers

  const routes = [
    compile('GET', 'config', { public: true }, () => [200, { authEnabled: config.authEnabled }]),

    compile('GET', 'me', {}, ({ user }) => [
      200,
      {
        user: userView(user),
        teams: directory.listTeamsFor(user.id).map((t) => ({ id: t.id, name: t.name, role: t.role })),
        ...(cloud ? { workspace: cloud.workspaceView() } : {}),
        ...(config.mcp ? { mcp: true } : {}),
      },
    ]),
    compile('PATCH', 'me', { body: true }, ({ user, body }) => {
      const name = cleanText(body.name, 'name', 1, 80);
      const updated = directory.transaction(() => {
        const next = directory.updateUser(user.id, { name });
        audit(user, 'me.update', {});
        return next;
      });
      return [200, userView(updated)];
    }),

    compile('POST', 'auth/request', { public: true, body: true, readOnlyOk: true }, async ({ req, res, body }) => {
      const { email, invite } = body;
      if (typeof email !== 'string' || email.length > 320) throw badRequest('email must be a string');
      if (invite != null && (typeof invite !== 'string' || invite.length > 256)) throw badRequest('invite must be a string');
      const result = await auth.requestLogin({ email, invite: invite ?? undefined, ip: clientIp(req) });
      if (result.limited) {
        res.setHeader('retry-after', '3600');
        throw new HttpError(429, 'rate_limited', 'Too many sign-in requests. Try again later.');
      }
      return [200, { ok: true }];
    }),
    compile('POST', 'auth/verify', { public: true, body: true, readOnlyOk: true }, ({ req, res, body }) => {
      let result = null;
      try {
        result = typeof body.token === 'string' ? auth.verifyLogin(body.token, { userAgent: req.headers['user-agent'] }) : null;
      } catch (err) {
        if (!(err instanceof SeatLimitError)) throw err;
        throw conflict('seat_limit', 'This workspace has no free seat right now. Ask the workspace owner to add seats, then open this link again.');
      }
      if (!result) throw new HttpError(400, 'invalid_token', 'This link has expired. Request a new one.');
      res.setHeader('set-cookie', auth.sessionCookie(result.sessionToken, result.maxAgeMs));
      directory.audit(result.user.id, 'auth.login', {});
      if (cloud) emit('usage-changed');
      return [200, { user: userView(result.user) }];
    }),
    compile('POST', 'auth/logout', { readOnlyOk: true }, ({ res, user, sessionId }) => {
      auth.logout(sessionId);
      audit(user, 'auth.logout', {});
      res.setHeader('set-cookie', auth.clearCookie());
      emit('session-revoked', { userId: user.id, sessionId });
      return [204];
    }),
    compile('POST', 'auth/logout-all', { readOnlyOk: true }, ({ res, user }) => {
      auth.logoutAll(user.id);
      audit(user, 'auth.logout_all', {});
      res.setHeader('set-cookie', auth.clearCookie());
      emit('session-revoked', { userId: user.id });
      return [204];
    }),

    compile('GET', 'teams', {}, ({ user }) => {
      const teams = isAdmin(user) ? directory.listAllTeams(user.id) : directory.listTeamsFor(user.id);
      return [200, teams.map((t) => ({ id: t.id, name: t.name, role: t.role, memberCount: t.memberCount, archived: t.archived }))];
    }),
    compile('POST', 'teams', { body: true }, ({ user, body }) => {
      if (user.role === 'guest') throw forbidden('Guests cannot create teams');
      const name = cleanText(body.name, 'name', 1, 80);
      const team = directory.transaction(() => {
        const created = directory.createTeam({ name, creatorId: user.id });
        audit(user, 'team.create', { teamId: created.id, name });
        return created;
      });
      return [201, teamView(team.id, user.id)];
    }),
    compile('PATCH', 'teams/:id', { body: true }, ({ user, params, body }) => {
      const { team } = teamFor(user, params.id, { manage: true });
      const patch = {};
      if (body.name !== undefined) patch.name = cleanText(body.name, 'name', 1, 80);
      if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw badRequest('archived must be a boolean');
        patch.archived = body.archived;
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      directory.transaction(() => {
        directory.updateTeam(team.id, patch);
        audit(user, 'team.update', { teamId: team.id, ...patch });
      });
      return [200, teamView(team.id, user.id)];
    }),
    compile('GET', 'teams/:id/members', {}, ({ user, params }) => {
      const { team } = teamFor(user, params.id);
      return [200, directory.listTeamMembers(team.id)];
    }),
    compile('PATCH', 'teams/:id/members/:userId', { body: true }, ({ user, params, body }) => {
      const { team } = teamFor(user, params.id, { manage: true });
      const role = oneOf(body.role, TEAM_ROLES, 'role');
      const current = directory.getTeamRole(team.id, params.userId);
      if (current === null) throw notFound('Member not found');
      if (current === 'admin' && role === 'member' && directory.countTeamAdmins(team.id) <= 1) {
        throw conflict('last_admin', 'A team needs at least one admin');
      }
      directory.transaction(() => {
        directory.setTeamRole(team.id, params.userId, role);
        audit(user, 'team.member.role', { teamId: team.id, userId: params.userId, role });
      });
      emit('access-changed', { userId: params.userId });
      return [200, directory.listTeamMembers(team.id).find((m) => m.userId === params.userId)];
    }),
    compile('DELETE', 'teams/:id/members/:userId', {}, ({ user, params }) => {
      const { team, role: mine } = teamFor(user, params.id);
      const leaving = params.userId === user.id;
      if (!leaving && mine !== 'admin' && !isAdmin(user)) throw forbidden('Only team admins can remove members');
      const current = directory.getTeamRole(team.id, params.userId);
      if (current === null) throw notFound('Member not found');
      if (current === 'admin' && directory.countTeamAdmins(team.id) <= 1) {
        throw conflict('last_admin', 'A team needs at least one admin');
      }
      directory.transaction(() => {
        directory.removeTeamMember(team.id, params.userId);
        audit(user, leaving ? 'team.leave' : 'team.member.remove', { teamId: team.id, userId: params.userId });
      });
      emit('access-changed', { userId: params.userId });
      return [204];
    }),

    compile('POST', 'teams/:id/invites', { body: true }, ({ user, params, body }) => {
      const { team } = teamFor(user, params.id, { manage: true });
      const role = body.role === undefined ? 'member' : oneOf(body.role, TEAM_ROLES, 'role');
      const days = body.days === undefined ? 7 : body.days;
      if (!Number.isInteger(days) || days < 1 || days > 30) throw badRequest('days must be a whole number from 1 to 30');
      if (cloud && !cloud.seatsAvailable()) throw seatLimited('new invite links cannot be created');
      const invite = directory.transaction(() => {
        const created = directory.createInvite({ teamId: team.id, role, createdBy: user.id, ttlMs: days * DAY_MS });
        audit(user, 'invite.create', { teamId: team.id, inviteId: created.id, role, days });
        return created;
      });
      return [
        201,
        { id: invite.id, url: `${config.baseUrl}/#/invite/${invite.token}`, token: invite.token, expiresAt: invite.expiresAt },
      ];
    }),
    compile('GET', 'teams/:id/invites', {}, ({ user, params }) => {
      const { team } = teamFor(user, params.id, { manage: true });
      return [
        200,
        directory.listInvites(team.id).map((i) => ({ id: i.id, role: i.role, expiresAt: i.expiresAt, uses: i.uses, maxUses: i.maxUses })),
      ];
    }),
    compile('DELETE', 'teams/:id/invites/:inviteId', {}, ({ user, params }) => {
      const { team } = teamFor(user, params.id, { manage: true });
      const invite = directory.listInvites(team.id).find((i) => i.id === params.inviteId);
      if (!invite) throw notFound('Invite not found');
      directory.transaction(() => {
        directory.revokeInvite(invite.id);
        audit(user, 'invite.revoke', { teamId: team.id, inviteId: invite.id });
      });
      return [204];
    }),
    compile('GET', 'invites/:token', { public: true }, ({ params }) => {
      const invite = directory.findInvite(params.token);
      const team = invite ? directory.getTeam(invite.teamId) : null;
      if (!invite || !team) throw notFound('This invite is not valid');
      return [200, { team: { id: team.id, name: team.name }, role: invite.role }];
    }),
    compile('POST', 'invites/:token/accept', {}, ({ user, params }) => {
      const invite = directory.findInvite(params.token);
      const team = invite ? directory.getTeam(invite.teamId) : null;
      if (!invite || !team) throw notFound('This invite is not valid');
      let role = directory.getTeamRole(team.id, user.id);
      if (role === null || (role === 'member' && invite.role === 'admin')) {
        role = invite.role;
        directory.transaction(() => {
          directory.addTeamMember(team.id, user.id, role);
          directory.recordInviteUse(invite.id);
          audit(user, 'invite.accept', { teamId: team.id, inviteId: invite.id, role });
        });
        emit('access-changed', { userId: user.id });
      }
      return [200, { team: { id: team.id, name: team.name }, role }];
    }),

    compile('GET', 'boards', {}, ({ user }) => [200, directory.listBoardsFor(user).map((b) => boardView(b, b.role))]),
    compile('POST', 'boards', { body: true }, ({ user, body }) => {
      if (typeof body.id !== 'string' || !BOARD_ID_RE.test(body.id)) throw badRequest('id must be 1 to 64 letters, digits, - or _');
      const title = body.title == null ? undefined : cleanText(body.title, 'title', 0, 200);
      const teamId = body.teamId == null ? null : idField(body.teamId, 'teamId');
      if (user.role === 'guest') throw forbidden('Guests cannot create boards');
      if (teamId !== null && directory.getTeamRole(teamId, user.id) === null) throw forbidden('You are not a member of that team');
      if (directory.getBoard(body.id)) throw conflict('exists', 'A board with this id already exists');
      const adopting = roomExists(body.id);
      if (adopting && !isAdmin(user)) {
        throw conflict('needs_admin', 'This board already exists on the server. Ask a workspace admin to add it.');
      }
      const board = directory.transaction(() => {
        const created = directory.createBoard({ id: body.id, title, ownerId: user.id, teamId });
        audit(user, 'board.create', { boardId: created.id, teamId, adopted: adopting });
        return created;
      });
      return [201, boardView(board, directory.boardRole(board.id, user.id))];
    }),
    compile('PATCH', 'boards/:id', { body: true }, ({ user, params, body }) => {
      const { board } = boardFor(user, params.id, { own: true });
      const patch = {};
      if (body.title !== undefined) patch.title = cleanText(body.title, 'title', 0, 200);
      if (body.teamId !== undefined) {
        patch.teamId = body.teamId === null ? null : idField(body.teamId, 'teamId');
        if (patch.teamId !== null && directory.getTeamRole(patch.teamId, user.id) === null) {
          throw forbidden('You are not a member of that team');
        }
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      const updated = directory.transaction(() => {
        const next = directory.updateBoard(board.id, patch);
        audit(user, 'board.update', { boardId: board.id, ...patch });
        return next;
      });
      if (patch.teamId !== undefined && patch.teamId !== board.teamId) emit('access-changed', { boardId: board.id });
      if (patch.title !== undefined) emit('board-renamed', { boardId: board.id, title: updated.title });
      return [200, boardView(updated, directory.boardRole(board.id, user.id))];
    }),
    compile('DELETE', 'boards/:id', {}, ({ user, params }) => {
      const { board } = boardFor(user, params.id, { own: true });
      directory.transaction(() => {
        directory.deleteBoard(board.id);
        audit(user, 'board.delete', { boardId: board.id });
      });
      emit('access-changed', { boardId: board.id });
      return [204];
    }),

    compile('GET', 'boards/:id/shares', {}, ({ user, params }) => {
      const { board } = boardFor(user, params.id, { own: true });
      const visible = visiblePrincipals(user);
      return [200, directory.listShares(board.id).filter((s) => canSee(visible, s.principalType, s.principalId))];
    }),
    compile('POST', 'boards/:id/shares', { body: true }, ({ user, params, body }) => {
      const { board } = boardFor(user, params.id, { own: true });
      const principalType = oneOf(body.principalType, PRINCIPAL_TYPES, 'principalType');
      const principalId = idField(body.principalId, 'principalId');
      const role = oneOf(body.role, SHARE_ROLES, 'role');
      const exists = principalType === 'team' ? directory.getTeam(principalId) : directory.getUser(principalId);
      if (!exists || !canSee(visiblePrincipals(user), principalType, principalId)) throw notFound('Unknown user or team');
      directory.transaction(() => {
        directory.shareBoard(board.id, { principalType, principalId, role });
        audit(user, 'board.share', { boardId: board.id, principalType, principalId, role });
      });
      emit('access-changed', { boardId: board.id });
      const share = directory.listShares(board.id).find((s) => s.principalType === principalType && s.principalId === principalId);
      return [201, share];
    }),
    compile('DELETE', 'boards/:id/shares/:principalType/:principalId', {}, ({ user, params }) => {
      const { board } = boardFor(user, params.id, { own: true });
      const principalType = oneOf(params.principalType, PRINCIPAL_TYPES, 'principalType');
      directory.transaction(() => {
        directory.unshareBoard(board.id, principalType, params.principalId);
        audit(user, 'board.unshare', { boardId: board.id, principalType, principalId: params.principalId });
      });
      emit('access-changed', { boardId: board.id });
      return [204];
    }),

    compile('GET', 'members', {}, ({ user }) => {
      requireAdmin(user);
      return [200, directory.listUsers().map(memberView)];
    }),
    compile('PATCH', 'members/:id', { body: true }, ({ user, params, body }) => {
      requireAdmin(user);
      const target = directory.getUser(params.id);
      if (!target) throw notFound('Member not found');
      const patch = {};
      if (body.role !== undefined) patch.role = oneOf(body.role, USER_ROLES, 'role');
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== 'boolean') throw badRequest('disabled must be a boolean');
        patch.disabled = body.disabled;
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      if ((target.role === 'owner' || patch.role === 'owner') && user.role !== 'owner') {
        throw forbidden('Only an owner can change an owner or grant the owner role');
      }
      const stopsBeingOwner = (patch.role !== undefined && patch.role !== 'owner') || patch.disabled === true;
      if (target.role === 'owner' && !target.disabled && stopsBeingOwner && !hasOtherActiveOwner(target.id)) {
        throw conflict('last_owner', 'The workspace needs at least one active owner');
      }
      if (cloud && addsSeat(target, patch) && !cloud.seatsAvailable()) throw seatLimited('this change would take another seat');
      const updated = directory.transaction(() => {
        const next = directory.updateUser(target.id, patch);
        audit(user, 'member.update', { userId: target.id, ...patch });
        return next;
      });
      emit('access-changed', { userId: target.id });
      if (patch.disabled === true) emit('session-revoked', { userId: target.id });
      if (cloud) emit('usage-changed');
      return [200, memberView(updated)];
    }),
    compile('DELETE', 'members/:id', {}, ({ user, params }) => {
      requireAdmin(user);
      const target = directory.getUser(params.id);
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner') {
        if (user.role !== 'owner') throw forbidden('Only an owner can remove an owner');
        if (!hasOtherActiveOwner(target.id)) throw conflict('last_owner', 'The workspace needs at least one active owner');
      }
      directory.transaction(() => {
        audit(user, 'member.remove', { userId: target.id, email: target.email });
        directory.removeUser(target.id);
      });
      emit('user-removed', { userId: target.id });
      if (cloud) emit('usage-changed');
      return [204];
    }),

    // ---------------------------------------------------------- admin console (docs/admin.md)

    compile('GET', 'admin/overview', {}, ({ user }) => {
      requireAdmin(user);
      const live = liveStats();
      return [
        200,
        {
          ...directory.adminStats(),
          live: { rooms: live.rooms, connections: live.connections },
          instance: { authEnabled: true, baseUrl: config.baseUrl, mail: config.mail.mode, version: VERSION },
        },
      ];
    }),

    compile('GET', 'admin/members', {}, ({ user }) => {
      requireAdmin(user);
      return [
        200,
        directory.listMembersAdmin().map((u) => ({
          ...memberView(u),
          createdAt: u.createdAt,
          lastSeenAt: u.lastSeenAt,
          activeSessions: u.activeSessions,
          boardCount: u.boardCount,
        })),
      ];
    }),
    compile('POST', 'admin/members/:id/revoke-sessions', {}, ({ res, user, params }) => {
      requireAdmin(user);
      const target = directory.getUser(params.id);
      if (!target) throw notFound('Member not found');
      guardOwner(user, target, 'sign out');
      directory.transaction(() => {
        const count = directory.revokeUserSessions(target.id);
        audit(user, 'admin.sessions.revoke', { userId: target.id, count });
      });
      if (target.id === user.id) res.setHeader('set-cookie', auth.clearCookie());
      emit('session-revoked', { userId: target.id });
      return [204];
    }),

    compile('GET', 'admin/sessions', {}, ({ user, sessionId }) => {
      requireAdmin(user);
      return [200, directory.listActiveSessions().map((s) => ({ ...s, current: s.id === sessionId }))];
    }),
    compile('DELETE', 'admin/sessions/:id', {}, ({ res, user, params, sessionId }) => {
      requireAdmin(user);
      const session = directory.getActiveSession(params.id);
      const target = session ? directory.getUser(session.userId) : null;
      if (!session || !target) throw notFound('Session not found');
      guardOwner(user, target, 'sign out');
      directory.transaction(() => {
        directory.revokeSession(session.id);
        audit(user, 'admin.session.revoke', { sessionId: session.id, userId: target.id });
      });
      if (session.id === sessionId) res.setHeader('set-cookie', auth.clearCookie());
      emit('session-revoked', { userId: target.id, sessionId: session.id });
      return [204];
    }),

    compile('GET', 'admin/boards', {}, ({ user, query }) => {
      requireAdmin(user);
      const deleted = query.get('deleted');
      return [200, directory.listBoardsAdmin({ includeDeleted: deleted === '1' || deleted === 'true' })];
    }),
    compile('GET', 'admin/boards/:id', {}, ({ user, params }) => {
      requireAdmin(user);
      const board = directory.getBoardAdmin(params.id);
      if (!board) throw notFound('Board not found');
      return [200, board];
    }),
    compile('POST', 'admin/boards/:id/restore', {}, ({ user, params }) => {
      requireAdmin(user);
      const board = directory.getBoardAdmin(params.id);
      if (!board) throw notFound('Board not found');
      if (board.deletedAt == null) throw conflict('not_deleted', 'This board is not deleted');
      const restored = directory.transaction(() => {
        directory.restoreBoard(board.id);
        audit(user, 'board.restore', { boardId: board.id });
        return directory.getBoardAdmin(board.id);
      });
      // admins who had it open while it was deleted may write again
      emit('access-changed', { boardId: board.id });
      return [200, { ...restored, role: directory.boardRole(board.id, user.id) }];
    }),

    compile('GET', 'admin/audit', {}, ({ user, query }) => {
      requireAdmin(user);
      const rawLimit = query.get('limit');
      const limit = rawLimit === null || rawLimit.trim() === '' ? Number.NaN : Math.trunc(Number(rawLimit));
      const rawBefore = query.get('before');
      if (rawBefore !== null && rawBefore !== '' && !/^\d{1,15}$/.test(rawBefore)) throw badRequest('before must be an entry id');
      const action = query.get('action') ?? '';
      if (action.length > AUDIT_MAX_ACTION) throw badRequest(`action must be at most ${AUDIT_MAX_ACTION} characters`);
      return [
        200,
        directory.listAuditPage({
          limit: Number.isNaN(limit) ? AUDIT_DEFAULT_LIMIT : Math.min(Math.max(limit, 1), AUDIT_MAX_LIMIT),
          before: rawBefore ? Number(rawBefore) : null,
          action,
        }),
      ];
    }),

    // ---------------------------------------------------------- version history (docs/history.md)

    ...(history ? history.routes({ compile, boardFor, audit, errors: { HttpError, forbidden } }) : []),

    // ---------------------------------------------------------- MCP access tokens (docs/mcp.md)

    ...(config.mcp?.mode === 'accounts'
      ? [
          compile('GET', 'me/tokens', {}, ({ user }) => [200, directory.listAccessTokens(user.id).map(tokenView)]),
          compile('POST', 'me/tokens', { body: true }, ({ user, body }) => {
            for (const key of Object.keys(body)) {
              if (!TOKEN_FIELDS.includes(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
            }
            const name = cleanText(body.name, 'name', 1, 80);
            const scope = oneOf(body.scope, SCOPES, 'scope');
            const days = body.days === undefined ? 30 : body.days;
            if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest('days must be a whole number from 1 to 365');
            let boardIds = null;
            if (body.boardIds !== undefined && body.boardIds !== null) {
              const ids = body.boardIds;
              if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TOKEN_BOARDS) {
                throw badRequest(`boardIds must list 1 to ${MAX_TOKEN_BOARDS} boards`);
              }
              if (ids.some((id) => typeof id !== 'string' || !TOKEN_BOARD_ID_RE.test(id))) throw badRequest('boardIds must be board ids');
              boardIds = [...new Set(ids)];
              for (const id of boardIds) boardFor(user, id);
            }
            // owners and admins are `owner` of every board, so a token that can write must name its boards
            if (isAdmin(user) && scope !== 'read' && boardIds === null) {
              throw new HttpError(400, 'boards_required', 'Tokens that can comment or edit must list the boards they may use');
            }
            if (directory.countActiveAccessTokens(user.id) >= MAX_ACTIVE_TOKENS) {
              throw conflict('token_limit', `You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
            }
            const created = directory.transaction(() => {
              const made = directory.createAccessToken({ userId: user.id, name, scope, boardIds, ttlMs: days * DAY_MS });
              audit(user, 'mcp.token.create', { tokenId: made.id, name, scope, boardIds, days });
              return made;
            });
            const stored = directory.getAccessToken(created.id);
            return [201, { ...tokenView(stored), token: created.token, url: `${config.baseUrl}/mcp` }];
          }),
          compile('POST', 'me/tokens/revoke-all', { readOnlyOk: true }, ({ user }) => {
            const revoked = directory.transaction(() => {
              const count = directory.revokeUserAccessTokens(user.id);
              audit(user, 'mcp.token.revoke_all', { count });
              return count;
            });
            return [200, { revoked }];
          }),
          compile('DELETE', 'me/tokens/:id', { readOnlyOk: true }, ({ user, params }) => {
            const token = directory.getAccessToken(params.id);
            if (!token || token.userId !== user.id) throw notFound('Token not found');
            directory.transaction(() => {
              directory.revokeAccessToken(token.id);
              audit(user, 'mcp.token.revoke', { tokenId: token.id, name: token.name, by: 'self' });
            });
            return [204];
          }),
          compile('GET', 'admin/tokens', {}, ({ user }) => {
            requireAdmin(user);
            return [200, directory.listAccessTokensAdmin().map((t) => ({ ...tokenView(t), userId: t.userId, userName: t.userName, email: t.email, userRole: t.userRole }))];
          }),
          compile('DELETE', 'admin/tokens/:id', { readOnlyOk: true }, ({ user, params }) => {
            requireAdmin(user);
            const token = directory.getAccessToken(params.id);
            const owner = token ? directory.getUser(token.userId) : null;
            if (!token || !owner) throw notFound('Token not found');
            guardOwner(user, owner, 'revoke the token of');
            directory.transaction(() => {
              directory.revokeAccessToken(token.id);
              audit(user, 'mcp.token.revoke', { tokenId: token.id, name: token.name, userId: owner.id, by: token.userId === user.id ? 'self' : 'admin' });
            });
            return [204];
          }),
        ]
      : []),

    // ---------------------------------------------------------- hosted workspaces (docs/cloud.md)

    ...(cloud
      ? [
          // Called by the control plane with the bearer token (`internal`), never by a browser.
          compile('GET', 'internal/usage', { internal: true }, () => [200, cloud.seatUsage()]),
          compile('PUT', 'internal/limits', { internal: true, body: true, readOnlyOk: true }, ({ body }) => {
            const checked = validateLimits(body);
            if (checked.error) throw badRequest(checked.error);
            return [200, cloud.setLimits(checked.patch)];
          }),
          // Mails the workspace owners (a retried call is answered without mailing again); open while read-only like the limits.
          compile('POST', 'internal/notify', { internal: true, body: true, readOnlyOk: true }, async ({ body }) => {
            const checked = validateNotify(body);
            if (checked.error) throw badRequest(checked.error);
            try {
              return [200, await cloud.notify(checked.notice, { mailer, baseUrl: config.baseUrl })];
            } catch (err) {
              if (err instanceof CloudError) throw new HttpError(502, 'bad_gateway', err.message);
              throw err;
            }
          }),
          // Open while read-only: an owner whose workspace was locked for billing needs it to put that right.
          compile('POST', 'billing/portal', { readOnlyOk: true }, async ({ user }) => {
            if (user.role !== 'owner') throw forbidden('Only the workspace owner can manage billing');
            try {
              return [200, { url: await cloud.portalUrl() }];
            } catch (err) {
              if (err instanceof CloudError) throw new HttpError(502, 'bad_gateway', err.message);
              throw err;
            }
          }),
        ]
      : []),
  ];

  // ------------------------------------------------------------ dispatch

  function send(res, status, body, headers) {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { ...headers, 'content-length': body.length });
      res.end(body);
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  function resolve(method, segments) {
    const matching = routes.filter(
      (r) => r.parts.length === segments.length && r.parts.every((p, i) => p.startsWith(':') || p === segments[i]),
    );
    if (matching.length === 0) throw notFound('No such endpoint');
    const route = matching.find((r) => r.method === (method === 'HEAD' ? 'GET' : method));
    if (!route) {
      const error = new HttpError(405, 'method_not_allowed', 'Method not allowed');
      error.allow = [...new Set(matching.map((r) => r.method))].join(', ');
      throw error;
    }
    const params = {};
    route.parts.forEach((p, i) => {
      if (p.startsWith(':')) params[p.slice(1)] = segments[i];
    });
    return { route, params };
  }

  async function dispatch(req, res, pathname, query) {
    let segments;
    try {
      segments = pathname.split('/').slice(2).map(decodeURIComponent);
    } catch {
      throw badRequest('Malformed URL');
    }
    const method = String(req.method).toUpperCase();
    const { route, params } = resolve(method, segments);

    if (route.internal) {
      // Bearer token only: no cookie, no CSRF header (a browser cannot send this one).
      if (!cloud.tokenOk(req.headers.authorization)) {
        res.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, 'unauthenticated', 'A valid bearer token is required');
      }
    } else if (!auth.csrfOk(req)) {
      throw new HttpError(403, 'csrf', 'Missing or invalid CSRF protection header');
    }

    const signedIn = () => {
      const current = auth.authenticate(req.headers.cookie);
      if (!current) throw new HttpError(401, 'unauthenticated', 'Sign in required');
      if (current.setCookie) res.setHeader('set-cookie', current.setCookie);
      return current;
    };

    let session = route.public || route.internal ? null : signedIn();
    if (cloud && !route.readOnlyOk && !READ_METHODS.has(method) && cloud.limits().readOnly) {
      throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
    }
    const body = route.body && BODY_METHODS.has(method) ? await readJson(req) : {};
    // A body can take a while to arrive: judge the request by who the caller is now, not when it started.
    if (session && route.body) session = signedIn();

    const [status, payload, headers] = await route.handler({
      req,
      res,
      params,
      query,
      body,
      user: session?.user,
      sessionId: session?.sessionId,
    });
    send(res, status, payload, headers);
  }

  async function handle(req, res) {
    let pathname;
    let query;
    try {
      const url = new URL(req.url, 'http://x');
      pathname = url.pathname;
      query = url.searchParams;
    } catch {
      return false;
    }
    if (!pathname.startsWith('/api/') || pathname === '/api/health') return false;

    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      await dispatch(req, res, pathname, query);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      if (err instanceof HttpError) {
        if (err.allow) res.setHeader('allow', err.allow);
        if (err.status === 413) res.setHeader('connection', 'close');
        send(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error('api: unexpected error:', err);
        send(res, 500, { error: 'internal', message: 'Something went wrong' });
      }
    }
    return true;
  }

  return { handle };
}
