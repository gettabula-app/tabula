import http from 'node:http';
import { reportToLoki, reportToRows, reportToVm } from './map.mjs';
import { createLimiter } from './ratelimit.mjs';
import { createRegistry } from './registry.mjs';
import { createSinks } from './sinks.mjs';
import { appendRows } from './spool.mjs';
import { claimHour, isAllowed, isDeleting, releaseHour } from './state.mjs';
import { validateReport } from './validate.mjs';

const BEARER = /^Bearer ([^\s]+)$/u;

/**
 * The collector HTTP service.
 *   POST /v1/telemetry   hourly report, `Authorization: Bearer tt_...`, JSON body
 *   GET  /healthz        liveness, no data
 *   GET  /metrics        the collector's own counters (the reverse proxy does not route it)
 */
/** @param {ReturnType<typeof import('./config.mjs').loadConfig>} config @param {{ log?: any, fetchImpl?: typeof fetch, now?: () => number }} [options] */
export function createCollector(config, { log, fetchImpl = fetch, now = Date.now } = {}) {
  const registry = createRegistry(config.registryFile);
  const sinks = createSinks({
    vmUrl: config.vmUrl, lokiUrl: config.lokiUrl, fetchImpl, log, now, retryMs: config.sinkRetryMs,
    maxAgeMs: config.sinkMaxAgeMs, maxQueue: config.sinkMaxQueue, timeoutMs: config.sinkTimeoutMs,
    isBlocked: (workspace) => isDeleting(config, workspace),
  });
  // before the body is read: per token (a workspace token is held to its own budget, a control-plane token to the fleet ceiling)
  const tokenLimiter = createLimiter({ limit: config.ratePerHour, windowMs: 3_600_000 });
  const controlLimiter = createLimiter({ limit: config.fleetRatePerHour * 4, windowMs: 3_600_000 });
  // after validation: per workspace id, and one fleet-wide ceiling
  const workspaceLimiter = createLimiter({ limit: config.ratePerHour, windowMs: 3_600_000 });
  const fleetLimiter = createLimiter({ limit: config.fleetRatePerHour, windowMs: 3_600_000, maxKeys: 1 });
  const failLimiter = createLimiter({ limit: config.authFailuresPerMinute, windowMs: 60_000 });
  const counters = { accepted: 0, rejected: Object.create(null), spoolFailures: 0 };

  const reject = (res, status, error, extra = {}, headers = {}) => {
    counters.rejected[error] = (counters.rejected[error] ?? 0) + 1;
    send(res, status, { ok: false, error, ...extra }, headers);
  };

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
    res.end(text);
  }

  function clientKey(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function readBody(req) {
    return new Promise((resolve, reject2) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) { reject2(Object.assign(new Error('too large'), { code: 'E2BIG' })); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject2);
    });
  }

  async function ingest(req, res) {
    const client = clientKey(req);
    const header = BEARER.exec(String(req.headers.authorization ?? ''));
    const auth = header ? registry.verify(header[1]) : null;
    if (!auth) {
      const limited = !failLimiter.hit(client, now()).ok;
      if (limited) return reject(res, 429, 'too_many_auth_failures', {}, { 'retry-after': '60' });
      return reject(res, 401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' });
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return reject(res, 415, 'unsupported_media_type');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) return reject(res, 413, 'payload_too_large');
    const rate = (auth.workspace === null ? controlLimiter : tokenLimiter).hit(auth.id, now());
    if (!rate.ok) return reject(res, 429, 'rate_limited', {}, { 'retry-after': String(Math.ceil(rate.retryAfterMs / 1000)) });

    let text;
    try { text = await readBody(req); } catch (error) {
      if (error?.code === 'E2BIG') return reject(res, 413, 'payload_too_large');
      return reject(res, 400, 'bad_request');
    }
    let body;
    try { body = JSON.parse(text); } catch { return reject(res, 400, 'invalid_json'); }

    const checked = validateReport(body, { workspace: auth.workspace, now: now(), maxAgeMs: config.maxReportAgeMs });
    if (!checked.ok) {
      log?.warn('report_rejected', { token: auth.id, error: checked.error, dropped: checked.dropped?.total ?? 0 });
      return reject(res, checked.status, checked.error, checked.dropped ? { dropped: checked.dropped } : {});
    }
    const { clean } = checked;
    if (isDeleting(config, clean.workspace)) return reject(res, 410, 'workspace_deleted');
    if (auth.workspace === null && !isAllowed(config, clean.workspace)) return reject(res, 403, 'workspace_not_allowed');
    const perWorkspace = workspaceLimiter.hit(clean.workspace, now());
    const fleet = perWorkspace.ok ? fleetLimiter.hit('fleet', now()) : { ok: true, retryAfterMs: 0 };
    if (!perWorkspace.ok || !fleet.ok) {
      const wait = Math.max(perWorkspace.retryAfterMs, fleet.retryAfterMs);
      return reject(res, 429, perWorkspace.ok ? 'fleet_rate_limited' : 'rate_limited', {}, { 'retry-after': String(Math.ceil(wait / 1000)) });
    }
    // replay protection: an exclusive file per workspace and hour, so it survives a restart
    if (!claimHour(config, clean.workspace, clean.hour)) return reject(res, 409, 'duplicate_hour');

    const receivedAt = now();
    try {
      if (isDeleting(config, clean.workspace)) throw Object.assign(new Error('deleting'), { code: 'EDELETING' });
      await appendRows(config.lakeDir, reportToRows(clean, receivedAt), receivedAt);
    } catch (error) {
      releaseHour(config, clean.workspace, clean.hour);
      if (error?.code === 'EDELETING') return reject(res, 410, 'workspace_deleted');
      counters.spoolFailures += 1;
      log?.error('spool_failed', { reason: String(error?.code ?? 'error') });
      return reject(res, 503, 'storage_unavailable', {}, { 'retry-after': '60' });
    }

    const delivered = await sinks.push({ vm: reportToVm(clean, receivedAt), loki: reportToLoki(clean), workspace: clean.workspace });
    counters.accepted += 1;
    log?.info('report_accepted', {
      token: auth.id, workspace: clean.workspace, hour: clean.hour, metrics: clean.metrics.length,
      errors: clean.errors.length, events: clean.events.length, vm: delivered.vm, loki: delivered.loki,
    });
    send(res, 200, { ok: true, accepted: { metrics: clean.metrics.length, errors: clean.errors.length, events: clean.events.length }, sinks: delivered });
  }

  function metricsText() {
    const lines = ['# TYPE tabula_collector_reports_accepted_total counter', `tabula_collector_reports_accepted_total ${counters.accepted}`];
    lines.push('# TYPE tabula_collector_reports_rejected_total counter');
    for (const [reason, n] of Object.entries(counters.rejected)) lines.push(`tabula_collector_reports_rejected_total{reason="${reason}"} ${n}`);
    lines.push('# TYPE tabula_collector_spool_failures_total counter', `tabula_collector_spool_failures_total ${counters.spoolFailures}`);
    lines.push('# TYPE tabula_collector_sink_queue gauge', `tabula_collector_sink_queue ${sinks.queueLength}`);
    for (const [what, perSink] of Object.entries(sinks.stats)) {
      for (const [sink, n] of Object.entries(perSink)) lines.push(`tabula_collector_sink_${what}_total{sink="${sink}"} ${n}`);
    }
    return `${lines.join('\n')}\n`;
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const handler = async () => {
      if (url === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, sinkQueue: sinks.queueLength });
      if (url === '/metrics' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(metricsText());
      }
      if (url === '/v1/telemetry') {
        if (req.method !== 'POST') return reject(res, 405, 'method_not_allowed', {}, { allow: 'POST' });
        return ingest(req, res);
      }
      return reject(res, 404, 'not_found');
    };
    handler().catch((error) => {
      log?.error('request_failed', { reason: String(error?.code ?? error?.name ?? 'error') });
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal_error' });
      else res.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.on('close', () => sinks.close());

  return { server, sinks, counters };
}
