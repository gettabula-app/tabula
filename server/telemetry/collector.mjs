// Copied to tabula-cloud/src/telemetry unchanged.
import { getMetricDefinition } from './schema.mjs';
import { scrubReport } from './scrub.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MAX_LABEL_COMBINATIONS = 200;
// Feature-use series follow the owner's product-analytics choice. Capacity,
// backup/restore health, and process series remain available when it is off.
export const PRODUCT_ANALYTICS_METRICS = new Set([
  'mcp_calls_total', 'oauth_events_total', 'tracker_ops_total', 'chat_messages_total', 'uploads_total', 'upload_bytes',
  'ai_calls_total', 'client_sessions_total', 'ui_events_total',
]);

function hourStart(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {{ enabled?: () => boolean, analyticsEnabled?: () => boolean, now?: () => number, envelope?: () => Record<string, unknown> }} [options] */
export function createTelemetryCollector({ enabled = () => false, analyticsEnabled = enabled, now = Date.now, envelope = () => ({}) } = {}) {
  let hour = hourStart(now());
  let lastBuiltAt = null;
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();
  const combinations = new Map();

  function clear(at = now()) {
    hour = hourStart(at);
    lastBuiltAt = null;
    counters.clear();
    gauges.clear();
    histograms.clear();
    combinations.clear();
  }

  function analyticsActive() {
    try { return analyticsEnabled() === true; } catch { return false; }
  }

  function ready(name = null) {
    let active = false;
    try { active = enabled() === true; } catch { active = false; }
    const nextHour = hourStart(now());
    if (nextHour !== hour) clear(nextHour);
    if (!active && (counters.size || gauges.size || histograms.size)) clear(nextHour);
    return active && !(name && PRODUCT_ANALYTICS_METRICS.has(name) && !analyticsActive());
  }

  function definition(name, kind) {
    if (typeof name !== 'string') return null;
    const def = getMetricDefinition(name);
    return def?.kind === kind ? def : null;
  }

  function normalizeLabels(def, labels) {
    if (!isRecord(labels)) return null;
    const labelDefs = def.labels ?? {};
    const clean = {};
    for (const [key, spec] of Object.entries(labelDefs)) {
      const values = Array.isArray(spec) ? spec : spec?.values;
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) return null;
      let value = labels[key];
      if (typeof value !== 'string' || !values.includes(value)) value = values.includes('other') ? 'other' : null;
      if (value === null) return null;
      clean[key] = value;
    }
    return clean;
  }

  function keyFor(name, labels) {
    return JSON.stringify([name, Object.keys(labels).sort().map((key) => [key, labels[key]])]);
  }

  function reserve(name, labels) {
    const key = keyFor(name, labels);
    let keys = combinations.get(name);
    if (!keys) combinations.set(name, (keys = new Set()));
    if (!keys.has(key)) {
      if (keys.size >= MAX_LABEL_COMBINATIONS) return null;
      keys.add(key);
    }
    return key;
  }

  function count(name, labels = {}, n = 1) {
    if (!ready(name)) return false;
    const def = definition(name, 'counter');
    if (!def || !Number.isSafeInteger(n) || n < 1) return false;
    const cleanLabels = normalizeLabels(def, labels);
    if (!cleanLabels) return false;
    const key = reserve(name, cleanLabels);
    if (key === null) return false;
    const max = Number.isSafeInteger(def.max) ? def.max : Number.MAX_SAFE_INTEGER;
    counters.set(key, Math.min(max, (counters.get(key) ?? 0) + n));
    return true;
  }

  function gauge(name, value, labels = {}) {
    if (!ready(name)) return false;
    const def = definition(name, 'gauge');
    if (!def || !Number.isSafeInteger(value) || value < (def.min ?? 0) || value > (def.max ?? Number.MAX_SAFE_INTEGER)) return false;
    const cleanLabels = normalizeLabels(def, labels);
    if (!cleanLabels) return false;
    const key = reserve(name, cleanLabels);
    if (key === null) return false;
    gauges.set(key, value);
    return true;
  }

  function observe(name, ms, labels = {}) {
    if (!ready(name)) return false;
    const def = definition(name, 'histogram');
    if (!def || !Number.isSafeInteger(ms) || ms < 0) return false;
    const cleanLabels = normalizeLabels(def, labels);
    if (!cleanLabels) return false;
    const key = reserve(name, cleanLabels);
    if (key === null) return false;
    let state = histograms.get(key);
    const bounds = Array.isArray(def.buckets) ? def.buckets : [];
    if (!state) {
      state = { count: 0, sum: 0, raw: Array.from({ length: bounds.length + 1 }, () => 0) };
      histograms.set(key, state);
    }
    state.count = Math.min(Number.MAX_SAFE_INTEGER, state.count + 1);
    state.sum = Math.min(Number.MAX_SAFE_INTEGER, state.sum + ms);
    let bucket = bounds.findIndex((bound) => ms <= bound);
    if (bucket < 0) bucket = bounds.length;
    state.raw[bucket] = Math.min(Number.MAX_SAFE_INTEGER, state.raw[bucket] + 1);
    return true;
  }

  function snapshot() {
    const active = ready();
    const includeMetric = (name) => !PRODUCT_ANALYTICS_METRICS.has(name) || analyticsActive();
    const metrics = [];
    if (active) {
      for (const [key, value] of counters) {
        const [name, labels] = JSON.parse(key);
        if (!includeMetric(name)) continue;
        metrics.push({ name, labels: Object.fromEntries(labels), value });
      }
      for (const [key, value] of gauges) {
        const [name, labels] = JSON.parse(key);
        if (!includeMetric(name)) continue;
        metrics.push({ name, labels: Object.fromEntries(labels), value });
      }
      for (const [key, state] of histograms) {
        const [name, labels] = JSON.parse(key);
        if (!includeMetric(name)) continue;
        let cumulative = 0;
        const buckets = state.raw.map((count) => (cumulative += count));
        metrics.push({ name, labels: Object.fromEntries(labels), value: { count: state.count, sum: state.sum, buckets } });
      }
    }
    const current = now();
    const source = envelope() ?? {};
    const report = {
      ...source,
      schema: 1,
      hour,
      metrics,
      errors: [],
      events: [],
      alerts: [],
    };
    const result = scrubReport(report);
    lastBuiltAt = current;
    return result;
  }

  function reset() {
    clear(now());
  }

  function resetProductAnalytics() {
    for (const series of [counters, gauges, histograms]) {
      for (const key of series.keys()) {
        const [name] = JSON.parse(key);
        if (PRODUCT_ANALYTICS_METRICS.has(name)) series.delete(key);
      }
    }
    for (const name of PRODUCT_ANALYTICS_METRICS) combinations.delete(name);
  }

  return {
    count,
    observe,
    gauge,
    snapshot,
    reset,
    resetProductAnalytics,
    get lastBuiltAt() { return lastBuiltAt; },
    get hour() { return hour; },
  };
}
