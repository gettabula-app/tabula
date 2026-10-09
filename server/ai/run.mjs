// POST /api/ai/run (docs/ai.md, "Running a feature"): checks, key, limits, board read, the provider call streamed as
// server-sent events, validation of the proposal and one audit row. The core (createRunner) is the same in both modes; the
// accounts route and the open-mode handler below only decide who the caller is and which key pays.
//
// Whatever fails before the stream starts is an ordinary HTTP error with a status code. Once the stream has started, a
// failure is one `event: error`. A run sends `event: progress` lines, then exactly one `event: result` or `event: error`.
// Nothing here puts the key, a header, board text or model output in an error, a log line or an audit row.

import { readAll, stripInvisible } from '../board-ops.mjs';
import { csrfOk } from '../auth.mjs';
import { TOKEN_BOARD_ID_RE } from '../tokens.mjs';
import { AiError, describeError } from './errors.mjs';
import { FEATURE_SPECS, InputError, InvalidProposal, buildContent, parseInput, proposalCount, validateProposal } from './features.mjs';
import { fenceRead, readForAi } from './board.mjs';
import { createRunGate, createWindowCounter } from './limits.mjs';
import { createLiveRuns } from './live.mjs';
import { canResolve, canSeeRun } from './policy.mjs';
import { createProvider as defaultCreateProvider } from './providers.mjs';
import { DEFAULT_LIMITS, aiEnabledFor, personalKeysFor } from './settings.mjs';

export const RUN_TIMEOUT_MS = 120_000;
/** Runs at once on a shared key (the workspace key, or the operator's key in open mode); a personal key runs one at a time. */
export const SHARED_KEY_RUNS = 3;
const BUSY_RETRY_S = 5;
const RUN_BODY_LIMIT = 64 * 1024;
const EDIT_ROLES = new Set(['owner', 'editor']);
const V1_TYPES = new Set(['sticky', 'frame']);
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
};
const READ_ONLY_MESSAGE = 'This workspace is read-only. Ask the workspace owner to check billing.';
const NO_KEY_MESSAGE = 'No AI key is set. An admin can add one under Admin, AI.';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const count = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);

/** Token counts of a provider's usage, as plain numbers. Nothing else of the provider's object is passed on. */
function usageSummary(usage, fallbackModel) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    model: typeof u.model === 'string' && u.model ? u.model.slice(0, 80) : fallbackModel,
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cacheReadTokens: count(u.cacheReadTokens),
    cacheWriteTokens: count(u.cacheWriteTokens),
  };
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const NAME_MAX = 40;

/**
 * `presence` of a run request: how the run is drawn for others (docs/ai.md, "Live runs"). `color` is the runner's cursor
 * colour, `name` what the person calls themselves (open mode only), and `outline: false` says the run has nothing worth
 * circling (the visible area: a selection the person did not make). Shapes are checked; a name is plain text of at most
 * 40 characters. No geometry is taken: others draw the outline from the run's target ids on their own board.
 */
function parsePresence(value) {
  if (value === undefined) return { color: null, name: null, outline: true };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InputError('presence must be an object');
  for (const name of Object.keys(value)) {
    if (!['color', 'name', 'outline'].includes(name)) throw new InputError(`presence: Unknown field: ${name.slice(0, 40)}`);
  }
  const out = { color: null, name: null, outline: true };
  if (value.color !== undefined && value.color !== null) {
    if (typeof value.color !== 'string' || !COLOR_RE.test(value.color)) throw new InputError('presence.color must be a colour like #2F6FED');
    out.color = value.color.toUpperCase();
  }
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== 'string') throw new InputError('presence.name must be text');
    const clean = [...stripInvisible(value.name).replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
    out.name = clean || null;
  }
  if (value.outline !== undefined) {
    if (typeof value.outline !== 'boolean') throw new InputError('presence.outline must be true or false');
    out.outline = value.outline;
  }
  return out;
}

/** What others outline while a run is going: the ids it reads, or its frame, or nothing for the whole board or a bare prompt. */
export function targetOf(input, presence) {
  if (!presence.outline) return null;
  if (input.selection) return { ids: [...input.selection] };
  if (input.frameId) return { frameId: input.frameId };
  return null;
}

