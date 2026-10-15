// HTTP API of accounts mode (see docs/accounts.md). Every permission rule lives here, server side:
// the client only mirrors it. Handlers are synchronous after the body is read, so each
// check-then-act sequence runs without interleaving with another request.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BOARD_ID_RE, ftsAvailable } from './directory.mjs';
import { canMoveBoard } from './board-move.mjs';
import { InviteExhaustedError, SeatLimitError } from './auth.mjs';
import { CloudError, addsSeat, validateLimits, validateNotify } from './cloud.mjs';
import { createMailer } from './mailer.mjs';
import { authMailUnavailable } from './mail-health.mjs';
import { createTelemetryCollector } from './telemetry/collector.mjs';
import { createDataBytes } from './telemetry/data-bytes.mjs';
import { createLastReport } from './telemetry/last-report.mjs';
import { analyticsChoice, appVersionLabel, dropFeatureSeries, workspaceIdValid } from './telemetry/report.mjs';
import {
  MAX_TEMPLATES_PER_OWNER, TEMPLATE_BODY_LIMIT, TemplateInputError, copyName, parseTemplateBody,
} from './templates.mjs';
import { MAX_ACTIVE_TOKENS, MAX_TOKEN_BOARDS, SCOPES, TOKEN_BOARD_ID_RE } from './tokens.mjs';
import { describeError } from './ai/errors.mjs';
import { FEATURE_SPECS } from './ai/features.mjs';
import { createAiRoutes } from './ai/routes.mjs';
import { RESTORE_STATUS, RestoreError } from './restore.mjs';
import { AssetError, readBytes } from './assets.mjs';
import { isRevealed, previewSourceOf, readAll } from './board-ops.mjs';
import { MAX_PREVIEW_BYTES, validatePreviewImage } from './preview-image.mjs';
import { createDevPreviewStore } from './preview-store.mjs';
import { LinkRouteError, createLinkUnfurl } from './link-routes.mjs';
import { createChatRoutes } from './chat-routes.mjs';
import { createChatLimits } from './chat-limits.mjs';
import { createNotifications } from './notifications.mjs';
import { createNotificationRoutes } from './notifications-routes.mjs';
import { createBackupExport } from './backup-export.mjs';
import { createTrackerInboxRoutes } from './tracker/inbox-routes.mjs';
import { boardAccessForDirectory } from './tracker/access.mjs';
import { clientRateKeyOf, clientIpReport } from './client-ip.mjs';
import { createWindowLimiter } from './limiter.mjs';
import { MAX_OAUTH_BOARD_IDS, OAUTH_SCOPES, OAUTH_TRACKER_SCOPES, redirectUriRegistered } from './oauth.mjs';
import { knownRedirect } from './oauth-known-clients.mjs';
import { OpsError, TrackerRestoringError } from './tracker/shared.mjs';
import { trackerGateState } from './tracker/gate.mjs';
import { ticketAccess } from './tracker/access.mjs';
import { createTrackerRoutes } from './tracker/api-routes.mjs';
import { createTrackerLinkRoutes } from './tracker/link-api-routes.mjs';
import { createTrackerAdminRoutes } from './tracker/admin-routes.mjs';
import { checkTrackerData as checkTrackerDataReal } from './tracker/backup-check.mjs';
import {
  JOIN_CODE_DEFAULT_HOURS, JOIN_CODE_DEFAULT_USES, JOIN_CODE_ERROR, JOIN_CODE_MAX_HOURS, JOIN_CODE_MAX_USES,
  generateJoinCode,
} from './join-codes.mjs';

const MAX_BODY = 64 * 1024;
// A body over its limit is read (and thrown away) up to this size so the 413 reaches the client; it must stay above
// every route's `maxBody`, and compile() refuses a route that breaks that.
const DRAIN_LIMIT = 2 * TEMPLATE_BODY_LIMIT;
const INVITE_EXHAUSTED = 'This invitation has been used up. Ask the person who invited you for a new link.';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PREVIEW_OBJECTS = 5000;
const MAX_PREVIEW_DAILY_BYTES = 20 * 1024 * 1024;
const USER_ROLES = ['owner', 'admin', 'member', 'guest'];
const TEAM_ROLES = ['admin', 'member'];
const SHARE_ROLES = ['editor', 'commenter', 'viewer'];
const TOKEN_FIELDS = ['name', 'scope', 'boardIds', 'days', 'tracker'];
const PRINCIPAL_TYPES = ['user', 'team'];
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
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

