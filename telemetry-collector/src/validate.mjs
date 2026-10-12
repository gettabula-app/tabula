import { scrubReport } from '../../server/telemetry/scrub.mjs';
import { WORKSPACE_RE } from './registry.mjs';

const HOUR_MS = 60 * 60 * 1000;

function fail(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

/**
 * Validate a report with the instance-side scrubber. The scrubber drops what it does not know; the collector instead
 * REJECTS the whole report when anything was dropped, so an unknown key, free text or anything that looks like an email,
 * URL, IP address or token never reaches a store. The reply names counts and reason codes only, never the offending value.
 * @param {unknown} body
 * @param {{ workspace: string | null, now?: number, maxAgeMs?: number }} options token binding and clock
 */
export function validateReport(body, { workspace, now = Date.now(), maxAgeMs = 72 * HOUR_MS }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(422, 'invalid_report');
  const input = { ...body };
  const claimed = input.workspace;
  if (workspace !== null) {
    if (claimed !== undefined && claimed !== workspace) return fail(403, 'workspace_mismatch');
    input.workspace = workspace;
  } else if (typeof claimed !== 'string' || !WORKSPACE_RE.test(claimed)) {
    return fail(422, 'workspace_required');
  }
  // A fleet snapshot (the control plane's own data about a workspace) is accepted from the control-plane token only; a workspace-bound token is refused.
  const fleet = input.kind === 'fleet';
  if (fleet && workspace !== null) return fail(403, 'fleet_requires_control_plane');
  const { clean, dropped } = fleet ? scrubReport(input, { source: 'control_plane' }) : scrubReport(input);
  if (!clean || dropped.total > 0) {
    return fail(422, 'invalid_report', { dropped: { total: dropped.total, byReason: { ...dropped.byReason } } });
  }
  if (typeof clean.hour !== 'number' || typeof clean.workspace !== 'string') return fail(422, 'invalid_report');
  if (clean.hour > now + HOUR_MS || clean.hour < now - maxAgeMs) return fail(422, 'hour_out_of_range');
  return { ok: true, clean };
}
