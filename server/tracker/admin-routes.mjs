import { createWindowLimiter } from '../limiter.mjs';
import { createTrackerReadiness } from './readiness.mjs';
import { epochJump, KEY_FLOOR_CHANGED_EVENT } from './key-floor.mjs';
import { markGateFloorKnown, maybeClearGate, TRACKER_RESTORE_GATE_KEY } from './gate.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DRILL_BOX_IDS = new Set([
  'seed', 'barrier_backup', 'restore_workspace', 'lost_keys_not_reissued', 'gate_cycle', 'reconcile_boards',
  'search_rebuilt', 'hosted_floor_available', 'hosted_floor_unknown', 'board_copy_stripped', 'history_restore',
  'key_rotation', 'damaged_search', 'missing_room_file', 'schema_too_new', 'no_text_in_logs',
  'slice8_secrets_ciphertext', 'slice8_inbound_recovered', 'slice8_delivery_retry_safe', 'slice8_connection_health',
]);

function invalid(errors, code, message) {
  return new errors.HttpError(400, code, message);
}

function matchesFields(body, fields) {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((key) => fields.includes(key));
}

function normalizeDrillAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateDrill(body) {
  const fields = ['at', 'kind', 'schema', 'restoreSeconds', 'dataLossSeconds', 'boxes', 'overall'];
  if (!matchesFields(body, fields) || Object.keys(body).length !== fields.length) return null;
  const at = normalizeDrillAt(body.at);
  if (at === null || !['production', 'local'].includes(body.kind)
    || !Number.isSafeInteger(body.schema) || body.schema <= 0
    || !Number.isFinite(body.restoreSeconds) || body.restoreSeconds < 0 || body.restoreSeconds > 1e7
    || !Number.isFinite(body.dataLossSeconds) || body.dataLossSeconds < 0 || body.dataLossSeconds > 1e7
    || !Array.isArray(body.boxes) || body.boxes.length > 40
    || !['pass', 'fail'].includes(body.overall)) return null;
  const boxes = [];
  for (const box of body.boxes) {
    if (!box || typeof box !== 'object' || Array.isArray(box) || !matchesFields(box, ['id', 'result'])
      || Object.keys(box).length !== 2 || !DRILL_BOX_IDS.has(box.id)
      || typeof box.result !== 'string' || box.result.length < 1 || box.result.length > 40
      || !/^[a-z0-9_ .:-]+$/i.test(box.result)) return null;
    boxes.push({ id: box.id, result: box.result });
  }
  return {
    at,
    kind: body.kind,
    schema: body.schema,
    restoreSeconds: body.restoreSeconds,
    dataLossSeconds: body.dataLossSeconds,
    boxes,
    overall: body.overall,
  };
}

function validCutoverDate(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return false;
  return value <= new Date(now()).toISOString().slice(0, 10);
}

/** Owner-only tracker readiness and attestation routes. */
export function createTrackerAdminRoutes({
  directory,
  compile,
  audit,
  requireOwner,
  errors,
  backupStatus = () => ({}),
  backupConfig = null,
  cloud = null,
  reporter = null,
  restore = null,
  floorFilePath = null,
  checkTrackerData = null,
  now = Date.now,
  emit = () => {},
  log = () => {},
} = {}) {
  const readiness = createTrackerReadiness({
    directory, backupStatus, backupConfig, cloud, reporter, floorFilePath, checkTrackerData, now, log,
  });
  const readinessLimiter = createWindowLimiter(60, now);
  const epochLimiter = createWindowLimiter(5, now, HOUR_MS);
  const limited = (limiter, user, res, label) => {
    const retryAfter = limiter.hit(user.id);
    if (!retryAfter) return;
    res.setHeader('retry-after', String(retryAfter));
    throw new errors.HttpError(429, 'rate_limited', label);
  };
  const auditRecord = (user, action, detail) => audit(user, action, detail);

  return [
    compile('GET', 'admin/tracker/readiness', {}, ({ user, res }) => {
      requireOwner(user);
      limited(readinessLimiter, user, res, 'Tracker readiness is limited to 60 requests per minute.');
      return [200, readiness.get()];
    }),
    compile('POST', 'admin/tracker/key-epoch', { body: true, readOnlyOk: true }, ({ user, res, body }) => {
      requireOwner(user);
      if (!matchesFields(body, ['confirm']) || body.confirm !== 'JUMP') {
        throw invalid(errors, 'key_epoch_confirmation_mismatch', 'Type JUMP to confirm the ticket key epoch change.');
      }
      if (restore?.isRunning?.()) {
        const error = new errors.HttpError(503, 'tracker_restoring', 'Ticket writes are paused while the workspace is being restored.');
        error.extra = { floor: 'pending' };
        throw error;
      }
      limited(epochLimiter, user, res, 'Ticket key epoch changes are limited to 5 per hour.');
      const counters = epochJump(directory.db, now());
      directory.transaction(() => {
        auditRecord(user, 'tracker.key_epoch', { counters });
        if (directory.getSetting(TRACKER_RESTORE_GATE_KEY) !== null) markGateFloorKnown(directory);
      });
      // Part B owns the reconcile and FTS completion signals; these true values are its hook point.
      const gateCleared = maybeClearGate(directory.db, {
        floorKnown: true,
        reconcileDone: true,
        ftsReady: true,
        now,
      }, (action, detail) => auditRecord(user, action, detail));
      readiness.invalidate();
      if (counters.length) emit(KEY_FLOOR_CHANGED_EVENT);
      return [200, { counters, gateCleared }];
    }),
    compile('POST', 'admin/tracker/drill-record', { body: true, readOnlyOk: true }, ({ user, body }) => {
      requireOwner(user);
      const record = validateDrill(body);
      if (!record) throw invalid(errors, 'drill_record_invalid', 'The tracker drill record is invalid.');
      directory.transaction(() => {
        directory.setSetting('tracker.drill.last', JSON.stringify(record));
        auditRecord(user, 'tracker.drill_record', { kind: record.kind });
      });
      readiness.invalidate();
      return [200, record];
    }),
    compile('POST', 'admin/tracker/cutover-record', { body: true, readOnlyOk: true }, ({ user, body }) => {
      requireOwner(user);
      if (!matchesFields(body, ['importVerifiedAt', 'lossReportAccepted']) || Object.keys(body).length !== 2
        || !validCutoverDate(body.importVerifiedAt, now) || body.lossReportAccepted !== true) {
        throw invalid(errors, 'cutover_record_invalid', 'The tracker cutover record is invalid.');
      }
      const record = { importVerifiedAt: body.importVerifiedAt, lossReportAccepted: true };
      directory.transaction(() => {
        directory.setSetting('tracker.cutover.record', JSON.stringify(record));
        auditRecord(user, 'tracker.cutover_record', { importVerifiedAt: record.importVerifiedAt });
      });
      readiness.invalidate();
      return [200, record];
    }),
  ];
}