/** The body of POST /api/ai/run: `{ feature, boardId, input, private?, presence? }` or an InputError. */
export function parseRequest(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InputError('The request body must be a JSON object');
  for (const name of Object.keys(body)) {
    if (!['feature', 'boardId', 'input', 'private', 'presence'].includes(name)) throw new InputError(`Unknown field: ${name.slice(0, 40)}`);
  }
  if (typeof body.feature !== 'string' || !Object.hasOwn(FEATURE_SPECS, body.feature)) {
    throw new InputError(`feature must be one of ${Object.keys(FEATURE_SPECS).join(', ')}`);
  }
  if (typeof body.boardId !== 'string' || !TOKEN_BOARD_ID_RE.test(body.boardId)) throw new InputError('boardId must be a board id');
  if (body.private !== undefined && typeof body.private !== 'boolean') throw new InputError('private must be true or false');
  return {
    feature: body.feature,
    boardId: body.boardId,
    input: parseInput(body.feature, body.input),
    private: body.private === true,
    presence: parsePresence(body.presence),
  };
}

/**
 * The body of POST /api/ai/runs/:id/resolve: `{ action: 'accept' | 'discard', presence?: { name } }`. The name is used in
 * open mode only, so the runner can be told who settled their run; in accounts mode the account's name is.
 */
export function parseResolve(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InputError('The request body must be a JSON object');
  for (const name of Object.keys(body)) {
    if (name !== 'action' && name !== 'presence') throw new InputError(`Unknown field: ${name.slice(0, 40)}`);
  }
  if (body.action !== 'accept' && body.action !== 'discard') throw new InputError('action must be accept or discard');
  const presence = parsePresence(body.presence);
  if (presence.color !== null || presence.outline !== true) throw new InputError('presence of a resolve takes only a name');
  return { action: body.action, name: presence.name };
}

/**
 * @param {object} deps
 * @param {new (status: number, code: string, message?: string) => Error} deps.HttpError the class the caller turns into a response
 * @param {(room: string, fn: (doc: any) => any) => any} deps.readRoom reads a room document (roomAccess.read in the relay)
 * @param {(role: string, kind: 'board' | 'comments') => boolean} deps.canWriteRoom the relay's own rule
 * @param {(options: { kind: string, apiKey: string }) => any} [deps.createProvider] replaced by the tests
 * @param {number} [deps.timeoutMs] a run is stopped after this long
 * @param {ReturnType<typeof createLiveRuns>} [deps.live] the board's live runs (live.mjs); the relay shares one with both modes
 */