/** The words for a sign-in request refused by the limiter, with the real wait (a school shares one network address). */
function rateLimitedMessage({ scope, retryAfterSec }) {
  const minutes = Math.ceil(retryAfterSec / 60);
  const wait = retryAfterSec < 60 ? 'Try again in a moment.' : `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  return `${scope === 'ip' ? 'Too many sign-in requests from your network.' : 'Too many sign-in requests for this email address.'} ${wait}`;
}

const badRequest = (message) => new HttpError(400, 'bad_request', message);
const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
const conflict = (code, message) => new HttpError(409, code, message);

const isAdmin = (user) => user.role === 'owner' || user.role === 'admin';
const userView = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const EDITOR_FALLBACK = 'A former member';
const boardView = (b, role, editor = null) => ({
  id: b.id,
  title: b.title,
  teamId: b.teamId,
  ownerId: b.ownerId ?? null,
  role,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  lastEditedBy: typeof editor === 'string' && editor ? editor : null,
  lastEditedKind: b.lastEditedKind === 'person' || b.lastEditedKind === 'agent' ? b.lastEditedKind : null,
  lastEditedAt: typeof b.lastEditedAt === 'number' && Number.isFinite(b.lastEditedAt) ? b.lastEditedAt : null,
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

function duplicateJsonKeys(source) {
  let index = 0;
  const duplicates = [];
  const skipSpace = () => { while (/\s/u.test(source[index] ?? '')) index++; };
  const string = () => {
    const start = index++;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index++] === '"') break;
    }
    return JSON.parse(source.slice(start, index));
  };
  const value = (path = []) => {
    skipSpace();
    if (source[index] === '{') {
      index++;
      skipSpace();
      const seen = new Set();
      if (source[index] === '}') { index++; return; }
      while (index < source.length) {
        skipSpace();
        const key = string();
        const child = [...path, key];
        if (seen.has(key)) duplicates.push(child);
        seen.add(key);
        skipSpace();
        index++;
        value(child);
        skipSpace();
        if (source[index] === '}') { index++; return; }
        index++;
      }
      return;
    }
    if (source[index] === '[') {
      index++;
      skipSpace();
      if (source[index] === ']') { index++; return; }
      let item = 0;
      while (index < source.length) {
        value([...path, String(item++)]);
        skipSpace();
        if (source[index] === ']') { index++; return; }
        index++;
      }
      return;
    }
    if (source[index] === '"') { string(); return; }
    while (index < source.length && !/[\s,}\]]/u.test(source[index])) index++;
  };
  value();
  return duplicates;
}

function readJson(req, limit, { rejectDuplicateMappingKeys = false } = {}) {
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
      if (size <= limit) chunks.push(chunk);
      else if (size > DRAIN_LIMIT) done(reject, tooLarge());
    });
    req.on('end', () => {
      if (size > limit) return done(reject, tooLarge());
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
      if (rejectDuplicateMappingKeys) {
        const duplicate = duplicateJsonKeys(text).find((parts) => parts[0] === 'mapping');
        if (duplicate) {
          const path = duplicate.length > 1 ? `mapping.${String(duplicate[1]).slice(0, 64)}` : 'mapping';
          return done(reject, new OpsError('invalid_input', 'Mapping keys must be unique', path));
        }
      }
      done(resolve, data);
    });
    req.on('error', (err) => done(reject, err));
    req.on('close', () => done(reject, new HttpError(400, 'bad_request', 'The request was aborted')));
  });
}

function compile(method, pattern, options, handler) {
  if (options.maxBody > DRAIN_LIMIT) throw new Error(`maxBody of ${method} ${pattern} is above DRAIN_LIMIT`);
  return { method, parts: pattern.split('/'), template: pattern, handler, ...options };
}

// `ai` carries what the relay shares with the AI routes (canWriteRoom, readRoom) and can replace the provider factory
// (docs/ai.md); the tests do, so no request leaves the machine.
// `onChange` is told after every API call that wrote and succeeded (any method but GET, HEAD and OPTIONS, status below 400):
// the backups use it to take a settle backup shortly after the activity stops (docs/backups.md, When it runs).
// `restore` is the restore engine (docs/backups.md, Restoring), null while backups are off. `maintenance` says whether a
// restore has taken the server over: every call but the backup status then answers 503 {error: 'restoring'}.
// `chat` is what the relay shares with the chat routes (docs/chat.md): { store, access, hub }, null when chat is off.
export function createApi({ directory, auth, config, roomExists, events, liveStats = () => ({ rooms: 0, connections: 0 }), cloud = null, history = null, activity = null, backupStatus = () => ({ enabled: false }), volumeStatus = () => null, startedAt = Date.now(), now = Date.now, onChange = () => {}, restore = null, maintenance = () => false, mailer = createMailer(config), ai = {}, assets = null, link = {}, chat = null, boardPresence = () => [], notifications = null, notificationDigest = null, joinCodeService = null, snapshotBarrier = null, backupConfig = null, keyFloorReporter = null, checkTrackerData = null, dataDir = config.dataDir, log = () => {}, roomAccess = null }) {
  /** Who last edited a board, as the card shows it: a person's current name (looked up now), "A former member" once they are gone or disabled, or an agent's token name. */
  const editorLabel = (b) => {
    if (b?.lastEditedKind === 'agent') return typeof b.lastEditedBy === 'string' ? b.lastEditedBy : null;
    if (b?.lastEditedKind !== 'person' || typeof b.lastEditedBy !== 'string') return null;
    const person = directory.getUser(b.lastEditedBy);
    if (!person || person.disabled) return EDITOR_FALLBACK;
    return [...String(person.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('') || EDITOR_FALLBACK;
  };
  const previewStore = config.previewDev === true ? createDevPreviewStore({ dataDir, now }) : null;
  /**
   * What GET /api/internal/version answers (docs/migrations.md): this build's label, the schema generations it knows and the highest
   * `minReader` it declares (what a rollback is measured against), and what the files on disk are on. Chat is null where it is off.
   */
  function versionReport() {
    const dir = directory.schemaReport();
    const chatReport = chat?.schemaReport?.() ?? null;
    const pair = (pick) => ({ directory: pick(dir), chat: chatReport ? pick(chatReport) : null });
    return {
      version: config.version ?? null,
      startedAt,
      build: { schema: pair((r) => r.build.schema), maxReader: pair((r) => r.build.maxReader) },
      disk: { schema: pair((r) => r.disk.schema), minReader: pair((r) => r.disk.minReader), legacy: pair((r) => r.disk.legacy) },
      capabilities: { tracker: { fts5: ftsAvailable(directory.db), enabled: config.tracker === true } },
      ...(cloud ? { updates: { auto: cloud.autoUpgrade?.() ?? true } } : {}),
    };
  }

  /** Counts only what the instance has recorded for GET /api/internal/stats (docs/cloud.md). */
  function statsReport() {
    const counts = directory.internalStatsCounts({
      now: now(),
      aiRunActions: Object.keys(FEATURE_SPECS).map((feature) => `ai.${feature}`),
    });
    return {
      boards: counts.boards,
      members: { active: counts.members.active, disabled: counts.members.disabled },
      guests: counts.guests,
      activePeople: { last7d: counts.activePeople.last7d, last30d: counts.activePeople.last30d },
      aiRuns: { last30d: counts.aiRuns.last30d },
      chatMessages: chat?.store?.()?.countMessages?.() ?? 0,
    };
  }

  const telemetryConfig = config.telemetry ?? { defaultEnabled: Boolean(cloud), forced: null };
  const getTelemetrySetting = (key) => (typeof directory.getSetting === 'function' ? directory.getSetting(key) : null);
  const telemetryEnabled = () => analyticsChoice(config.telemetry, getTelemetrySetting, Boolean(cloud));
  const TELEMETRY_CATEGORIES = ['feature_counts'];
  const TELEMETRY_OPERATIONAL = [
    'performance', 'error_codes', 'seats and guests', 'version', 'disk', 'backup state', 'health',
    'workspace_scale', 'last activity',
  ];
  let telemetryInstallId = getTelemetrySetting('telemetry.install_id') || null;
  let telemetryLastActivityAt = null;
  let telemetryConnectionPeak = 0;
  let telemetryConnectionPeakHour = Math.floor(now() / 3_600_000) * 3_600_000;

  function updateTelemetryConnectionPeak(connections, at) {
    const currentHour = Math.floor(at / 3_600_000) * 3_600_000;
    if (currentHour !== telemetryConnectionPeakHour) {
      telemetryConnectionPeakHour = currentHour;
      telemetryConnectionPeak = 0;
    }
    telemetryConnectionPeak = Math.max(telemetryConnectionPeak, connections);
  }
  let eventLoopDelay = null;

  function hostedWorkspaceId() {
    return config.cloud?.workspaceId ?? cloud?.workspaceId ?? null;
  }

  // Hosted operating data remains available when an owner opts out of product
  // analytics. An operator-forced off state still stops all telemetry.
  const telemetryCollectionEnabled = () => telemetryConfig.forced === 'off'
    ? false
    : Boolean(hostedWorkspaceId()) || telemetryEnabled();

  // A workspace id outside the report schema's pattern makes the scrubber reject every report, so none is ever built. Say so once
  // (the id itself is not logged) and in the Privacy preview, instead of leaving a route that answers 503 for ever.
  const telemetryIdProblem = hostedWorkspaceId() !== null && !workspaceIdValid(hostedWorkspaceId());
  if (telemetryIdProblem && telemetryCollectionEnabled()) {
    log('api: TABULA_CLOUD_WORKSPACE_ID does not fit the telemetry report schema (ws_ followed by 8 to 64 letters, digits, - or _): no telemetry report can be built for this workspace');
  }

  eventLoopDelay = telemetryCollectionEnabled() ? monitorEventLoopDelay({ resolution: 20 }) : null;
  eventLoopDelay?.enable();

  function localInstallId() {
    if (hostedWorkspaceId()) return hostedWorkspaceId();
    telemetryInstallId ??= `ins_${randomUUID().replaceAll('-', '')}`;
    return telemetryInstallId;
  }

  function persistTelemetryInstallId() {
    if (hostedWorkspaceId() || typeof directory.setSetting !== 'function') return;
    const id = localInstallId();
    if (getTelemetrySetting('telemetry.install_id') !== id) directory.setSetting('telemetry.install_id', id);
  }

  // A configured or saved opt-in is explicit. Persist the local install identifier at startup, not from a preview GET.
  if (telemetryEnabled() && !hostedWorkspaceId()) persistTelemetryInstallId();

  function telemetryEnvelope() {
    const report = directory.schemaReport();
    const chatReport = chat?.schemaReport?.() ?? null;
    let live = {};
    try { live = liveStats() ?? {}; } catch { /* a snapshot remains available if a live counter is unavailable */ }
    const connections = Number.isSafeInteger(live.connections) && live.connections >= 0 ? live.connections : 0;
    const current = now();
    updateTelemetryConnectionPeak(connections, current);
    return {
      schema: 1,
      hour: Math.floor(current / 3_600_000) * 3_600_000,
      app_version: appVersionLabel(config.version),
      schema_directory: report?.disk?.schema ?? report?.build?.schema ?? 0,
      schema_chat: chatReport?.disk?.schema ?? chatReport?.build?.schema ?? 0,
      node_major: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      mode: cloud ? 'hosted' : 'self',
      workspace: localInstallId(),
      connections_now: connections,
      connections_peak: telemetryConnectionPeak,
      last_activity_at: telemetryLastActivityAt === null ? null : Math.floor(telemetryLastActivityAt / 60_000) * 60_000,
    };
  }

  const telemetryCollector = createTelemetryCollector({
    enabled: telemetryCollectionEnabled,
    analyticsEnabled: telemetryEnabled,
    now,
    envelope: telemetryEnvelope,
  });

  function collectTelemetryGauges() {
    if (!telemetryCollectionEnabled()) return;
    const stats = statsReport();
    const live = (() => { try { return liveStats() ?? {}; } catch { return {}; } })();
    const connections = Number.isSafeInteger(live.connections) && live.connections >= 0 ? live.connections : 0;
    updateTelemetryConnectionPeak(connections, now());
    const active = Number.isSafeInteger(stats.members?.active) ? stats.members.active : 0;
    const guests = Number.isSafeInteger(stats.guests) ? stats.guests : 0;
    const boards = Number.isSafeInteger(stats.boards) ? stats.boards : 0;
    telemetryCollector.gauge('entities_total', boards, { kind: 'boards' });
    telemetryCollector.gauge('entities_total', active, { kind: 'users_active' });
    telemetryCollector.gauge('entities_total', guests, { kind: 'users_guest' });
    telemetryCollector.gauge('ws_connections_peak', telemetryConnectionPeak);
    telemetryCollector.gauge('process_rss_bytes', process.memoryUsage().rss);
    const lagNs = eventLoopDelay?.percentile(95) ?? 0;
    const lagMs = Number.isFinite(lagNs) ? Math.max(0, Math.round(lagNs / 1_000_000)) : 0;
    telemetryCollector.gauge('event_loop_lag_ms_p95', lagMs);
    const dataBytes = dataBytesOnDisk();
    if (dataBytes !== null) telemetryCollector.gauge('data_bytes', dataBytes);
    eventLoopDelay?.reset();
  }

  const dataBytesOnDisk = createDataBytes({ dir: dataDir, now });
  // the directory is measured in the background; the first measurement starts now so the first report has it
  void dataBytesOnDisk.refresh();

  // The report of the last finished hour, for the control plane to pull (docs/telemetry-design.md, "How reports leave an instance"). The
  // collector forgets an hour the moment the next one starts, so the report is built while the hour is still running: every few seconds
  // in its last minute, the latest build kept, so a late timer or a failed build costs a few seconds of that hour, not the hour. A build
  // that crossed the boundary (it would carry the next hour's label and an empty hour) is thrown away. It is held in memory only: a
  // restart loses it, and an owner turning product analytics off removes the feature series from it at once.
  const TELEMETRY_HOUR_MS = 3_600_000;
  const TELEMETRY_CAPTURE_WINDOW_MS = 60_000;
  const TELEMETRY_CAPTURE_EVERY_MS = 10_000;
  const telemetryHourOf = (at) => Math.floor(at / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS;
  // `pendingTelemetry` is the latest build of the hour that is still running (never handed out: a pull inside the hour would take a partial
  // hour, and the collector on the other side drops a second report for the same workspace and hour); it becomes `completedTelemetry`
  // once the hour has ended.
  let pendingTelemetry = null;
  let completedTelemetry = null;
  let lastTelemetryCaptureAt = null;

  // The last report is also kept in one small file on the data volume (docs/telemetry-design.md, "A machine that stops"), so a hosted
  // machine that stops between hours can still hand it over after its next start. One report per hour: the first one kept for an hour wins,
  // as it does at the collector.
  const lastReport = cloud ? createLastReport({ dir: dataDir, workspace: hostedWorkspaceId, log }) : null;
  if (lastReport && !telemetryCollectionEnabled()) lastReport.remove();
  const TELEMETRY_RETAIN_MS = 72 * TELEMETRY_HOUR_MS; // the collector's own window for a late report
  const keepStored = (report) => {
    if (!lastReport || !report) return;
    const stored = lastReport.read();
    if (stored && stored.hour === report.hour) return;
    lastReport.write(report);
  };

  const settleTelemetry = () => {
    if (pendingTelemetry && pendingTelemetry.hour < telemetryHourOf(now())) {
      completedTelemetry = pendingTelemetry;
      pendingTelemetry = null;
      keepStored(completedTelemetry);
    }
  };

  /** On a graceful stop: the hour that is running is written to the file as it stands (labelled with its hour), so it is not lost with the process. */
  function flushTelemetry() {
    if (!lastReport) return;
    try {
      if (maintenance() || !telemetryCollectionEnabled()) return;
      settleTelemetry();
      const pinned = telemetryHourOf(now());
      collectTelemetryGauges();
      const clean = telemetryCollector.snapshot().clean;
      if (!clean || clean.hour !== pinned || telemetryHourOf(now()) !== pinned) return;
      keepStored(telemetryEnabled() ? clean : dropFeatureSeries(clean));
    } catch (err) {
      log(`api: could not flush the telemetry report: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  function captureTelemetryHour() {
    settleTelemetry();
    if (!telemetryCollectionEnabled()) {
      pendingTelemetry = null;
      completedTelemetry = null;
      return;
    }
    const pinned = telemetryHourOf(now());
    collectTelemetryGauges();
    const clean = telemetryCollector.snapshot().clean;
    if (!clean || clean.hour !== pinned || telemetryHourOf(now()) !== pinned) return;
    pendingTelemetry = telemetryEnabled() ? clean : dropFeatureSeries(clean);
  }

  /** Called every few seconds: in the last minute of an hour it builds the report again every ten seconds. */
  function telemetryTick() {
    try {
      if (maintenance()) return; // a restore has closed or is swapping the directory
      settleTelemetry();
      tickWindow();
    } catch (err) {
      log(`api: telemetry capture failed: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  function tickWindow() {
    const at = now();
    if (at - telemetryHourOf(at) < TELEMETRY_HOUR_MS - TELEMETRY_CAPTURE_WINDOW_MS) return;
    if (lastTelemetryCaptureAt !== null && at - lastTelemetryCaptureAt >= 0 && at - lastTelemetryCaptureAt < TELEMETRY_CAPTURE_EVERY_MS) return;
    lastTelemetryCaptureAt = at;
    captureTelemetryHour();
  }

  /**
   * The report to hand out: the newest finished hour, from memory or from the file (the same hour from the file first), and only within the
   * collector's 72 hours. Never an hour that is still running (a pull inside it would take a partial hour).
   */
  function telemetryToHandOut() {
    settleTelemetry();
    const current = telemetryHourOf(now());
    const finished = [lastReport?.read() ?? null, completedTelemetry].filter((report) => report && report.hour < current);
    const best = finished.reduce((a, b) => (b.hour > a.hour ? b : a), finished[0]);
    if (!best) return { none: 'no_report_yet' };
    if (current - best.hour > TELEMETRY_RETAIN_MS) return { none: 'stale_report' };
    return { report: telemetryEnabled() ? best : dropFeatureSeries(best) };
  }
  // only a hosted workspace has a control plane to pull the report (the internal route below), so only it builds one
  if (cloud) setInterval(telemetryTick, 5_000).unref?.();

  function privacyState() {
    const auditActions = new Set(['telemetry.enabled', 'telemetry.disabled', 'telemetry.settings', 'settings.telemetry']);
    const changes = [];
    if (typeof directory.listAuditPage === 'function') {
      for (const action of ['telemetry', 'settings.telemetry']) {
        try {
          const rows = directory.listAuditPage({ limit: 100, action })?.entries;
          if (Array.isArray(rows)) changes.push(...rows.filter((row) => auditActions.has(row.action)));
        } catch { /* older directory adapters may not expose audit pages */ }
      }
    }
    const lastChange = changes.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
    const changedBy = typeof lastChange?.actorName === 'string' && lastChange.actorName.trim()
      ? lastChange.actorName.trim()
      : typeof lastChange?.actorEmail === 'string' && lastChange.actorEmail.trim()
        ? lastChange.actorEmail.trim()
        : null;
    return {
      enabled: telemetryEnabled(),
      locked: telemetryConfig.forced ? 'env' : null,
      mode: cloud ? 'hosted' : 'self',
      operational: TELEMETRY_OPERATIONAL,
      categories: TELEMETRY_CATEGORIES,
      lastBuiltAt: telemetryCollector.lastBuiltAt,
      lastChangedBy: changedBy && Number.isSafeInteger(lastChange?.ts) ? { name: changedBy, at: lastChange.ts } : null,
    };
  }

  const emit = (name, payload) => {
    try {
      events.emit(name, payload);
    } catch (err) {
      console.error(`api: listener for ${name} failed:`, err?.message ?? err);
    }
  };
  const audit = (user, action, detail) => directory.audit(user.id, action, detail);

  const trackerCanAccess = (user) => {
    if (!config.tracker) return false;
    try {
      ticketAccess({ type: 'user', userId: user.id, user }, { id: 'tracker-access-check' });
      return true;
    } catch {
      return false;
    }
  };

  const trackerApiRoutes = config.authEnabled && config.tracker
    ? createTrackerRoutes({ directory, compile, audit, cloud, now, roomAccess, baseUrl: config.baseUrl })
    : [];
  const trackerLinkRoutes = config.authEnabled && config.tracker
    ? createTrackerLinkRoutes({ directory, compile, audit, cloud, now, roomAccess, baseUrl: config.baseUrl })
    : [];
  const trackerMutationWindows = new Map();
  function requireTrackerMutationCapacity(user, res, { gateExempt = false, ownerOnly = false } = {}) {
    const gate = trackerGateState(directory);
    if (gate.closed && !gateExempt) {
      if (ownerOnly) requireOwner(user);
      throw new TrackerRestoringError(gate.floor);
    }
    const current = now();
    let window = trackerMutationWindows.get(user.id);
    if (!window || current - window.startedAt >= 60_000 || current < window.startedAt) {
      window = { startedAt: current, count: 0 };
      trackerMutationWindows.set(user.id, window);
    }
    if (trackerMutationWindows.size > 10_000) {
      for (const [userId, entry] of trackerMutationWindows) {
        if (current - entry.startedAt >= 60_000 || current < entry.startedAt) trackerMutationWindows.delete(userId);
      }
    }
    if (window.count >= 60) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (current - window.startedAt)) / 1000));
      res.setHeader('retry-after', String(retryAfter));
      throw new HttpError(429, 'rate_limited', 'Tracker mutations are limited to 60 per minute.');
    }
    window.count++;
  }

  const clientIp = (req) => clientRateKeyOf(req, config);
  const oauthDecisionLimiter = createWindowLimiter(10, now);
  const boardMoveHourlyLimiter = createWindowLimiter(100, now, 60 * 60_000);
  const boardMoveBoardLimiter = createWindowLimiter(1, now, 10_000);
  const boardMovePreviewLimiter = createWindowLimiter(60, now);
  const previewSourceUserLimiter = createWindowLimiter(30, now, 60_000);
  const previewSourceBoardLimiter = createWindowLimiter(1, now, 2_000);
  const previewUploadBoardLimiter = createWindowLimiter(1, now, 10_000);
  const previewUploadUserLimiter = createWindowLimiter(60, now, 60 * 60_000);
  let previewDailyUploads = [];

  // Every attempt is charged on entry, before the body is read, in one synchronous step: invalid bodies and two concurrent
  // PUTs cannot get past the limit. The daily byte pool is one pool for the whole server (a demo).
  function chargePreviewAttempt(limiters, res) {
    const wait = Math.max(...limiters.map(([limiter, key]) => limiter.wait(key)));
    if (wait) {
      res.setHeader('retry-after', String(wait));
      throw new HttpError(429, 'rate_limited', 'Too many preview requests. Try again later.');
    }
    for (const [limiter, key] of limiters) limiter.hit(key);
  }

  function previewDailyFull(bytes) {
    const current = now();
    previewDailyUploads = previewDailyUploads.filter((upload) => upload.at > current - DAY_MS);
    return previewDailyUploads.reduce((total, upload) => total + upload.bytes, 0) + bytes > MAX_PREVIEW_DAILY_BYTES;
  }
  // refused control-token attempts on the internal routes, per address (the control plane's own calls are never counted: only a refusal is)
  const internalAuthFailures = createWindowLimiter(30, now);
  const internalAuthLogged = createWindowLimiter(1, now);
  const oauthScopeRank = (scope) => OAUTH_SCOPES.indexOf(scope) + 1;
  const oauthLowerScope = (a, b) => oauthScopeRank(a) <= oauthScopeRank(b) ? a : b;
  // What a role on a board allows a connected app to do there: editors and owners write, commenters comment, the rest read.
  const oauthRoleScope = (role) => (role === 'editor' || role === 'owner' ? 'write' : role === 'commenter' ? 'comment' : 'read');
  const oauthBoardsMax = (boards) => boards.reduce((max, board) => {
    const value = oauthRoleScope(board.role);
    return oauthScopeRank(value) > oauthScopeRank(max) ? value : max;
  }, 'read');
  // The most ticket access a connected app may be given at consent, from the person's role now (TAB-365): owners, admins and
  // members may be given write, a viewer read only. A guest, or anyone while the tracker is off, may be given nothing.
  const oauthTrackerRank = (value) => OAUTH_TRACKER_SCOPES.indexOf(value) + 1;
  const oauthTrackerCeiling = (user) => {
    if (!config.tracker || !user || user.role === 'guest') return null;
    if (user.role === 'owner' || user.role === 'admin' || user.role === 'member') return 'write';
    // No workspace role is called viewer today (users.role is owner, admin, member or guest; viewer is only a board-share role), so
    // this line is unreachable; it keeps the ceiling right if a read-only workspace role is ever added.
    return user.role === 'viewer' ? 'read' : null;
  };

  function oauthRequestContext(envelope, user, sessionId) {
    if (!config.mcp?.oauth || config.mcp.mode !== 'accounts' || typeof envelope !== 'string' || envelope.length > 8192
      || !user || user.role === 'guest' || typeof sessionId !== 'string') return null;
    let request;
    try {
      request = directory.readRequest(envelope, now());
    } catch {
      return null;
    }
    if (!request || request.resource !== `${config.mcp.issuer}/mcp`) return null;
    const client = directory.getClient(request.clientId, now());
    if (!client || !redirectUriRegistered(request.redirectUri, client.redirectUris)) return null;

    const requestScopes = request.scope === null ? [client.maxScope] : request.scope.split(/\s+/u);
    if (!requestScopes.length || requestScopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return null;
    const requestMax = requestScopes.reduce((max, scope) => oauthScopeRank(scope) > oauthScopeRank(max) ? scope : max, 'read');
    const boards = directory.listBoardsFor(user);
    let personMax = 'read';
    if (user.role !== 'owner' && user.role !== 'admin') {
      const onSharedWorkspace = boards.some((board) => board.teamId !== null || board.ownerId !== user.id);
      // An unrestricted grant (no boards chosen) on owner/admin accounts and on shared workspaces stays read-only.
      // Choosing boards is the way to a wider grant: it is bound to those boards and capped by the person's role on them.
      personMax = onSharedWorkspace ? 'read' : oauthBoardsMax(boards);
    }
    const requestCeiling = oauthLowerScope(requestMax, client.maxScope);
    const maxScope = oauthLowerScope(requestCeiling, personMax);
    let destination;
    try {
      destination = new URL(request.redirectUri);
    } catch {
      return null;
    }
    const loopback = destination.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(destination.hostname);
    const redirectHost = `${destination.hostname || destination.protocol.slice(0, -1)}${loopback && destination.port ? `:${destination.port}` : ''}`;
    const known = config.mcp.redirectKnown === true ? knownRedirect(request.redirectUri) : null;
    const verified = Boolean(known) || destination.protocol === 'https:' && config.mcp.redirectHosts.includes(destination.hostname);
    return {
      request,
      client,
      sessionId,
      nonce: directory.createOAuthNonce({ requestId: request.requestId, sessionId, expiresAt: request.expiresAt }),
      clientName: client.name,
      clientNameIsClaim: true,
      provider: known?.label ?? null,
      redirectHost,
      redirectUri: request.redirectUri,
      verified,
      maxScope,
      requestCeiling,
      boards,
      readOnly: cloud?.limits().readOnly === true,
    };
  }

  const oauthCallback = (request, values) => {
    const target = new URL(request.redirectUri);
    const params = target.searchParams;
    for (const key of ['code', 'error', 'error_description', 'state', 'iss']) params.delete(key);
    for (const [key, value] of Object.entries(values)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    if (request.state !== null) params.set('state', request.state);
    params.set('iss', config.mcp.issuer);
    target.search = params.toString();
    return target.href;
  };

  function auditOauthRevocations(grants, by, actorId = null) {
    for (const grant of grants) {
      directory.audit(actorId, 'mcp.oauth.revoke', {
        grantId: grant.id,
        clientName: String(grant.clientName ?? '').slice(0, 60),
        userId: grant.userId,
        by,
      });
    }
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
  const boardRoleFor = (user, id) => user?.guest === true
    ? (user.guestBoardId === id ? user.guestBoardRole : null)
    : directory.boardRole(id, user.id);

  function boardFor(user, id, { own = false } = {}) {
    const board = directory.getBoard(id);
    const role = board && board.deletedAt == null ? boardRoleFor(user, board.id) : null;
    if (!board || role === null) throw notFound('Board not found');
    if (own && role !== 'owner') throw forbidden('Only the board owner can do that');
    return { board, role };
  }

  // Images (docs/images.md): adding one is a board write, so it takes the same role as writing the room; reading takes any role.
  function requireAssetWriter(user, boardId) {
    const { role } = boardFor(user, boardId);
    if (role !== 'owner' && role !== 'editor') throw forbidden('Only editors can add images');
  }

  function requirePreviewWriter(user, boardId) {
    const { role } = boardFor(user, boardId);
    if (role !== 'owner' && role !== 'editor') throw forbidden('Only editors can add board previews');
  }

  // The asset handlers refuse with AssetError; the dispatcher answers HttpError.
  async function assetReply(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AssetError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  }

  const requireAdmin = (user) => {
    if (!isAdmin(user)) throw forbidden('Only workspace admins can do that');
  };

  // Backups and restores belong to the workspace owner alone, not to admins.
  const requireOwner = (user) => {
    if (user.role !== 'owner') throw forbidden('Only the workspace owner can do that');
  };

  // The restore engine, or the refusal that backups are not set up. Checked after who the caller is.
  function restoreEngine() {
    if (!restore) throw conflict('backups_off', 'Backups are not set up on this server');
    return restore;
  }

  // What the Backups tab shows of the engine's status: the sanitised fields the control plane already reads, and nothing else.
  const OWNER_STATUS_FIELDS = ['target', 'lastSuccessAt', 'lastFailureAt', 'lastFailureError', 'consecutiveFailures', 'nextRunAt', 'running', 'intervalMinutes', 'keyId', 'bytesStored', 'objects', 'manifests', 'dirty', 'lastTrigger', 'verifiedAt', 'missingObjects', 'wrongSizeObjects', 'unrepairableObjects', 'deepVerifiedAt', 'deepDamaged', 'deepCovered', 'tracker'];

  function ownerBackupStatus() {
    const status = backupStatus() ?? {};
    return Object.fromEntries(OWNER_STATUS_FIELDS.map((field) => [field, status[field] ?? null]));
  }

  const RESTORE_FIELDS = { 'admin/backups/restore': ['manifest', 'confirm'], 'admin/backups/restore-board': ['manifest', 'boardId'] };

  function restoreBody(route, body) {
    for (const key of Object.keys(body)) {
      if (!RESTORE_FIELDS[route].includes(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
    }
    return body;
  }

  // A refusal or failure of the restore engine as a response; anything else is a real error for dispatch to log.
  function restoreReply(err, res) {
    if (!(err instanceof RestoreError)) throw err;
    if (typeof err.extra?.retryAfter === 'number') res.setHeader('retry-after', String(err.extra.retryAfter));
    const { retryAfter: _retryAfter, ...facts } = err.extra ?? {};
    return [RESTORE_STATUS[err.code] ?? 500, { error: err.code, message: err.message, ...facts }];
  }

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
    tracker: t.tracker ?? null,
    hint: t.hint,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
  });

  // OAuth grant responses deliberately omit board ids, the resource URL and token-table data.
  const grantView = (grant) => ({
    id: grant.id,
    clientId: grant.clientId,
    clientName: grant.clientName,
    redirectHost: grant.redirectHost,
    scope: grant.scope,
    boardCount: grant.boardIds === null ? null : grant.boardIds.length,
    tracker: grant.tracker ?? null,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    expiresAt: grant.expiresAt,
  });

  // Hosted workspaces (docs/cloud.md). The limit is set by the control plane for free (comp) workspaces only; a paid workspace has none
  // and there is no billing screen to send anyone to, so the message says only what to do. The code stays seat_limit.
  const seatLimited = () =>
    conflict('seat_limit', 'This workspace has reached its member limit. Remove or disable a member to make room, or ask the workspace owner to write to us for a larger workspace.');

  // A template the caller cannot see does not exist for them (404); one they can see but not change is 403.
  function templateFor(user, id, { change = false } = {}) {
    const template = directory.getTemplateFor(user, id);
    if (!template) throw notFound('Template not found');
    if (change && !template.canChange) {
      throw forbidden(
        template.scope === 'workspace'
          ? 'Only workspace owners and admins can change a template shared with the workspace'
          : template.scope === 'team'
            ? 'Only the template owner, the team admins and workspace owners and admins can change a team template'
            : 'Only the template owner can change it',
      );
    }
    return template;
  }

  const templateView = (t, content) => ({
    id: t.id,
    version: 1,
    name: t.name,
    category: t.category,
    description: t.description,
    scope: t.scope,
    teamId: t.teamId,
    teamName: t.teamName,
    createdBy: t.ownerId ?? '',
    ownerName: t.ownerName,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    objectCount: t.objectCount,
    stepCount: t.stepCount,
    canChange: t.canChange,
    ...(content === undefined ? {} : { content: JSON.parse(content) }),
  });

  // Where a template may be put: your own, your teams' (workspace owners and admins: any team) or, for them only, everyone's.
  function checkPublish(user, scope, teamId) {
    if (scope === 'team') {
      if (directory.getTeamRole(teamId, user.id) === null && !isAdmin(user)) throw forbidden('You are not a member of that team');
      if (!directory.getTeam(teamId)) throw notFound('Team not found');
    } else if (scope === 'workspace' && !isAdmin(user)) {
      throw forbidden('Only workspace owners and admins can share a template with the whole workspace');
    }
  }

  function checkTemplateRoom(user) {
    if (directory.countTemplatesOwnedBy(user.id) >= MAX_TEMPLATES_PER_OWNER) {
      throw conflict('template_limit', `You can have at most ${MAX_TEMPLATES_PER_OWNER} templates. Delete one first.`);
    }
  }

  const templateInput = (body, options) => {
    try {
      return parseTemplateBody(body, options);
    } catch (err) {
      throw err instanceof TemplateInputError ? badRequest(err.message) : err;
    }
  };

  const chatOn = Boolean(config.chat && chat);
  // a directory without a database (a test stub, the backup-export routes) has no notification list
  const notificationStore = config.authEnabled && typeof directory?.db?.prepare === 'function'
    ? notifications ?? createNotifications({
        directory,
        trackerEnabled: config.tracker === true,
        chatStore: chat?.store ?? null,
        chatAccess: chat?.access ?? null,
        roomAccess,
        hub: chat?.hub ?? null,
        now,
      })
    : null;
  const notificationRoutes = notificationStore
    ? createNotificationRoutes({ notifications: notificationStore, digest: notificationDigest, compile, errors: { badRequest, forbidden, invalidInput: (message) => new HttpError(400, 'invalid_input', message) } })
    : [];
  const chatRoutes = chatOn
    ? createChatRoutes({
        directory,
        store: chat.store,
        access: chat.access,
        hub: chat.hub ?? null,
        limits: chat.limits ?? createChatLimits(),
        compile,
        audit,
        requireAdmin,
        notifier: chat.notifier ?? null,
        notifications: notificationStore,
        emit,
        errors: { HttpError, badRequest, forbidden, notFound, conflict },
      })
    : [];

  const trackerRoutes = config.tracker
    ? createTrackerInboxRoutes({
        directory,
        boardAccess: boardAccessForDirectory(directory),
        compile,
        errors: { HttpError, badRequest },
      })
    : [];

  const aiApi = createAiRoutes({ directory, config, compile, audit, requireAdmin, isAdmin, errors: { HttpError, badRequest, forbidden, notFound, conflict }, cloud, ...ai });
  // Link previews (docs/link-cards.md): the workspace setting is read on every request, so an admin's change applies at once.
  const linkUnfurl = createLinkUnfurl({ config, getSetting: directory.getSetting, hosted: Boolean(cloud), now, log, assets: assets?.store ?? null, ...link });
  const backupExport = backupConfig?.target === 'dir' && typeof backupConfig.pullTokenSha256 === 'string'
    ? createBackupExport({ backupConfig, dataDir, now, log })
    : null;

  const trackerBackupCheck = checkTrackerData ?? checkTrackerDataReal;
  function presenceFor(user, boardRows = directory.listBoardsFor(user)) {
    if (!user || user.role === 'guest') return [];
    const allowed = new Set(boardRows.filter((board) => directory.boardRole(board.id, user.id) !== null).map((board) => board.id));
    let rows = [];
    try {
      rows = boardPresence(user, allowed) ?? [];
    } catch (err) {
      log('boards presence: could not read live rooms', err?.message);
    }
    return Array.from(rows).filter((row) => row && allowed.has(row.boardId)
      && directory.boardRole(row.boardId, user.id) !== null);
  }

  const readinessBackupStatus = () => ({ ...backupStatus(), ...backupExport?.status?.() });
  const trackerAdminRoutes = config.authEnabled && config.tracker
    ? createTrackerAdminRoutes({
        directory,
        compile,
        audit,
        requireOwner,
        errors: { HttpError },
        backupStatus: readinessBackupStatus,
        backupConfig,
        cloud,
        reporter: keyFloorReporter,
        restore,
        floorFilePath: config.trackerKeyFloorFile ?? null,
        checkTrackerData: trackerBackupCheck,
        now,
        emit,
        log,
      })
    : [];

  // ------------------------------------------------------------ handlers

  const MOVE_FORBIDDEN_MESSAGE = 'You cannot move this board there';
  const MOVE_TOKEN_HEADERS = ['authorization', 'x-api-key', 'x-mcp-token', 'x-oauth-token', 'x-agent-token', 'x-tabula-token', 'mcp-session-id'];
  const hasTokenAuth = (req) => MOVE_TOKEN_HEADERS.some((name) => {
    const value = req.headers[name];
    return typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) && value.some((part) => String(part).trim() !== '');
  });

  function requireBoardMoveCapacity(user, boardId, res) {
    // The shared 100-hit window also enforces members' 20-hit ceiling: 81 more hits cannot fit once
    // the member has used 20. Role changes therefore keep one per-user bucket instead of resetting it.
    const userWait = boardMoveHourlyLimiter.wait(user.id, isAdmin(user) ? 1 : 81);
    const boardWait = boardMoveBoardLimiter.wait(boardId);
    const wait = Math.max(userWait, boardWait);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      throw new HttpError(429, 'rate_limited', 'Board moves are limited. Try again later.');
    }
    boardMoveHourlyLimiter.hit(user.id);
    boardMoveBoardLimiter.hit(boardId);
  }

  function requireBoardMovePreviewCapacity(user, res) {
    const wait = boardMovePreviewLimiter.hit(user.id);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      throw new HttpError(429, 'rate_limited', 'Board move previews are limited. Try again later.');
    }
  }

  function moveInputs(user, board, to) {
    const sourceId = board.teamId ?? null;
    const sourceTeam = sourceId === null ? null : directory.getTeam(sourceId);
    const enabledAdmins = sourceTeam
      ? directory.listTeamMembers(sourceId).filter((member) => member.role === 'admin' && !directory.getUser(member.userId)?.disabled)
      : [];
    const destinationTeam = to === null ? null : directory.getTeam(to);
    return {
      source: {
        id: sourceId,
        exists: sourceId === null || sourceTeam !== null,
        role: sourceId === null ? null : directory.getTeamRole(sourceId, user.id),
        // another enabled admin: an admin who is also the creator may take their own board to Personal
        hasOtherEnabledAdmin: enabledAdmins.some((member) => member.userId !== user.id),
      },
      dest: {
        id: to,
        exists: to === null || destinationTeam !== null,
        role: to === null || !destinationTeam ? null : directory.getTeamRole(to, user.id),
      },
      enabledAdmins,
    };
  }

  function moveState(userId, boardId) {
    const currentUser = directory.getUser(userId);
    const board = directory.getBoard(boardId);
    if (!currentUser || !board || board.deletedAt != null || directory.boardRole(boardId, userId) === null) {
      throw notFound('Board not found');
    }
    return { currentUser, board };
  }

  function recordBoardMoveNotices({ mover, board, from, to, enabledAdmins }) {
    if (!notificationStore) return;
    const recipients = new Set();
    if (board.ownerId && board.ownerId !== mover.id) {
      const result = notificationStore.record({
        userId: board.ownerId,
        kind: 'board_moved',
        actorId: mover.id,
        boardId: board.id,
        teamId: to,
        ref: null,
      }, { notify: false });
      if (result?.created) recipients.add(board.ownerId);
    }
    if (mover.id === board.ownerId && from !== null && enabledAdmins.length) {
      for (const admin of enabledAdmins) {
        if (admin.userId === mover.id) continue;
        const result = notificationStore.record({
          userId: admin.userId,
          kind: 'board_moved_out',
          actorId: mover.id,
          boardId: board.id,
          teamId: from,
          ref: null,
        }, { notify: false });
        if (result?.created) recipients.add(admin.userId);
      }
    }
    if (recipients.size) directory.afterCommit(() => recipients.forEach((userId) => notificationStore.ping(userId)));
  }

  function moveBoardWithinTransaction({ userId, boardId, to, expectedTeamId, res, title }) {
    const { currentUser, board } = moveState(userId, boardId);
    if (currentUser.disabled || currentUser.role === 'guest') throw forbidden(MOVE_FORBIDDEN_MESSAGE);
    if (board.teamId !== expectedTeamId) throw conflict('board_moved', 'This board has moved. Refresh and try again.');
    const role = directory.boardRole(board.id, currentUser.id);
    if (title !== undefined && role !== 'owner') throw forbidden('Only the board owner can do that');
    if (board.teamId === to) {
      if (title === undefined) return { board, moved: false };
      const renamed = directory.updateBoard(board.id, { title });
      audit(currentUser, 'board.update', { boardId: board.id, title });
      return { board: renamed, moved: false };
    }

    const { source, dest, enabledAdmins } = moveInputs(currentUser, board, to);
    const permission = canMoveBoard({ user: currentUser, board, source, dest });
    if (!permission.ok) throw forbidden(MOVE_FORBIDDEN_MESSAGE);
    requireBoardMoveCapacity(currentUser, board.id, res);
    const updated = directory.updateBoard(board.id, { teamId: to, ...(title === undefined ? {} : { title }) });
    audit(currentUser, 'board.move', { boardId: board.id, from: source.id, to, by: currentUser.id, override: permission.override });
    if (title !== undefined) audit(currentUser, 'board.update', { boardId: board.id, title });
    recordBoardMoveNotices({ mover: currentUser, board, from: source.id, to, enabledAdmins });
    return { board: updated, moved: true };
  }

  function previewBoardMove({ userId, boardId, to }) {
    const rollback = new Error('preview rollback');
    try {
      directory.transaction(() => {
        const { currentUser, board } = moveState(userId, boardId);
        const { source, dest } = moveInputs(currentUser, board, to);
        const permission = canMoveBoard({ user: currentUser, board, source, dest });
        if (!permission.ok) throw forbidden(MOVE_FORBIDDEN_MESSAGE);

        const shares = directory.listShares(board.id);
        const candidateIds = new Set();
        const candidateTeams = new Set([source.id, dest.id]);
        for (const share of shares) {
          if (share.principalType === 'user') candidateIds.add(share.principalId);
          else if (share.principalType === 'team') candidateTeams.add(share.principalId);
        }
        for (const teamId of candidateTeams) {
          if (teamId === null) continue;
          for (const member of directory.listTeamMembers(teamId)) candidateIds.add(member.userId);
        }

        const before = new Map([...candidateIds].map((id) => [id, directory.boardRole(board.id, id)]));
        const names = new Map([...candidateIds].map((id) => [id, directory.getUser(id)?.name ?? '']));
        directory.updateBoard(board.id, { teamId: to });
        const losing = [];
        const gaining = [];
        for (const id of candidateIds) {
          const previous = before.get(id) ?? null;
          const next = directory.boardRole(board.id, id);
          if (previous !== null && next === null) losing.push(id);
          if (previous === null && next !== null) gaining.push(id);
        }

        const canSeeEveryone = isAdmin(currentUser);
        const visibleIds = canSeeEveryone
          ? null
          : new Set(directory.listTeamsFor(currentUser.id).flatMap((team) => directory.listTeamMembers(team.id).map((member) => member.userId)));
        const cleanName = (id) => String(names.get(id) ?? '')
          .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 80);
        const visibleNames = (ids) => ids
          .filter((id) => canSeeEveryone || visibleIds.has(id))
          .map(cleanName)
          .filter(Boolean)
          .slice(0, 5);
        rollback.result = {
          losing: losing.length,
          gaining: gaining.length,
          sharesKept: shares.length,
          losingNames: visibleNames(losing),
          gainingNames: visibleNames(gaining),
        };
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return rollback.result;
  }

  const routes = [
    ...notificationRoutes,

    compile('GET', 'admin/privacy', {}, ({ user }) => {
      requireAdmin(user);
      return [200, privacyState()];
    }),
    compile('GET', 'admin/privacy/preview', {}, async ({ user }) => {
      requireAdmin(user);
      await dataBytesOnDisk.ready();
      collectTelemetryGauges();
      const result = telemetryCollector.snapshot();
      return [200, { ...(telemetryIdProblem ? { problem: 'workspace_id' } : {}), preview: result.clean, builtAt: telemetryCollector.lastBuiltAt, note: cloud ? 'Collected by Tabula once an hour, as shown' : 'Nothing has been sent' }];
    }),
    compile('PUT', 'admin/privacy', { body: true, readOnlyOk: true }, ({ user, body }) => {
      requireOwner(user);
      for (const key of Object.keys(body)) {
        if (key !== 'enabled') throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      }
      if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
      if (telemetryConfig.forced) throw conflict('telemetry_locked', 'TABULA_TELEMETRY controls this setting');
      directory.transaction(() => {
        directory.setSetting('telemetry.enabled', body.enabled ? '1' : '0');
        if (body.enabled) persistTelemetryInstallId();
        audit(user, body.enabled ? 'telemetry.enabled' : 'telemetry.disabled', {});
      });
      void cloud?.pushUsageNow?.();
      if (hostedWorkspaceId()) {
        if (!body.enabled) {
          telemetryCollector.resetProductAnalytics();
          // the finished hour held feature counts too: they are taken out of it for good (a later opt-in must not bring them back)
          if (completedTelemetry) completedTelemetry = dropFeatureSeries(completedTelemetry);
          if (pendingTelemetry) pendingTelemetry = dropFeatureSeries(pendingTelemetry);
          // the stored one too, so the file never holds feature series after an opt-out
          const stored = lastReport?.read();
          if (stored) lastReport.write(dropFeatureSeries(stored));
        }
      } else {
        telemetryCollector.reset();
        completedTelemetry = null;
        pendingTelemetry = null;
      }
      if (!telemetryCollectionEnabled()) {
        eventLoopDelay?.disable();
        eventLoopDelay = null;
      } else if (!eventLoopDelay) {
        eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
        eventLoopDelay.enable();
      }
      return [200, privacyState()];
    }),

    ...trackerApiRoutes,
    ...trackerLinkRoutes,
    ...trackerAdminRoutes,

    ...(backupExport
      ? [
          compile('GET', 'backup-export/list', { exportToken: true, exportKind: 'list' }, (args) => backupExport.handle('list', args)),
          compile('GET', 'backup-export/object', { exportToken: true, exportKind: 'object' }, (args) => backupExport.handle('object', args)),
        ]
      : []),

    compile('GET', 'config', { public: true }, () => [200, {
      authEnabled: config.authEnabled,
      ...(assets ? { images: true } : {}),
      ...(config.joinCodes ? { joinCodes: true } : {}),
    }]),

    compile('GET', 'me', {}, ({ user }) => [
      200,
      {
        user: userView(user),
        teams: directory.listTeamsFor(user.id).map((t) => ({ id: t.id, name: t.name, role: t.role })),
        ...(cloud ? {
          workspace: {
            ...cloud.workspaceView(),
            ...(isAdmin(user) ? { trialEndsAt: cloud.limits().trialEndsAt, state: cloud.limits().state } : {}),
          },
        } : {}),
        ...(config.mcp ? { mcp: true } : {}),
        mcpOauth: config.mcp?.oauth === true,
        ...(assets ? { images: true } : {}),
        ...(linkUnfurl.enabled() ? { linkPreviews: true } : {}),
        ...(chatOn ? { chat: true } : {}),
        ...(notificationStore ? { notifications: true } : {}),
        ...(config.joinCodes ? { joinCodes: true } : {}),
        ...(trackerCanAccess(user) ? { tracker: true } : {}),
        ...aiApi.meFlag(user),
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
      const { email, invite, oauthRequest } = body;
      if (typeof email !== 'string' || email.length > 320) throw badRequest('email must be a string');
      if (invite != null && (typeof invite !== 'string' || invite.length > 256)) throw badRequest('invite must be a string');
      const mailUnavailable = authMailUnavailable(mailer.mailHealth?.status());
      if (mailUnavailable) throw new HttpError(mailUnavailable.status, mailUnavailable.code, mailUnavailable.message);
      const result = await auth.requestLogin({ email, invite: invite ?? undefined, oauthRequest, ip: clientIp(req) });
      if (result.limited) {
        res.setHeader('retry-after', String(result.retryAfterSec));
        throw new HttpError(429, 'rate_limited', rateLimitedMessage(result));
      }
      return [200, { ok: true }];
    }),
    compile('POST', 'auth/verify', { public: true, body: true, readOnlyOk: true }, ({ req, res, body }) => {
      let result = null;
      try {
        result = typeof body.token === 'string' ? auth.verifyLogin(body.token, { userAgent: req.headers['user-agent'] }) : null;
      } catch (err) {
        if (err instanceof InviteExhaustedError) throw new HttpError(409, 'invite_exhausted', INVITE_EXHAUSTED);
        if (!(err instanceof SeatLimitError)) throw err;
        throw conflict('seat_limit', 'This workspace has reached its member limit. Ask an admin to remove or disable a member, or the workspace owner to write to us for a larger workspace, then open this link again.');
      }
      if (!result) {
        log('auth verify invalid_token');
        throw new HttpError(400, 'invalid_token', 'This link has expired. Request a new one.');
      }
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
      const grants = directory.listGrants(user.id);
      directory.transaction(() => {
        auth.logoutAll(user.id);
        directory.revokeUserGrants(user.id, 'sign_out_everywhere', now());
        auditOauthRevocations(grants, 'sign_out_everywhere', user.id);
        audit(user, 'auth.logout_all', {});
      });
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
      // No limit unless the creator sets one: one link has to be enough for a whole class.
      const maxUses = body.maxUses === undefined || body.maxUses === null ? null : body.maxUses;
      if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) throw badRequest('maxUses must be null or a whole number from 1 to 1000');
      if (cloud && !cloud.seatsAvailable()) throw seatLimited();
      const invite = directory.transaction(() => {
        const created = directory.createInvite({ teamId: team.id, role, createdBy: user.id, ttlMs: days * DAY_MS, maxUses });
        audit(user, 'invite.create', { teamId: team.id, inviteId: created.id, role, days, maxUses });
        return created;
      });
      return [
        201,
        { id: invite.id, url: `${config.baseUrl}/?invite=1#/invite/${invite.token}`, token: invite.token, expiresAt: invite.expiresAt, maxUses, uses: 0 },
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
      if (!invite && params.token && directory.inviteExhausted(params.token)) throw new HttpError(404, 'invite_exhausted', INVITE_EXHAUSTED);
      if (!invite || !team) throw notFound('This invite is not valid');
      return [200, { team: { id: team.id, name: team.name }, role: invite.role }];
    }),
    compile('POST', 'invites/:token/accept', {}, ({ user, params }) => {
      const invite = directory.findInvite(params.token);
      const team = invite ? directory.getTeam(invite.teamId) : null;
      if (!invite && directory.inviteExhausted(params.token)) throw new HttpError(404, 'invite_exhausted', INVITE_EXHAUSTED);
      if (!invite || !team) throw notFound('This invite is not valid');
      let role = directory.getTeamRole(team.id, user.id);
      if (role === null || (role === 'member' && invite.role === 'admin')) {
        const joined = role === null;
        role = invite.role;
        directory.transaction(() => {
          directory.addTeamMember(team.id, user.id, role);
          // The use is taken in one statement; if someone else took the last one meanwhile, the membership rolls back.
          if (!directory.recordInviteUse(invite.id)) throw new HttpError(409, 'invite_exhausted', INVITE_EXHAUSTED);
          if (joined && invite.createdBy) {
            notificationStore?.record({
              userId: invite.createdBy,
              kind: 'team_joined',
              actorId: user.id,
              teamId: team.id,
              ref: invite.id,
            }, { notify: false });
          }
          audit(user, 'invite.accept', { teamId: team.id, inviteId: invite.id, role });
        });
        if (joined && invite.createdBy) notificationStore?.ping(invite.createdBy);
        emit('access-changed', { userId: user.id });
      }
      return [200, { team: { id: team.id, name: team.name }, role }];
    }),

    compile('GET', 'boards/presence', {}, ({ user }) => [200, { presence: presenceFor(user) }]),
    compile('GET', 'boards', {}, ({ user }) => [200, directory.listBoardsFor(user).map((b) => boardView(b, b.role, editorLabel(b)))]),
    compile('POST', 'boards/:id/move', { body: true, cookieOnly: true }, ({ user, params, body, res }) => {
      if (user.guest === true || user.role === 'guest') throw forbidden(MOVE_FORBIDDEN_MESSAGE);
      boardFor(user, params.id);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !Object.prototype.hasOwnProperty.call(body, 'to') || !Object.prototype.hasOwnProperty.call(body, 'expectedTeamId')) {
        throw badRequest('to and expectedTeamId are required');
      }
      const to = body.to === null ? null : idField(body.to, 'to');
      const expectedTeamId = body.expectedTeamId === null ? null : idField(body.expectedTeamId, 'expectedTeamId');
      const result = directory.transaction(() => moveBoardWithinTransaction({
        userId: user.id,
        boardId: params.id,
        to,
        expectedTeamId,
        res,
      }));
      if (result.moved) emit('access-changed', { boardId: result.board.id });
      return [200, boardView(result.board, directory.boardRole(result.board.id, user.id), editorLabel(result.board))];
    }),
    compile('GET', 'boards/:id/move-preview', { cookieOnly: true }, ({ user, params, query, res }) => {
      if (user.guest === true || user.role === 'guest') throw forbidden(MOVE_FORBIDDEN_MESSAGE);
      boardFor(user, params.id);
      const requested = query.get('to');
      if (requested === null) throw badRequest('to is required');
      const to = requested === 'personal' ? null : idField(requested, 'to');
      requireBoardMovePreviewCapacity(user, res);
      const preview = directory.transaction(() => previewBoardMove({ userId: user.id, boardId: params.id, to }));
      return [200, preview];
    }),
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
      return [201, boardView(board, directory.boardRole(board.id, user.id), editorLabel(board))];
    }),
    compile('PATCH', 'boards/:id', { body: true }, ({ req, user, params, body, res }) => {
      const { board, role } = boardFor(user, params.id);
      if (body.teamId === undefined && role !== 'owner') throw forbidden('Only the board owner can do that');
      const patch = {};
      if (body.title !== undefined) patch.title = cleanText(body.title, 'title', 0, 200);
      if (body.teamId !== undefined) {
        patch.teamId = body.teamId === null ? null : idField(body.teamId, 'teamId');
        if (hasTokenAuth(req)) throw forbidden('This route requires a cookie session');
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');

      if (patch.teamId === undefined) {
        const updated = directory.transaction(() => {
          const next = directory.updateBoard(board.id, patch);
          audit(user, 'board.update', { boardId: board.id, ...patch });
          return next;
        });
        if (patch.title !== undefined) emit('board-renamed', { boardId: board.id, title: updated.title });
        return [200, boardView(updated, directory.boardRole(board.id, user.id), editorLabel(updated))];
      }

      const expectedTeamId = body.expectedTeamId === undefined
        ? board.teamId
        : body.expectedTeamId === null ? null : idField(body.expectedTeamId, 'expectedTeamId');
      const updated = directory.transaction(() => {
        return moveBoardWithinTransaction({
          userId: user.id,
          boardId: board.id,
          to: patch.teamId,
          expectedTeamId,
          res,
          title: patch.title,
        });
      });
      if (updated.moved) emit('access-changed', { boardId: board.id });
      if (patch.title !== undefined && updated.board.title !== board.title) emit('board-renamed', { boardId: board.id, title: updated.board.title });
      return [200, boardView(updated.board, directory.boardRole(updated.board.id, user.id), editorLabel(updated.board))];
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
      const wasShared = directory.listShares(board.id).some((s) => s.principalType === principalType && s.principalId === principalId);
      let notificationCreated = false;
      directory.transaction(() => {
        directory.shareBoard(board.id, { principalType, principalId, role });
        if (principalType === 'user' && principalId !== user.id && !wasShared) {
          // null when the recipient has switched shares off (docs/notifications.md, Settings): no row, no ping.
          notificationCreated = notificationStore?.record({
            userId: principalId,
            kind: 'board_shared',
            actorId: user.id,
            boardId: board.id,
          }, { notify: false })?.created === true;
        }
        audit(user, 'board.share', { boardId: board.id, principalType, principalId, role });
      });
      if (notificationCreated) notificationStore?.ping(principalId);
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

    ...(config.joinCodes && joinCodeService
      ? [
          compile('POST', 'join', { public: true, body: true, readOnlyOk: true }, ({ req, res, body }) => {
            if (typeof body.code !== 'string') throw badRequest('code must be a string');
            if (typeof body.name !== 'string') throw badRequest('name must be a string');
            const joined = joinCodeService.join({ code: body.code, name: body.name, source: clientIp(req) });
            if (joined?.limited) {
              res.setHeader('retry-after', '60');
              throw new HttpError(429, 'rate_limited', 'Too many join attempts. Try again later.');
            }
            if (joined?.badName) throw badRequest('name must be 1 to 40 characters after sanitising');
            if (!joined) throw new HttpError(404, 'invalid_join_code', JOIN_CODE_ERROR);
            res.setHeader('set-cookie', auth.sessionCookie(joined.token, joined.expiresAt - now()));
            return [201, {
              boardId: joined.boardId,
              role: joined.role,
              name: joined.name,
              guestId: `guest_${joined.id}`,
              expiresAt: joined.expiresAt,
            }];
          }),
          compile('POST', 'boards/:id/join-codes', { body: true }, ({ user, params, body }) => {
            const { board, role: boardRole } = boardFor(user, params.id);
            if (boardRole !== 'owner' && boardRole !== 'editor') throw forbidden('Only board editors can manage join codes');
            const role = oneOf(body.role, ['commenter', 'editor'], 'role');
            const hours = body.expiresInHours === undefined ? JOIN_CODE_DEFAULT_HOURS : body.expiresInHours;
            if (!Number.isInteger(hours) || hours < 1 || hours > JOIN_CODE_MAX_HOURS) throw badRequest(`expiresInHours must be a whole number from 1 to ${JOIN_CODE_MAX_HOURS}`);
            const maxUses = body.maxUses === undefined ? JOIN_CODE_DEFAULT_USES : body.maxUses;
            if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > JOIN_CODE_MAX_USES) throw badRequest(`maxUses must be a whole number from 1 to ${JOIN_CODE_MAX_USES}`);
            const code = generateJoinCode();
            const createdAt = now();
            const entry = directory.transaction(() => {
              const saved = directory.createJoinCode({
                boardId: board.id, createdBy: user.id, codeHash: joinCodeService.hashCode(code), role,
                createdAt, expiresAt: createdAt + hours * 60 * 60 * 1000, maxUses,
              });
              audit(user, 'join-code.created', { boardId: board.id, joinCodeId: saved.id, role, expiresAt: saved.expiresAt, maxUses });
              return saved;
            });
            return [201, { id: entry.id, code, role: entry.role, createdAt: entry.createdAt, expiresAt: entry.expiresAt, maxUses: entry.maxUses, uses: entry.uses }];
          }),
          compile('GET', 'boards/:id/join-codes', {}, ({ user, params }) => {
            const { role } = boardFor(user, params.id);
            if (role !== 'owner' && role !== 'editor') throw forbidden('Only board editors can manage join codes');
            return [200, directory.listJoinCodes(params.id).map(({ id, role: codeRole, createdAt, expiresAt, maxUses, uses, revokedAt }) => ({ id, role: codeRole, createdAt, expiresAt, maxUses, uses, revokedAt }))];
          }),
          compile('DELETE', 'boards/:id/join-codes/:joinCodeId', {}, ({ user, params }) => {
            const { board, role } = boardFor(user, params.id);
            if (role !== 'owner' && role !== 'editor') throw forbidden('Only board editors can manage join codes');
            const current = directory.getJoinCode(params.joinCodeId);
            if (!current || current.boardId !== board.id) throw notFound('Join code not found');
            if (current.revokedAt === null) {
              directory.transaction(() => {
                directory.revokeJoinCode(current.id, now());
                audit(user, 'join-code.revoked', { boardId: board.id, joinCodeId: current.id });
              });
              emit('access-changed', { boardId: board.id });
            }
            return [204];
          }),
        ]
      : []),

    // ---------------------------------------------------------- custom templates (docs/custom-templates.md)

    compile('GET', 'templates', {}, ({ user }) => [200, directory.listTemplatesFor(user).map((t) => templateView(t))]),
    compile('POST', 'templates', { body: true, maxBody: TEMPLATE_BODY_LIMIT }, ({ user, body }) => {
      if (user.role === 'guest') throw forbidden('Guests cannot create templates');
      const input = templateInput(body, { create: true });
      checkPublish(user, input.scope, input.teamId);
      checkTemplateRoom(user);
      const created = directory.transaction(() => {
        const id = directory.createTemplate({ ownerId: user.id, ...input });
        audit(user, 'template.create', { templateId: id, name: input.name, scope: input.scope, ...(input.teamId ? { teamId: input.teamId } : {}) });
        return id;
      });
      return [201, templateView(templateFor(user, created), input.validated.json)];
    }),
    compile('GET', 'templates/:id', {}, ({ user, params }) => {
      const template = templateFor(user, params.id);
      return [200, templateView(template, directory.getTemplateContent(template.id))];
    }),
    compile('PATCH', 'templates/:id', { body: true, maxBody: TEMPLATE_BODY_LIMIT }, ({ user, params, body }) => {
      const template = templateFor(user, params.id, { change: true });
      const patch = templateInput(body, { create: false });
      if (patch.scope === undefined && patch.teamId !== undefined) {
        if (template.scope !== 'team') throw badRequest('teamId only applies to a team template');
        patch.scope = 'team';
      }
      if (patch.scope !== undefined && (patch.scope !== template.scope || (patch.teamId ?? null) !== template.teamId)) {
        if (patch.scope === 'personal' && template.ownerId !== user.id) throw forbidden('Only the template owner can make it personal');
        checkPublish(user, patch.scope, patch.teamId);
      } else {
        delete patch.scope;
        delete patch.teamId;
      }
      if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
      const name = patch.name ?? template.name;
      const scope = patch.scope ?? template.scope;
      const teamId = scope === 'team' ? (patch.teamId ?? template.teamId) : null;
      directory.transaction(() => {
        directory.updateTemplate(template.id, patch);
        audit(user, 'template.update', { templateId: template.id, name, scope, ...(teamId ? { teamId } : {}) });
      });
      const updated = templateFor(user, template.id);
      return [200, templateView(updated, directory.getTemplateContent(template.id))];
    }),
    compile('POST', 'templates/:id/duplicate', {}, ({ user, params }) => {
      const template = templateFor(user, params.id);
      if (user.role === 'guest') throw forbidden('Guests cannot create templates');
      checkTemplateRoom(user);
      const content = directory.getTemplateContent(template.id);
      const name = copyName(template.name);
      const copy = directory.transaction(() => {
        const id = directory.createTemplate({
          ownerId: user.id,
          scope: 'personal',
          name,
          category: template.category,
          description: template.description,
          validated: { json: content, objectCount: template.objectCount, stepCount: template.stepCount },
        });
        audit(user, 'template.create', { templateId: id, name, scope: 'personal', copiedFrom: template.id });
        return id;
      });
      return [201, templateView(templateFor(user, copy), content)];
    }),
    compile('DELETE', 'templates/:id', {}, ({ user, params }) => {
      const template = templateFor(user, params.id, { change: true });
      directory.transaction(() => {
        directory.deleteTemplate(template.id);
        audit(user, 'template.delete', { templateId: template.id, name: template.name, scope: template.scope });
      });
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
      if (cloud && addsSeat(target, patch) && !cloud.seatsAvailable()) throw seatLimited();
      const oauthGrantsToRevoke = patch.disabled === true || patch.role === 'guest' ? directory.listGrants(target.id) : [];
      const updated = directory.transaction(() => {
        const next = directory.updateUser(target.id, patch);
        auditOauthRevocations(oauthGrantsToRevoke, 'user_state');
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
      const oauthGrantsToRevoke = directory.listGrants(target.id);
      directory.transaction(() => {
        auditOauthRevocations(oauthGrantsToRevoke, 'user_state');
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
          mail: mailer.mailHealth?.status() ?? { refusedRecently: 0, reason: null },
          instance: { authEnabled: true, baseUrl: config.baseUrl, mail: config.mail.mode, version: config.version ?? VERSION },
          ...(cloud ? { trialEndsAt: cloud.limits().trialEndsAt, state: cloud.limits().state } : {}),
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
      const oauthGrantsToRevoke = directory.listGrants(target.id);
      directory.transaction(() => {
        const count = directory.revokeUserSessions(target.id);
        directory.revokeUserGrants(target.id, 'sign_out_everywhere', now());
        auditOauthRevocations(oauthGrantsToRevoke, 'admin', user.id);
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
      return [200, directory.listBoardsAdmin({ includeDeleted: deleted === '1' || deleted === 'true' }).map((b) => ({ ...b, lastEditedBy: editorLabel(b) }))];
    }),
    compile('GET', 'admin/boards/:id', {}, ({ user, params }) => {
      requireAdmin(user);
      const board = directory.getBoardAdmin(params.id);
      if (!board) throw notFound('Board not found');
      return [200, { ...board, lastEditedBy: editorLabel(board) }];
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

    // ---------------------------------------------------------- backups and restore (docs/backups.md, Restoring)

    compile('GET', 'admin/backups', {}, async ({ res, user }) => {
      requireOwner(user);
      const engine = restoreEngine();
      try {
        const listing = await engine.listBackups();
        audit(user, 'backup.list', {});
        return [200, { ...listing, status: ownerBackupStatus(), restore: engine.status() }];
      } catch (err) {
        return restoreReply(err, res);
      }
    }),
    compile('GET', 'admin/backups/:name', {}, async ({ res, user, params }) => {
      requireOwner(user);
      const engine = restoreEngine();
      try {
        const preview = await engine.previewManifest(params.name);
        audit(user, 'backup.preview', { manifest: params.name });
        return [200, preview];
      } catch (err) {
        return restoreReply(err, res);
      }
    }),
    // The boards inside one backup, for the board picker. Counts only in the audit log: no title, no id, no content.
    compile('GET', 'admin/backups/:name/boards', {}, async ({ res, user, params }) => {
      requireOwner(user);
      const engine = restoreEngine();
      try {
        const listing = await engine.listBoardsInBackup(params.name, user);
        audit(user, 'backup.boards', { manifest: params.name, count: listing.boards.length });
        return [200, listing];
      } catch (err) {
        return restoreReply(err, res);
      }
    }),
    // Both POSTs stay open while a hosted workspace is read-only: an owner locked out for billing may need them. A board
    // copy writes, so it is refused while read-only; a whole restore replaces everything and is not.
    compile('POST', 'admin/backups/restore-board', { body: true, readOnlyOk: true }, async ({ res, user, body }) => {
      requireOwner(user);
      const engine = restoreEngine();
      const { manifest, boardId } = restoreBody('admin/backups/restore-board', body);
      if (typeof manifest !== 'string' || typeof boardId !== 'string') throw badRequest('manifest and boardId must be strings');
      if (cloud?.limits().readOnly) throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
      try {
        return [200, await engine.restoreBoardCopy({ manifest, boardId, actor: user })];
      } catch (err) {
        return restoreReply(err, res);
      }
    }),
    compile('POST', 'admin/backups/restore', { body: true, readOnlyOk: true }, async ({ res, user, body }) => {
      requireOwner(user);
      const engine = restoreEngine();
      const { manifest, confirm } = restoreBody('admin/backups/restore', body);
      if (typeof manifest !== 'string' || typeof confirm !== 'string') throw badRequest('manifest and confirm must be strings');
      // The server leaves once this response is out (or the caller is gone): see restoreWorkspace.
      const responseDone = new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
      });
      try {
        const done = await engine.restoreWorkspace({ manifest, confirm, actor: user, responseDone });
        return [202, { ok: true, restarting: true, keepOldFor: done.keepOldFor }];
      } catch (err) {
        return restoreReply(err, res);
      }
    }),

    // ---------------------------------------------------------- version history (docs/history.md)

    ...(history ? history.routes({ compile, boardFor, audit, errors: { HttpError, forbidden } }) : []),

    // ---------------------------------------------------------- agent activity log (TAB-158, docs/agent-presence.md)

    ...(activity && roomAccess ? activity.routes({ compile, boardFor, audit, errors: { HttpError, forbidden }, write: (name, origin, fn) => roomAccess.write(name, origin, fn), nameOf: (id) => directory.getUser(id)?.name ?? null }) : []),

    // ---------------------------------------------------------- MCP access tokens (docs/mcp.md)

    ...(config.mcp?.oauth && config.mcp.mode === 'accounts'
      ? [
          compile('GET', 'oauth/requests', {}, ({ query, user, sessionId }) => {
            const values = query.getAll('request');
            if (values.length !== 1) throw notFound('Authorization request not found');
            const context = oauthRequestContext(values[0], user, sessionId);
            if (!context) throw notFound('Authorization request not found');
            return [200, {
              clientName: context.clientName,
              clientNameIsClaim: context.clientNameIsClaim,
              provider: context.provider,
              redirectHost: context.redirectHost,
              redirectUri: context.redirectUri,
              verified: context.verified,
              maxScope: context.maxScope,
              trackerCeiling: oauthTrackerCeiling(user),
              pickerAvailable: true,
              scopes: {
                unrestricted: context.maxScope,
                boards: oauthLowerScope(context.requestCeiling, oauthBoardsMax(context.boards)),
              },
              boards: context.boards.map((board) => ({ id: board.id, name: board.title, role: board.role })),
              nonce: context.nonce,
              readOnly: context.readOnly,
            }];
          }),
          compile('POST', 'oauth/requests/decision', { body: true, readOnlyOk: true }, ({ res, user, sessionId, body }) => {
            const wait = oauthDecisionLimiter.hit(sessionId);
            if (wait) {
              res.setHeader('retry-after', String(wait));
              throw new HttpError(429, 'rate_limited', 'Too many authorization decisions. Try again later.');
            }
            if (Object.keys(body).some((key) => !['request', 'decision', 'scope', 'nonce', 'boardIds', 'tracker'].includes(key))) {
              throw badRequest('The authorization decision is not valid');
            }
            // The ticket access is chosen here and nowhere else: a scope string or a query parameter on /oauth/authorize cannot set
            // it. It is checked against the person's role at this moment, before anything else, so a refused value creates nothing.
            const chosenTracker = body.tracker === undefined || body.tracker === null ? null : body.tracker;
            if (chosenTracker !== null && (!OAUTH_TRACKER_SCOPES.includes(chosenTracker)
              || oauthTrackerRank(chosenTracker) > oauthTrackerRank(oauthTrackerCeiling(user)))) {
              throw badRequest('The selected ticket access is not available.');
            }
            if (typeof body.request !== 'string' || body.request.length > 8192 || typeof body.nonce !== 'string') {
              throw notFound('Authorization request not found');
            }
            const decision = oneOf(body.decision, ['allow', 'deny'], 'decision');
            const context = oauthRequestContext(body.request, user, sessionId);
            if (!context || !directory.verifyOAuthNonce(body.nonce, {
              requestId: context.request.requestId,
              sessionId,
              expiresAt: context.request.expiresAt,
            })) throw notFound('Authorization request not found');

            if (decision === 'deny') {
              const denied = directory.transaction(() => {
                const result = directory.decideRequest({ envelope: body.request, userId: user.id, decision: 'deny', now: now() });
                if (!result) return null;
                directory.audit(user.id, 'mcp.oauth.authorize', {
                  clientId: result.client.clientId,
                  clientName: result.client.name.slice(0, 60),
                  scope: 'none',
                  decision: 'deny',
                });
                return result;
              });
              if (!denied) throw notFound('Authorization request not found');
              return [200, { redirect: oauthCallback(denied.request, { error: 'access_denied', error_description: 'The request was denied.' }) }];
            }

            const scope = body.scope === undefined ? 'read' : oneOf(body.scope, OAUTH_SCOPES, 'scope');
            const current = oauthRequestContext(body.request, user, sessionId);
            if (!current) throw notFound('Authorization request not found');
            // Boards chosen: they are re-read now, every one must be open to this person at this moment, and the access level
            // is capped by the person's role on just those boards. Without boards the grant is unrestricted, as before.
            let boardIds = null;
            let ceiling = current.maxScope;
            if (body.boardIds !== undefined && body.boardIds !== null) {
              const ids = body.boardIds;
              if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_OAUTH_BOARD_IDS
                || ids.some((id) => typeof id !== 'string' || !TOKEN_BOARD_ID_RE.test(id)) || new Set(ids).size !== ids.length) {
                throw new HttpError(400, 'invalid_boards', `Choose 1 to ${MAX_OAUTH_BOARD_IDS} different boards you can open.`);
              }
              const open = new Map(current.boards.map((board) => [board.id, board]));
              const chosen = ids.map((id) => open.get(id));
              if (chosen.some((board) => board === undefined)) {
                throw new HttpError(400, 'invalid_boards', 'One of the chosen boards is not available to you.');
              }
              boardIds = ids;
              ceiling = oauthLowerScope(current.requestCeiling, oauthBoardsMax(chosen));
            }
            if (oauthScopeRank(scope) > oauthScopeRank(ceiling)) {
              throw new HttpError(400, 'invalid_scope', 'The selected access level is not available.');
            }
            if (cloud?.limits().readOnly) {
              throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
            }

            let allowed;
            try {
              allowed = directory.transaction(() => {
                const result = directory.decideRequest({
                  envelope: body.request,
                  userId: user.id,
                  decision: 'allow',
                  scope,
                  boardIds,
                  tracker: chosenTracker,
                  now: now(),
                });
                if (!result) return null;
                directory.audit(user.id, 'mcp.oauth.authorize', {
                  clientId: result.client.clientId,
                  clientName: result.client.name.slice(0, 60),
                  scope,
                  decision: 'allow',
                  grantId: result.grant.id,
                  tracker: chosenTracker ?? 'none',
                  ...(boardIds ? { boardCount: boardIds.length } : {}),
                });
                return result;
              });
            } catch (err) {
              if (err?.code === 'grant_limit') throw conflict('grant_limit', 'You can have at most 20 active connected apps.');
              throw err;
            }
            if (!allowed) throw notFound('Authorization request not found');
            return [200, { redirect: oauthCallback(allowed.request, { code: allowed.code }) }];
          }),
        ]
      : []),

    ...(config.mcp?.mode === 'accounts'
      ? [
          compile('GET', 'me/tokens', {}, ({ user }) => [200, directory.listAccessTokens(user.id).map(tokenView)]),
          compile('POST', 'me/tokens', { body: true }, ({ user, body }) => {
            for (const key of Object.keys(body)) {
              if (!TOKEN_FIELDS.includes(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
            }
            const name = cleanText(body.name, 'name', 1, 80);
            const scope = oneOf(body.scope, SCOPES, 'scope');
            let tracker = null;
            if (Object.hasOwn(body, 'tracker')) {
              if (!config.tracker) throw badRequest('The tracker is not turned on');
              if (body.tracker !== null) tracker = oneOf(body.tracker, ['read', 'write'], 'tracker');
            }
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
              const made = directory.createAccessToken({ userId: user.id, name, scope, boardIds, tracker, ttlMs: days * DAY_MS });
              audit(user, 'mcp.token.create', { tokenId: made.id, name, scope, boardIds, ...(tracker ? { tracker } : {}), days });
              return made;
            });
            const stored = directory.getAccessToken(created.id);
            return [201, { ...tokenView(stored), token: created.token, url: `${config.baseUrl}/mcp` }];
          }),
          compile('POST', 'me/tokens/revoke-all', { readOnlyOk: true }, ({ user }) => {
            const result = directory.transaction(() => {
              const count = directory.revokeUserAccessTokens(user.id);
              if (!config.mcp?.oauth) {
                audit(user, 'mcp.token.revoke_all', { count });
                return { count };
              }
              const grants = directory.listGrants(user.id);
              const grantCount = directory.revokeUserGrants(user.id, 'self');
              audit(user, 'mcp.token.revoke_all', { count, grants: grantCount });
              auditOauthRevocations(grants, 'self', user.id);
              return { count, grants: grantCount };
            });
            return [200, { revoked: result.count, ...(Object.hasOwn(result, 'grants') ? { grants: result.grants } : {}) }];
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
          ...(config.mcp?.oauth
            ? [
                compile('GET', 'me/grants', {}, ({ user }) => [200, directory.listGrants(user.id).map(grantView)]),
                compile('DELETE', 'me/grants/:id', { readOnlyOk: true }, ({ user, params }) => {
                  directory.transaction(() => {
                    const grant = directory.getGrant(params.id);
                    if (!grant || grant.userId !== user.id || grant.revokedAt !== null || grant.expiresAt <= now()) throw notFound('Grant not found');
                    if (!directory.revokeGrant(grant.id, 'self')) throw notFound('Grant not found');
                    auditOauthRevocations([grant], 'self', user.id);
                  });
                  return [204];
                }),
                compile('GET', 'admin/grants', {}, ({ user }) => {
                  requireAdmin(user);
                  return [200, directory.listGrantsAdmin().map((grant) => ({ ...grantView(grant), userId: grant.userId, userName: grant.userName, email: grant.email, userRole: grant.userRole }))];
                }),
                compile('POST', 'admin/grants/revoke-all', { readOnlyOk: true }, ({ user }) => {
                  requireAdmin(user);
                  const revoked = directory.transaction(() => {
                    const count = directory.revokeAllGrantsInstance('admin');
                    audit(user, 'mcp.oauth.revoke_all', { grants: count });
                    return count;
                  });
                  return [200, { revoked }];
                }),
                compile('DELETE', 'admin/grants/:id', { readOnlyOk: true }, ({ user, params }) => {
                  requireAdmin(user);
                  directory.transaction(() => {
                    const grant = directory.getGrant(params.id);
                    const owner = grant ? directory.getUser(grant.userId) : null;
                    if (!grant || !owner || grant.revokedAt !== null || grant.expiresAt <= now()) throw notFound('Grant not found');
                    guardOwner(user, owner, 'disconnect the app of');
                    if (!directory.revokeGrant(grant.id, 'admin')) throw notFound('Grant not found');
                    auditOauthRevocations([grant], grant.userId === user.id ? 'self' : 'admin', user.id);
                  });
                  return [204];
                }),
              ]
            : []),
        ]
      : []),

    // ---------------------------------------------------------- images (docs/images.md)

    ...(previewStore
      ? [
          compile('GET', 'boards/:id/preview-source', { cookieOnly: true }, ({ params, res, user }) => {
            res.setHeader('cache-control', 'private, no-store');
            res.setHeader('x-content-type-options', 'nosniff');
            const { role } = boardFor(user, params.id);
            if (role !== 'owner' && role !== 'editor') throw forbidden('Only editors can read a board preview source');
            chargePreviewAttempt([[previewSourceUserLimiter, user.id], [previewSourceBoardLimiter, params.id]], res);
            const source = roomAccess.read(params.id, (doc) => {
              const { boxes, connectors } = readAll(doc);
              const revealed = isRevealed(doc);
              return { objects: previewSourceOf([...boxes, ...connectors], revealed), revealed };
            });
            if (source.objects.length > MAX_PREVIEW_OBJECTS) throw new HttpError(413, 'too_large', 'This board has too many objects for a preview');
            return [200, source];
          }),
          compile('PUT', 'boards/:id/preview', { cookieOnly: true }, ({ req, res, params, user }) => assetReply(async () => {
            requirePreviewWriter(user, params.id);
            chargePreviewAttempt([[previewUploadBoardLimiter, params.id], [previewUploadUserLimiter, user.id]], res);
            const rawLength = req.headers['content-length'];
            if (typeof rawLength !== 'string' || !/^\d+$/.test(rawLength)) {
              throw new AssetError(411, 'length_required', 'Content-Length is required');
            }
            const declaredLength = Number(rawLength);
            if (!Number.isSafeInteger(declaredLength)) throw new AssetError(400, 'bad_request', 'Content-Length is invalid');
            if (declaredLength > MAX_PREVIEW_BYTES) throw new AssetError(413, 'payload_too_large', 'The image is too large');
            const contentType = req.headers['content-type'];
            const declaredType = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
            if (declaredType !== 'image/png' && declaredType !== 'image/webp') {
              throw new AssetError(415, 'unsupported_media_type', 'Only PNG and WebP previews are accepted');
            }
            const bytes = await readBytes(req, MAX_PREVIEW_BYTES);
            if (bytes.length !== declaredLength) throw new AssetError(400, 'bad_request', 'Content-Length does not match the request body');

            const current = auth.authenticate(req.headers.cookie);
            if (!current) throw new HttpError(401, 'unauthenticated', 'Sign in required');
            if (current.setCookie) res.setHeader('set-cookie', current.setCookie);
            if (current.user.id !== user.id) throw new HttpError(401, 'unauthenticated', 'Sign in required');
            requirePreviewWriter(current.user, params.id);

            const image = validatePreviewImage(bytes, declaredType);
            if (!image.ok) throw new AssetError(400, 'invalid_image', 'The preview image is invalid');
            if (previewDailyFull(bytes.length)) throw new AssetError(429, 'rate_limited', 'Preview uploads are limited. Try again later.');
            previewStore.put({ boardId: params.id, bytes, image, uploadedBy: current.user.id });
            previewDailyUploads.push({ at: now(), bytes: bytes.length });
            audit(current.user, 'board.preview.upload', { boardId: params.id, by: current.user.id, bytes: bytes.length });
            return [204];
          })),
          compile('GET', 'boards/:id/preview', { cookieOnly: true }, ({ req, params, user }) => {
            boardFor(user, params.id);
            const preview = previewStore.read(params.id);
            if (!preview) throw notFound('Board not found');
            const headers = {
              'content-type': preview.type,
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'",
              'cross-origin-resource-policy': 'same-origin',
              'cache-control': 'private, no-cache',
              etag: preview.etag,
            };
            const validators = (req.headers['if-none-match'] ?? '').split(',').map((part) => part.trim());
            const matches = validators.includes('*') || validators.some((value) => (value.startsWith('W/') ? value.slice(2) : value) === preview.etag);
            if (matches) return [304, undefined, headers];
            return [200, preview.bytes, headers];
          }),
        ]
      : []),

    ...(assets
      ? [
          compile('POST', 'boards/:id/assets', {}, ({ req, params, user, sessionId }) => assetReply(() => assets.handlers.upload({
            boardId: params.id,
            req,
            rateKey: `user:${user.id}`,
            userId: user.id,
            authorize: () => {
              if (user.guest) {
                const active = auth.authenticateGuest?.(req.headers.cookie);
                if (!active || active.sessionId !== sessionId || active.boardId !== params.id) throw forbidden('This guest session is no longer valid');
              }
              requireAssetWriter(user, params.id);
            },
            onCreated: (row) => audit(user, 'asset.upload', { boardId: row.boardId, hash: row.hash, bytes: row.bytes }),
          }))),
          compile('POST', 'boards/:id/assets/claim', { body: true }, ({ params, user, body }) => assetReply(() => assets.handlers.claim({
            boardId: params.id,
            body,
            userId: user.id,
            authorize: () => requireAssetWriter(user, params.id),
            mayReadFrom: (other) => {
              const board = directory.getBoard(other);
              return board != null && board.deletedAt == null && directory.boardRole(other, user.id) !== null;
            },
            onCreated: (row) => audit(user, 'asset.upload', { boardId: row.boardId, hash: row.hash, bytes: row.bytes, claimed: true }),
          }))),
          compile('GET', 'boards/:id/assets/:hash', {}, ({ req, params, user }) => {
            boardFor(user, params.id);
            return assetReply(() => (String(req.method).toUpperCase() === 'HEAD'
              ? assets.handlers.head({ boardId: params.id, hash: params.hash })
              : assets.handlers.get({ boardId: params.id, hash: params.hash, req })));
          }),
        ]
      : []),

    // ---------------------------------------------------------- link previews (docs/link-cards.md)

    compile('POST', 'boards/:id/unfurl', { body: true }, async ({ req, res, params, user, body }) => {
      // v1 decision (docs/link-cards.md): a server-side fetch is never made on behalf of a join-code guest, whatever the guest's role
      if (user.guest) throw new HttpError(403, 'guests_cannot_preview', 'Guests cannot add link previews');
      const { role } = boardFor(user, params.id);
      if (role !== 'owner' && role !== 'editor') throw forbidden('Only editors can add link cards');
      // the asker going away (a closed tab) stops the fetch, unless someone else is waiting for the same address
      const gone = new AbortController();
      const onClose = () => { if (!res.writableEnded) gone.abort(); };
      res.on('close', onClose);
      try {
        return [200, await linkUnfurl.unfurl({
          url: body.url,
          refresh: body.refresh === true,
          boardId: params.id,
          userId: user.id,
          acceptLanguage: req.headers['accept-language'],
          signal: gone.signal,
          rateKeys: { person: `user:${user.id}`, workspace: 'workspace' },
        })];
      } catch (err) {
        if (err instanceof LinkRouteError) {
          if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
          throw new HttpError(err.status, err.code, err.message);
        }
        throw err;
      } finally {
        res.off('close', onClose);
      }
    }),
    compile('GET', 'admin/link-previews', {}, ({ user }) => {
      requireAdmin(user);
      return [200, linkUnfurl.state()];
    }),
    compile('PUT', 'admin/link-previews', { body: true }, ({ user, body }) => {
      requireAdmin(user);
      for (const key of Object.keys(body)) {
        if (key !== 'enabled') throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
      }
      if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
      if (config.linkPreviews?.forced === 'off') throw conflict('link_previews_locked', 'TABULA_LINK_PREVIEWS=off turns link previews off for this server');
      directory.transaction(() => {
        directory.setSetting('linkPreviews.enabled', body.enabled ? '1' : '0');
        audit(user, body.enabled ? 'linkPreviews.enabled' : 'linkPreviews.disabled', {});
      });
      return [200, linkUnfurl.state()];
    }),

    // ---------------------------------------------------------- AI settings and keys (docs/ai.md)

    ...aiApi.routes,

    // ---------------------------------------------------------- team chat (docs/chat.md)

    ...chatRoutes,

    // ---------------------------------------------------------- tracker inbox and notification preferences (docs/mcp.md)

    ...trackerRoutes,

    // ---------------------------------------------------------- hosted workspaces (docs/cloud.md)

    ...(cloud
      ? [
          // Called by the control plane with the bearer token (`internal`), never by a browser.
          compile('GET', 'internal/usage', { internal: true }, () => [200, { ...cloud.seatUsage(), updates: { auto: cloud.autoUpgrade?.() ?? true } }]),
          // TAB-229: counts only, with no account, board or chat details.
          compile('GET', 'internal/stats', { internal: true }, () => [200, statsReport()]),
          // TAB-71: which address the rate limits see for this request, to check the proxy setup on a deploy
          compile('GET', 'internal/client-ip', { internal: true }, ({ req }) => [200, clientIpReport(req, config)]),
          // TAB-71: the public-edge check for a signed-in workspace admin; API responses are no-store.
          compile('GET', 'admin/client-ip', {}, ({ req, user }) => {
            requireAdmin(user);
            return [200, clientIpReport(req, config, { admin: true })];
          }),
          // Backups (docs/backups.md): { enabled: false } when they are off, else the engine's status (never a secret).
          compile('GET', 'internal/backup-status', { internal: true }, () => [200, backupStatus()]),
          // TAB-200: which volume this is and its last adoption (docs/cloud.md, "Volumes"); ids only.
          compile('GET', 'internal/volume', { internal: true }, () => [200, volumeStatus()]),
          // The last finished hour's telemetry report, exactly as the Privacy tab previews it (already scrubbed, at most 256 KB, no content and
          // no new identifier): 200 with the report as the body; 204 when collection is off (TABULA_TELEMETRY=off); 503 until the first hour has
          // finished. Bearer token only, like the routes around it. The control plane forwards it; the instance sends nothing itself.
          compile('GET', 'internal/telemetry', { internal: true }, () => {
            if (!telemetryCollectionEnabled()) return [204];
            const out = telemetryToHandOut();
            if (out.none) throw new HttpError(503, out.none, out.none === 'stale_report' ? 'The last report is older than an hour' : 'No hour has finished yet');
            return [200, out.report];
          }),
          // TAB-225: which build this is and which schema it and its files are on (docs/migrations.md); never a secret.
          compile('GET', 'internal/version', { internal: true }, () => [200, versionReport()]),
          compile('GET', 'admin/updates', {}, ({ user }) => {
            requireAdmin(user);
            return [200, cloud.updates()];
          }),
          compile('PUT', 'admin/updates', { body: true }, async ({ user, body }) => {
            requireOwner(user);
            for (const key of Object.keys(body)) {
              if (key !== 'auto') throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
            }
            if (typeof body.auto !== 'boolean') throw badRequest('auto must be a boolean');
            return [200, await cloud.setAutoUpgrade(body.auto, user)];
          }),
          compile('PUT', 'internal/limits', { internal: true, body: true, readOnlyOk: true }, ({ body }) => {
            const checked = validateLimits(body);
            if (checked.error) throw badRequest(checked.error);
            for (const warning of checked.warnings ?? []) console.warn(`api: ${warning}`);
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
            // a workspace provided free has no subscription to manage: say so instead of asking the control plane (409, then a 502 here)
            if (cloud.limits().billing === false) throw conflict('no_billing', 'This workspace is provided free. There is nothing to bill.');
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
      res.writeHead(status, headers);
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

  /** A guest cookie has a deliberately small HTTP surface in addition to its one permitted sync room. */
  function guestApiAllows(method, segments, guest) {
    const path = segments.join('/');
    if (method === 'GET' && path === 'config') return true;
    const [root, boardId, area, ...tail] = segments;
    if (root !== 'boards' || boardId !== guest.boardId) return false;
    const read = READ_METHODS.has(method);
    if (read && area === 'assets' && tail.length === 1) return true;
    if (read && guest.boardRole === 'editor' && area === 'versions' && (tail.length === 0 || (tail.length === 2 && tail[1] === 'state'))) return true;
    // An editor may add images to this board only; the asset store applies the same per-file and per-board quotas.
    // The unfurl path is let through only so the route can answer a guest with its own clear code; the route refuses every guest.
    if (method === 'POST' && area === 'unfurl' && tail.length === 0) return true;
    return method === 'POST' && guest.boardRole === 'editor' && area === 'assets' && tail.length === 0;
  }

  async function dispatch(req, res, pathname, query) {
    let segments;
    try {
      segments = pathname.split('/').slice(2).map(decodeURIComponent);
    } catch {
      throw badRequest('Malformed URL');
    }
    const method = String(req.method).toUpperCase();
    const requestStartedAt = now();
    const exportRoute = routes.find((route) => route.exportToken && route.parts.length === segments.length && route.parts.every((part, index) => part === segments[index]));
    if (exportRoute) {
      await exportRoute.handler({ req, res, query, method });
      return;
    }
    const guest = auth.authenticateGuest?.(req.headers.cookie) ?? null;
    if (guest && segments[0] === 'tracker') {
      if (segments[1] === 'links') throw forbidden('Guest sessions cannot use tracker links.');
      throw notFound('No such endpoint');
    }
    if (guest && !guestApiAllows(method, segments, guest)) throw forbidden('This guest session is limited to one board');
    const { route, params } = resolve(method, segments);
    if (route.cookieOnly && hasTokenAuth(req)) throw forbidden('This route requires a cookie session');

    if (route.internal) {
      // Bearer token only: no cookie, no CSRF header (a browser cannot send this one).
      if (!cloud.tokenOk(req.headers.authorization)) {
        // A refused attempt counts against its address: past thirty a minute it is answered 429 without a look at the token, and the first
        // refusal of each minute leaves one log line (the address and the route, never the header or any part of a token).
        const from = clientIp(req);
        const wait = internalAuthFailures.wait(from);
        if (wait) {
          res.setHeader('retry-after', String(wait));
          throw new HttpError(429, 'rate_limited', 'Too many refused requests. Try again later.');
        }
        if (internalAuthFailures.hit(from) === 0 && internalAuthLogged.hit(from) === 0) {
          log(`api: internal route ${route.template ?? 'unknown'} refused a request without a valid control token (address ${from})`);
        }
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
    if (typeof res.once === 'function' && config.slowRequestMs > 0) res.once('finish', () => {
      // For the operator reading logs after a slow moment: route pattern, status and time only, never a path with ids or a user.
      const ms = Math.max(0, now() - requestStartedAt);
      if (ms >= config.slowRequestMs) log(`slow request ${route.method} ${route.template ?? 'other'} ${res.statusCode} ${ms}ms`);
    });
    if (typeof res.once === 'function') res.once('finish', () => {
      try {
        const responseAt = now();
        const live = (() => { try { return liveStats() ?? {}; } catch { return {}; } })();
        const connections = Number.isSafeInteger(live.connections) && live.connections >= 0 ? live.connections : 0;
        updateTelemetryConnectionPeak(connections, responseAt);
        const statusClass = `${Math.floor(Number(res.statusCode) / 100)}xx`;
        telemetryCollector.count('http_requests_total', { route: route.template ?? 'other', status_class: statusClass });
        telemetryCollector.observe('http_duration_ms', Math.max(0, responseAt - requestStartedAt), { route: route.template ?? 'other' });
        telemetryCollector.gauge('ws_connections_peak', telemetryConnectionPeak);
        if (session?.user && res.statusCode < 400) telemetryLastActivityAt = responseAt;
      } catch { /* local aggregate collection cannot affect a response */ }
    });
    if (route.tracker) {
      try {
        ticketAccess({ type: 'user', userId: session?.user?.id, user: session?.user }, { id: 'tracker-access-check' });
      } catch {
        throw notFound('No such endpoint');
      }
    }
    if (cloud && !route.readOnlyOk && !READ_METHODS.has(method) && cloud.limits().readOnly) {
      if (route.trackerMutation && !route.trackerMutationGenericReadOnly) throw new HttpError(403, 'read_only', 'This workspace is read-only.');
      throw new HttpError(402, 'read_only', 'This workspace is read-only. Ask the workspace owner to check billing.');
    }
    if (route.trackerMutation) requireTrackerMutationCapacity(session.user, res, {
      gateExempt: route.trackerGateExempt === true,
      ownerOnly: route.trackerMutationOwnerOnly === true,
    });
    const body = route.body && BODY_METHODS.has(method)
      ? await readJson(req, route.maxBody ?? MAX_BODY, { rejectDuplicateMappingKeys: route.trackerLink === true })
      : {};
    // A body can take a while to arrive: judge the request by who the caller is now, not when it started.
    if (session && route.body) {
      session = signedIn();
      if (route.tracker) {
        try {
          ticketAccess({ type: 'user', userId: session.user.id, user: session.user }, { id: 'tracker-access-check' });
        } catch {
          throw notFound('No such endpoint');
        }
      }
    }

    const answer = await route.handler({
      req,
      res,
      params,
      query,
      body,
      user: session?.user,
      sessionId: session?.sessionId,
      session,
    });
    // a streaming route (POST /api/ai/run) has written and ended the response itself
    if (route.stream) return;
    const [status, payload, headers] = answer;
    if (status < 400 && !READ_METHODS.has(method)) onChange();
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
    const method = String(req.method).toUpperCase();
    if (maintenance() && !(pathname === '/api/internal/backup-status' && method === 'GET')) {
      res.setHeader('retry-after', '30');
      // Same disclosure as the generic reply, with the code the tracker client reads. No auth, no directory read, no route.
      if (method === 'POST' && pathname === '/api/admin/tracker/key-epoch') {
        send(res, 503, { error: 'tracker_restoring', message: 'Ticket writes are paused while the workspace is being restored.', floor: 'pending' });
      } else {
        send(res, 503, { error: 'restoring', message: 'The workspace is being restored from a backup. Try again in a minute.' });
      }
      return true;
    }
    try {
      // Whole-workspace restore takes its safety backup from inside this handler; that backup must be allowed to acquire
      // the same barrier. Maintenance mode takes over the writers immediately after the safety copy succeeds.
      // A streaming AI run lasts minutes and writes boards through the room, not the directory, so it must not hold a lease that would stall every other writer.
      if (snapshotBarrier && !READ_METHODS.has(method) && pathname !== '/api/admin/backups/restore' && pathname !== '/api/ai/run') {
        await snapshotBarrier.runWriter(() => dispatch(req, res, pathname, query));
      } else {
        await dispatch(req, res, pathname, query);
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      if (err instanceof HttpError) {
        if (err.allow) res.setHeader('allow', err.allow);
        if (err.status === 413) res.setHeader('connection', 'close');
        send(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else if (err instanceof OpsError) {
        const statuses = {
          invalid_input: 400,
          invalid_filter: 400,
          not_found: 404,
          forbidden: 403,
          conflict: 409,
          state_not_mapped: 422,
          read_only: 403,
          limit_exceeded: 413,
          tracker_restoring: 503,
        };
        const status = statuses[err.code] ?? 400;
        if (status === 413) res.setHeader('connection', 'close');
        send(res, status, {
          error: err.code,
          message: err.message,
          ...(err.path ? { path: err.path } : {}),
          ...(err.ticket ? { ticket: err.ticket } : {}),
          ...(err instanceof TrackerRestoringError ? { floor: err.floor } : {}),
        });
      } else {
        console.error('api: unexpected error:', describeError(err));
        send(res, 500, { error: 'internal', message: 'Something went wrong' });
      }
    }
    return true;
  }

  return { handle, captureTelemetryHour, telemetryTick, flushTelemetry };
}
