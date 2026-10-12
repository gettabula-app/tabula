// Instance-side helpers for the hourly report that the control plane pulls (docs/telemetry-design.md, section 1a). Not part of the files
// that are copied to tabula-cloud.
import { PRODUCT_ANALYTICS_METRICS } from './collector.mjs';
import { TELEMETRY_SCHEMA } from './schema.mjs';

/**
 * The report without its feature-use series: what an owner who turned product analytics off may be handed. Operating series stay.
 * Returns a new object; the report it was given is not changed.
 */
export function dropFeatureSeries(report) {
  if (!report || !Array.isArray(report.metrics)) return report;
  return { ...report, metrics: report.metrics.filter((metric) => !PRODUCT_ANALYTICS_METRICS.has(metric?.name)) };
}

/**
 * The release label as the report's `app_version` field allows it (`v1.2.3`, or a 7 to 12 character git hash). TABULA_VERSION may be
 * `5.3.1`, `v5.3.1`, a date such as `2026.10.09-1`, or a hash: the leading numbers become the version (`v2026.10.09`), a hash stays, and
 * anything else is the build's default. A label the schema would refuse must never cost the whole report.
 */
export function appVersionLabel(label, fallback = 'v0.1.0') {
  if (typeof label !== 'string') return fallback;
  const text = label.trim();
  // a hash has a letter in it (`abc1234`); digits alone are a version
  if (/^[0-9a-f]{7,12}$/u.test(text) && /[a-f]/u.test(text)) return text;
  const numbers = /^v?(\d+(?:\.\d+){0,2})(?![\d.])/u.exec(text);
  if (numbers) return `v${numbers[1]}`;
  return fallback;
}

/** Whether product analytics (the feature-use series) is on: the operator's value wins, then the owner's saved choice, then the default. */
export function analyticsChoice(telemetryConfig, getSetting, hosted) {
  const config = telemetryConfig ?? { defaultEnabled: hosted, forced: null };
  if (config.forced) return config.forced === 'on';
  const saved = typeof getSetting === 'function' ? getSetting('telemetry.enabled') : null;
  if (saved === '1') return true;
  if (saved === '0') return false;
  return config.defaultEnabled === true;
}

const WORKSPACE_PATTERN = new RegExp(TELEMETRY_SCHEMA.envelope.fields.workspace.pattern, 'u');

/** Whether a workspace id fits the report schema; an id that does not makes every report fail the scrubber (so none is built). */
export function workspaceIdValid(id) {
  return typeof id === 'string' && WORKSPACE_PATTERN.test(id);
}