export function createRunner({ HttpError, readRoom, canWriteRoom, createProvider = defaultCreateProvider, log = console.error, now = Date.now, timeoutMs = RUN_TIMEOUT_MS, live = createLiveRuns({ now }) }) {
  const hourly = createWindowCounter({ now });
  const gate = createRunGate({ 'key:workspace': SHARED_KEY_RUNS, 'key:env': SHARED_KEY_RUNS });

  const refuse = (res, message, wait) => {
    res.setHeader('retry-after', String(wait));
    return new HttpError(429, 'rate_limited', message);
  };

  /** The HttpError for anything that went wrong before the stream started. */
  function toHttp(res, err) {
    if (err instanceof HttpError) return err;
    if (err instanceof InputError) return new HttpError(400, 'bad_request', err.message);
    if (err instanceof AiError) {
      if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
      return new HttpError(err.status, err.code, err.message);
    }
    log('ai: unexpected error:', describeError(err));
    return new HttpError(500, 'internal', 'Something went wrong');
  }

  /** Reads the board for this run and builds what the provider is sent. Throws HttpError for input the board cannot serve. */
  function prepare(call) {
    const { feature, input } = call;
    const seen = readRoom(call.boardId, (doc) => {
      const read = readForAi(doc, { selection: input.selection, frameId: input.frameId, onlyStickies: feature === 'cluster' });
      return read.frameMissing ? read : { read, fenced: fenceRead(read, doc, call.title) };
    });
    if (seen.frameMissing) throw new HttpError(400, 'bad_request', 'frameId: That frame is not on this board');
    const { read, fenced } = seen;
    if (feature === 'summarise' && read.items.length === 0) throw new HttpError(400, 'bad_request', 'There is nothing to summarise here');
    if (feature === 'cluster' && read.stickyIds.length < 2) throw new HttpError(400, 'bad_request', 'Select at least two stickies the AI can read');
    return {
      read,
      coverage: feature === 'cluster' ? new Set(read.stickyIds) : null,
      content: buildContent(feature, input, fenced, { stickyCount: read.stickyIds.length }),
    };
  }

  /** Runs the provider and returns its one result or refusal; stops at once when `signal` aborts, even if the provider ignores it. */
  async function collect(iterable, signal, onProgress) {
    const iterator = iterable[Symbol.asyncIterator]();
    const aborted = new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    try {
      for (;;) {
        const step = await Promise.race([iterator.next(), aborted]);
        if (step.done) return null;
        const event = step.value;
        if (event?.type === 'progress') onProgress();
        else if (event?.type === 'result' || event?.type === 'refused') return event;
      }
    } finally {
      Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }

  /** The stream. Never throws: every failure becomes the one `event: error`, and the audit row is written before the last event. */
  async function stream(call, prep, creds, res, runId) {
    const spec = FEATURE_SPECS[call.feature];
    const controller = new AbortController();
    const stop = (code) => {
      if (!controller.signal.aborted) controller.abort(new AiError(code));
    };
    const timer = setTimeout(() => stop('ai_timeout'), timeoutMs);
    const onClose = () => {
      if (!res.writableFinished) stop('ai_aborted');
    };
    res.once('close', onClose);
    const emit = (event, data) => {
      if (!res.destroyed && !res.writableEnded) res.write(sse(event, data));
    };
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    let progress = 0;
    // the first event names the run, so the runner's app can tell its own run among the board's live runs
    emit('progress', { n: progress, runId });

    let outcome = 'ok';
    let failure = null;
    let proposal = null;
    let usage = null;
    try {
      const provider = createProvider({ kind: creds.kind, apiKey: creds.apiKey });
      const events = provider.run({
        model: call.model,
        system: spec.system,
        content: prep.content,
        schema: spec.schema,
        effort: spec.effort,
        maxTokens: spec.maxTokens,
        signal: controller.signal,
      });
      const final = await collect(events, controller.signal, () => emit('progress', { n: ++progress }));
      if (final === null) throw new AiError('internal');
      if (final.type === 'refused') throw new AiError('ai_refused');
      usage = usageSummary(final.usage, call.model);
      call.stillAllowed();
      const types = spec.kind === 'group' ? readRoom(call.boardId, (doc) => new Map(readAll(doc).boxes.map((o) => [o.id, o.type]))) : new Map();
      const can = (_action, type) => V1_TYPES.has(type) && canWriteRoom(call.role ?? 'owner', 'board');
      proposal = validateProposal(call.feature, final.value, { input: call.input, can, coverage: prep.coverage, types });
    } catch (err) {
      // the reason a run was stopped wins over whatever the provider threw when it was
      const why = controller.signal.aborted && controller.signal.reason instanceof AiError ? controller.signal.reason : err;
      if (why instanceof InvalidProposal) log('ai: unusable proposal from', call.feature, `reason=${why.reason}`);
      else if (!(why instanceof AiError)) log('ai: run failed:', describeError(why));
      const known = why instanceof AiError ? why : new AiError('internal');
      outcome = known.code;
      failure = { error: known.code, message: known.message };
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }

    const used = usage ?? usageSummary(null, call.model);
    try {
      call.audit(`ai.${call.feature}`, {
        boardId: call.boardId,
        model: used.model,
        keySource: call.keySource,
        outcome,
        counts: { scope: prep.read.scope, inScope: prep.read.inScope, sent: prep.read.sent, chars: prep.read.chars, cut: prep.read.cut, proposed: proposal ? proposalCount(proposal) : 0 },
        tokens: { input: used.inputTokens, output: used.outputTokens, cacheRead: used.cacheReadTokens, cacheWrite: used.cacheWriteTokens },
      });
    } catch (err) {
      log('ai: could not write an audit row:', describeError(err));
    }
    if (failure) {
      live.fail(runId, failure.error);
      emit('error', failure);
    } else {
      live.ready(runId, { proposal, cut: prep.read.cut });
      emit('result', { runId, proposal, cut: prep.read.cut, usage });
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  }

  /**
   * One run, after the caller's own checks. `call` says who runs what on which key; see createRunRoute and createOpenRun.
   * Admission (one run at a time per person and per key, the hourly counts) comes first, then the board read, then the stream.
   */
  async function execute(call, res) {
    const { person, workspace, keyId, limits } = call;
    if (gate.busy(person)) throw refuse(res, 'You already have an AI run in progress. Wait for it to finish.', BUSY_RETRY_S);
    if (gate.busy(keyId)) throw refuse(res, 'The AI key is busy with another run. Try again in a moment.', BUSY_RETRY_S);
    const personWait = hourly.check(person, limits.perPersonHour);
    if (personWait) throw refuse(res, `You have used your ${limits.perPersonHour} AI runs for this hour. Try again later.`, personWait);
    const workspaceWait = hourly.check(workspace, limits.perWorkspaceHour);
    if (workspaceWait) throw refuse(res, `This workspace has used its ${limits.perWorkspaceHour} AI runs for this hour. Try again later.`, workspaceWait);

    hourly.record(person);
    hourly.record(workspace);
    const release = gate.take([person, keyId]);
    let started = false;
    let runId = null;
    try {
      const prep = prepare(call);
      const creds = call.openKey();
      started = true;
      runId = live.start(call.boardId, { by: call.by, feature: call.feature, prompt: call.input.prompt, target: call.target, private: call.private });
      await stream(call, prep, creds, res, runId);
    } catch (err) {
      // a run that never reached the provider does not use up the person's hour
      if (!started) {
        hourly.undo(person);
        hourly.undo(workspace);
      }
      throw toHttp(res, err);
    } finally {
      // stream() ends every run it was given; this only catches one it never reached
      if (runId) live.fail(runId, 'internal');
      release?.();
    }
  }

  /** The 409 for a run that is no longer ready. It says how it ended and who ended it, so the app can say "Ana added it first". */
  function settled(run) {
    const err = new HttpError(409, 'ai_run_resolved', 'Someone has already added or discarded that AI run');
    const action = { accepted: 'accept', discarded: 'discard' }[run.status] ?? run.status;
    err.extra = { action, by: run.resolvedBy ? { ...run.resolvedBy } : null };
    return err;
  }

  /**
   * POST /api/ai/runs/:id/resolve. `viewerOf(boardId)` says who asks, on the run's board: `{ role, userId, canEdit }`,
   * with a null role when they cannot open it. `who` is how they are shown, or a function of the name the request brings
   * (open mode). Returns the answer's body; for an accept it
   * carries the proposal, which the person who asked writes into the board.
   */
  function resolveRun(id, body, viewerOf, who) {
    const { action, name } = parseResolve(body);
    const run = typeof id === 'string' ? live.get(id) : null;
    const viewer = run ? viewerOf(run.boardId) : null;
    if (!run || !canSeeRun(viewer, run)) throw new HttpError(404, 'not_found', 'That AI run is gone');
    if (run.status === 'running') throw new HttpError(409, 'ai_run_running', 'That AI run is still going');
    if (run.status !== 'ready') throw settled(run);
    if (!canResolve(viewer, run, now())) throw new HttpError(403, 'forbidden', 'You cannot add or discard this AI run');
    const done = live.resolve(id, action, typeof who === 'function' ? who(name) : who);
    if (!done.ok) throw settled(live.get(id) ?? run);
    return action === 'accept' ? { id, action, feature: run.feature, proposal: done.proposal, cut: done.cut } : { id, action, feature: run.feature };
  }

  return { execute, toHttp, resolveRun, live };
}

// ---------------------------------------------------------------- accounts mode

/**
 * The routes of POST /api/ai/run and POST /api/ai/runs/:id/resolve in accounts mode. `compile`, `errors` and `audit` come
 * from api.mjs. The workspace's read-only switch is checked by the run route, in its place in the order, so it is marked
 * readOnlyOk; the resolve route leaves it to api.mjs.
 */
export function createRunRoutes({ compile, errors, audit, directory, cloud, ring, settingsNow, canWriteRoom, readRoom, createProvider, live, log = console.error, now, timeoutMs }) {
  const { HttpError, forbidden } = errors;
  const runner = createRunner({ HttpError, readRoom, canWriteRoom, createProvider, log, now, timeoutMs, ...(live ? { live } : {}) });
  const readOnlyNow = () => cloud?.limits().readOnly === true;
  const readOnly = () => new HttpError(402, 'read_only', READ_ONLY_MESSAGE);
  const noKey = () => new HttpError(409, 'ai_no_key', NO_KEY_MESSAGE);
  const boardRoleOf = (boardId, userId) => {
    const board = directory.getBoard(boardId);
    return board && board.deletedAt == null ? { board, role: directory.boardRole(board.id, userId) } : { board: null, role: null };
  };

  const runRoute = compile('POST', 'ai/run', { body: true, readOnlyOk: true, stream: true }, async ({ res, user, body }) => {
    try {
      const { feature, boardId, input, private: hidden, presence } = parseRequest(body);
      const settings = settingsNow();
      if (!aiEnabledFor(settings, user)) throw new HttpError(403, 'ai_disabled', 'AI is not turned on for this workspace');
      if (!settings.features.includes(feature)) throw new HttpError(403, 'ai_feature_disabled', 'This AI feature is turned off for this workspace');

      const { board, role } = boardRoleOf(boardId, user.id);
      if (!board || role === null) throw new HttpError(404, 'not_found', 'Board not found');
      // canWriteRoom is also false while the workspace is read-only: tell a role that cannot edit from a workspace that is locked
      if (!canWriteRoom(role, 'board')) throw readOnlyNow() && EDIT_ROLES.has(role) ? readOnly() : forbidden('You need to be able to edit this board to use AI on it');
      if (readOnlyNow()) throw readOnly();

      const mine = personalKeysFor(settings, user) ? directory.getAiKeyInfo('user', user.id) : null;
      const scope = mine ? 'user' : directory.getAiKeyInfo('workspace') ? 'workspace' : null;
      if (!scope) throw noKey();
      // a run the workspace pays for stays visible to the people who share the bill
      if (hidden && scope !== 'user') throw new HttpError(400, 'bad_request', "Runs on the workspace key can't be private");
      const which = scope === 'user' ? { ring, scope, userId: user.id } : { ring, scope };
      if (!ring.configured || !directory.aiKeyReadable(which)) throw new AiError('ai_key_unreadable');

      // the caller is judged again when the provider has answered, which can take a while
      const stillAllowed = () => {
        const fresh = directory.getUser(user.id);
        const current = boardRoleOf(boardId, user.id);
        if (!fresh || fresh.disabled || !aiEnabledFor(settingsNow(), fresh) || current.role === null || !canWriteRoom(current.role, 'board')) {
          throw new AiError('forbidden');
        }
      };

      await runner.execute(
        {
          feature,
          boardId,
          input,
          title: board.title,
          role,
          // the name is the account's, never one the request brings
          by: { id: user.id, name: user.name ?? null, color: presence.color },
          target: targetOf(input, presence),
          private: hidden,
          person: `user:${user.id}`,
          workspace: 'workspace',
          keyId: scope === 'user' ? `key:user:${user.id}` : 'key:workspace',
          keySource: scope,
          model: settings.model,
          limits: settings.limits,
          openKey() {
            const found = directory.useAiKey(which);
            if (!found) throw noKey();
            return { kind: found.provider, apiKey: found.apiKey };
          },
          stillAllowed,
          audit: (action, detail) => audit(user, action, detail),
        },
        res,
      );
    } catch (err) {
      throw runner.toHttp(res, err);
    }
    return undefined;
  });

  // Anyone who can open the board learns the run is gone (404 for everyone else); the rules are policy.mjs's.
  const resolveRoute = compile('POST', 'ai/runs/:id/resolve', { body: true }, ({ res, user, params, body }) => {
    try {
      const viewerOf = (boardId) => {
        const { board, role } = boardRoleOf(boardId, user.id);
        return board && role !== null ? { role, userId: user.id, canEdit: canWriteRoom(role, 'board') } : { role: null, userId: user.id, canEdit: false };
      };
      const answer = runner.resolveRun(params.id, body, viewerOf, { id: user.id, name: user.name ?? null });
      const run = runner.live.get(params.id);
      audit(user, `ai.run.${answer.action}`, { boardId: run?.boardId ?? null, feature: answer.feature });
      return [200, answer];
    } catch (err) {
      throw runner.toHttp(res, err);
    }
  });

  return [runRoute, resolveRoute];
}

// ---------------------------------------------------------------- open mode

class OpenHttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function readJsonBody(req, limit = RUN_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return done(reject, new OpenHttpError(413, 'payload_too_large', 'The request body is too large'));
    }
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) done(reject, new OpenHttpError(413, 'payload_too_large', 'The request body is too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        done(resolve, text ? JSON.parse(text) : {});
      } catch {
        done(reject, new OpenHttpError(400, 'bad_request', 'The request body is not valid JSON'));
      }
    });
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, new OpenHttpError(400, 'bad_request', 'The request was aborted')));
  });
}

/**
 * POST /api/ai/run in open mode: no accounts, so the operator's key (TABULA_AI_API_KEY with TABULA_AI_OPEN=1) pays, runs are
 * counted per client address, and the workspace cap is one global count. Returns `{ handle(req, res) }`.
 * @param {{ config: any, canWriteRoom: Function, readRoom: Function, roomExists: (room: string) => boolean, createProvider?: Function, log?: Function, now?: () => number, timeoutMs?: number }} deps
 */
export function createOpenRun({ config, canWriteRoom, readRoom, roomExists, createProvider, live, log = console.log, now, timeoutMs }) {
  const runner = createRunner({ HttpError: OpenHttpError, readRoom, canWriteRoom, createProvider, log, now, timeoutMs, ...(live ? { live } : {}) });

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

  const sendError = (res, err) => {
    if (res.headersSent) return void res.end();
    const body = JSON.stringify({ error: err.code, message: err.message, ...err.extra });
    res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };

  async function handle(req, res) {
    try {
      if (!csrfOk(req)) {
        req.resume();
        throw new OpenHttpError(403, 'csrf', 'Missing or invalid CSRF protection header');
      }
      const open = config.ai.open;
      if (!open) {
        req.resume();
        throw new OpenHttpError(403, 'ai_disabled', 'AI is not turned on');
      }
      const { feature, boardId, input, private: hidden, presence } = parseRequest(await readJsonBody(req));
      if (hidden) throw new OpenHttpError(400, 'bad_request', 'Only a run on your own key can be private');
      if (!roomExists(boardId)) throw new OpenHttpError(404, 'not_found', 'Board not found');
      if (!canWriteRoom('owner', 'board')) throw new OpenHttpError(403, 'forbidden', 'You need to be able to edit this board to use AI on it');
      await runner.execute(
        {
          feature,
          boardId,
          input,
          title: null,
          role: null,
          // open mode has no accounts: the name is what the person calls themselves, and the client address is never shown
          by: { id: null, name: presence.name, color: presence.color },
          target: targetOf(input, presence),
          private: false,
          person: `ip:${clientIp(req)}`,
          workspace: 'workspace',
          keyId: 'key:env',
          keySource: 'workspace',
          model: config.ai.model,
          limits: DEFAULT_LIMITS,
          openKey: () => ({ kind: config.ai.provider, apiKey: open.apiKey }),
          stillAllowed: () => {},
          audit: (action, detail) => log(`${action} ${JSON.stringify(detail)}`),
        },
        res,
      );
    } catch (err) {
      sendError(res, runner.toHttp(res, err));
    }
  }

  /** POST /api/ai/runs/:id/resolve in open mode: everyone edits, nobody is the runner. */
  async function resolve(req, res, id) {
    try {
      if (!csrfOk(req)) {
        req.resume();
        throw new OpenHttpError(403, 'csrf', 'Missing or invalid CSRF protection header');
      }
      if (!config.ai.open) {
        req.resume();
        throw new OpenHttpError(403, 'ai_disabled', 'AI is not turned on');
      }
      const body = await readJsonBody(req);
      // nobody has an account in open mode: the name is what the person calls themselves, as on a run
      const answer = runner.resolveRun(id, body, () => ({ role: 'owner', userId: null, canEdit: canWriteRoom('owner', 'board') }), (name) => ({ id: null, name }));
      const text = JSON.stringify(answer);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(text);
    } catch (err) {
      sendError(res, runner.toHttp(res, err));
    }
  }

  return { handle, resolve, live: runner.live };
}
