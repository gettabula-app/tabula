// Copied to tabula-cloud/src/telemetry unchanged.

import {
  TELEMETRY_SCHEMA,
  getEventDefinition,
  getMetricDefinition,
} from './schema.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REASONS = new Set(TELEMETRY_SCHEMA.droppedReasons);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;
const SENSITIVE_TEXT = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /(?:https?|ftp):\/\/|\bwww\./iu,
  /(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:\D|$)/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
  /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
  /\b(?:access[_-]?token|api[_-]?key|secret|token)[_-][A-Za-z0-9_-]{8,}\b/iu,
  /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function newState() {
  return {
    dropped: { total: 0, byReason: Object.create(null) },
    metricLabels: new Map(),
    metricSeries: new Set(),
    fingerprints: new Set(),
    workspaceHourSeen: false,
  };
}

function drop(state, reason, count = 1) {
  const safeReason = REASONS.has(reason) ? reason : 'other';
  const n = Number.isSafeInteger(count) && count > 0 ? count : 1;
  state.dropped.total = Math.min(MAX_SAFE, state.dropped.total + n);
  state.dropped.byReason[safeReason] = Math.min(MAX_SAFE, (state.dropped.byReason[safeReason] ?? 0) + n);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readRecord(value, state) {
  if (!isPlainRecord(value)) {
    drop(state, 'invalid_shape');
    return null;
  }

  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      drop(state, 'unknown_field');
      continue;
    }
    if (FORBIDDEN_KEYS.has(key)) {
      drop(state, 'prototype_key');
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      drop(state, 'invalid_shape');
      continue;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function readArray(value, state) {
  if (!Array.isArray(value)) {
    drop(state, 'wrong_type');
    return null;
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    drop(state, 'invalid_shape');
    return null;
  }
  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && ARRAY_INDEX.test(key) && Number(key) < length) continue;
    drop(state, typeof key === 'string' && FORBIDDEN_KEYS.has(key) ? 'prototype_key' : 'unknown_field');
  }
  return length;
}

function looksSensitive(value) {
  return SENSITIVE_TEXT.some((pattern) => pattern.test(value));
}

function validateInteger(value, descriptor, state) {
  if (!Number.isSafeInteger(value)) {
    drop(state, 'wrong_type');
    return { ok: false };
  }
  if (value < descriptor.min || value > descriptor.max || (descriptor.multipleOf && value % descriptor.multipleOf !== 0)) {
    drop(state, 'out_of_range');
    return { ok: false };
  }
  if (descriptor.ranges && !descriptor.ranges.some(([min, max]) => value >= min && value <= max)) {
    drop(state, 'out_of_range');
    return { ok: false };
  }
  return { ok: true, value };
}

function projectArray(value, descriptor, state) {
  const length = readArray(value, state);
  if (length === null) return { ok: false };

  const maximum = descriptor.maxItems ?? TELEMETRY_SCHEMA.limits.maxEvents;
  if (descriptor.minItems !== undefined && descriptor.minItems === maximum && length !== maximum) {
    drop(state, 'invalid_shape');
    return { ok: false };
  }
  const end = Math.min(length, maximum);
  if (length > end) drop(state, 'too_many_events', length - end);
  if (descriptor.minItems !== undefined && length < descriptor.minItems) {
    drop(state, 'invalid_shape');
    return { ok: false };
  }

  const output = [];
  const unique = new Set();
  for (let index = 0; index < end; index++) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!itemDescriptor || !itemDescriptor.enumerable || !Object.hasOwn(itemDescriptor, 'value')) {
      drop(state, 'invalid_shape');
      continue;
    }
    const result = projectValue(itemDescriptor.value, descriptor.items, state);
    if (!result.ok) continue;

    let uniqueValue;
    if (descriptor.uniqueBy && result.value && typeof result.value === 'object') {
      uniqueValue = result.value[descriptor.uniqueBy];
    } else if (descriptor.uniqueItems) {
      uniqueValue = JSON.stringify(result.value);
    }
    if (uniqueValue !== undefined && unique.has(uniqueValue)) {
      drop(state, 'duplicate_value');
      continue;
    }
    if (uniqueValue !== undefined) unique.add(uniqueValue);
    output.push(result.value);
  }
  return { ok: true, value: output };
}

function projectFields(fields, definitions, state, { eventOwners = null, ignored = null } = {}) {
  const output = {};
  let ok = true;

  for (const key of fields.keys()) {
    if (!Object.hasOwn(definitions, key)) {
      if (ignored?.has(key)) continue;
      const owners = eventOwners?.get(key);
      drop(state, owners?.size ? 'wrong_event' : 'unknown_field');
    }
  }

  for (const [name, descriptor] of Object.entries(definitions)) {
    if (!fields.has(name)) {
      if (descriptor.optional !== true) {
        drop(state, 'invalid_shape');
        ok = false;
      }
      continue;
    }
    const result = projectValue(fields.get(name), descriptor, state);
    if (!result.ok) {
      ok = false;
      continue;
    }
    output[name] = result.value;
  }
  return { ok, value: output };
}

function projectValue(value, descriptor, state) {
  if (descriptor.nullable && value === null) return { ok: true, value: null };
  switch (descriptor.type) {
    case 'int':
      return validateInteger(value, descriptor, state);
    case 'enum':
      if (typeof value !== 'string') {
        drop(state, 'wrong_type');
        return { ok: false };
      }
      if (!descriptor.values.includes(value)) {
        drop(state, 'invalid_enum');
        return { ok: false };
      }
      return { ok: true, value };
    case 'string': {
      if (typeof value !== 'string') {
        drop(state, 'wrong_type');
        return { ok: false };
      }
      if (value.length > descriptor.maxLength || !new RegExp(descriptor.pattern, 'u').test(value) || looksSensitive(value)) {
        drop(state, 'invalid_string');
        return { ok: false };
      }
      return { ok: true, value };
    }
    case 'bool':
      if (typeof value !== 'boolean') {
        drop(state, 'wrong_type');
        return { ok: false };
      }
      return { ok: true, value };
    case 'array':
      return projectArray(value, descriptor, state);
    case 'object': {
      const fields = readRecord(value, state);
      if (!fields) return { ok: false };
      return projectFields(fields, descriptor.fields, state);
    }
    default:
      drop(state, 'invalid_shape');
      return { ok: false };
  }
}

function metricLabels(value, descriptor, state) {
  const definitions = descriptor.labels ?? {};
  if (Object.keys(definitions).length === 0 && value === undefined) return { ok: true, value: {} };
  const fields = readRecord(value, state);
  if (!fields) return { ok: false };

  const labels = {};
  let ok = true;
  for (const key of fields.keys()) {
    if (!Object.hasOwn(definitions, key)) drop(state, 'unknown_field');
  }
  for (const [name, label] of Object.entries(definitions)) {
    if (!fields.has(name)) {
      drop(state, 'invalid_shape');
      ok = false;
      continue;
    }
    const submitted = fields.get(name);
    if (typeof submitted === 'string' && label.values.includes(submitted)) {
      labels[name] = submitted;
    } else if (label.values.includes('other')) {
      labels[name] = 'other';
      drop(state, 'invalid_label');
    } else {
      drop(state, typeof submitted === 'string' ? 'invalid_enum' : 'wrong_type');
      ok = false;
    }
  }
  return { ok, value: labels };
}

function metricValue(value, descriptor, state) {
  if (descriptor.kind !== 'histogram') return validateInteger(value, descriptor, state);

  const fields = readRecord(value, state);
  if (!fields) return { ok: false };
  const allowed = new Set(['count', 'sum', 'buckets']);
  for (const key of fields.keys()) if (!allowed.has(key)) drop(state, 'unknown_field');
  if (!fields.has('count') || !fields.has('sum') || !fields.has('buckets')) {
    drop(state, 'invalid_shape');
    return { ok: false };
  }

  const countResult = validateInteger(fields.get('count'), { min: 0, max: MAX_SAFE }, state);
  const sumResult = validateInteger(fields.get('sum'), { min: 0, max: MAX_SAFE }, state);
  const bucketDefinition = { type: 'array', minItems: descriptor.buckets.length + 1, maxItems: descriptor.buckets.length + 1, items: { type: 'int', min: 0, max: MAX_SAFE } };
  const bucketsResult = projectArray(fields.get('buckets'), bucketDefinition, state);
  if (!countResult.ok || !sumResult.ok || !bucketsResult.ok) return { ok: false };

  const buckets = bucketsResult.value;
  if (buckets.length !== descriptor.buckets.length + 1 || buckets.some((bucket, index) => index > 0 && bucket < buckets[index - 1]) || buckets.at(-1) !== countResult.value) {
    drop(state, 'invalid_shape');
    return { ok: false };
  }
  return { ok: true, value: { count: countResult.value, sum: sumResult.value, buckets } };
}

function processMetric(value, state) {
  const fields = readRecord(value, state);
  if (!fields) return null;
  const name = fields.get('name');
  if (typeof name !== 'string') {
    drop(state, 'wrong_type');
    return null;
  }
  const descriptor = getMetricDefinition(name);
  if (!descriptor || descriptor.source === 'control_plane') {
    drop(state, 'unknown_metric');
    return null;
  }

  for (const key of fields.keys()) {
    if (!['name', 'labels', 'value'].includes(key)) drop(state, 'unknown_field');
  }
  if (!fields.has('value')) {
    drop(state, 'invalid_shape');
    return null;
  }
  const labelsResult = metricLabels(fields.get('labels'), descriptor, state);
  const valueResult = metricValue(fields.get('value'), descriptor, state);
  if (!labelsResult.ok || !valueResult.ok) return null;

  const labelsKey = JSON.stringify(labelsResult.value);
  let knownLabels = state.metricLabels.get(name);
  if (!knownLabels) {
    knownLabels = new Set();
    state.metricLabels.set(name, knownLabels);
  }
  if (!knownLabels.has(labelsKey) && knownLabels.size >= TELEMETRY_SCHEMA.limits.maxLabelCombinationsPerMetric) {
    drop(state, 'cardinality_limit');
    return null;
  }
  const seriesKey = `${name}\u0000${labelsKey}`;
  if (state.metricSeries.has(seriesKey)) {
    drop(state, 'duplicate_series');
    return null;
  }
  knownLabels.add(labelsKey);
  state.metricSeries.add(seriesKey);
  return { name, labels: labelsResult.value, value: valueResult.value };
}

const eventFieldOwners = new Map();
for (const [eventName, eventDefinition] of Object.entries(TELEMETRY_SCHEMA.events)) {
  for (const fieldName of Object.keys(eventDefinition.fields)) {
    const owners = eventFieldOwners.get(fieldName) ?? new Set();
    owners.add(eventName);
    eventFieldOwners.set(fieldName, owners);
  }
}

function processEvent(value, state, source) {
  const fields = readRecord(value, state);
  if (!fields) return null;
  const name = fields.get('event');
  if (typeof name !== 'string') {
    drop(state, 'unknown_event');
    return null;
  }
  const definition = getEventDefinition(name);
  if (!definition) {
    drop(state, 'unknown_event');
    return null;
  }
  if (definition.source === 'control_plane' && source !== 'control_plane') {
    drop(state, 'wrong_event');
    return null;
  }
  if (source === 'control_plane' && name === 'workspace_hour') {
    if (state.workspaceHourSeen) {
      drop(state, 'duplicate_event');
      return null;
    }
    state.workspaceHourSeen = true;
  }
  const eventFields = new Map(fields);
  eventFields.delete('event');
  const projected = projectFields(eventFields, definition.fields, state, { eventOwners: eventFieldOwners });
  if (!projected.ok) return null;
  return { event: name, ...projected.value };
}

function processFixedEvent(value, definition, state) {
  const fields = readRecord(value, state);
  if (!fields) return null;
  const projected = projectFields(fields, definition.fields, state);
  return projected.ok ? projected.value : null;
}

function processArray(input, key, processor, output, state) {
  if (input === undefined) return;
  const length = readArray(input, state);
  if (length === null) return;
  const end = key === 'events' ? Math.min(length, TELEMETRY_SCHEMA.limits.maxEvents) : length;
  if (length > end) drop(state, 'too_many_events', length - end);
  for (let index = 0; index < end; index++) {
    const item = Object.getOwnPropertyDescriptor(input, String(index));
    if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) {
      drop(state, 'invalid_shape');
      continue;
    }
    const clean = processor(item.value, state);
    if (!clean) continue;

    if (key === 'errors') {
      const fingerprint = clean.fingerprint;
      if (state.fingerprints.has(fingerprint)) {
        drop(state, 'duplicate_error');
        continue;
      }
      if (state.fingerprints.size >= TELEMETRY_SCHEMA.limits.maxErrorFingerprints) {
        drop(state, 'cardinality_limit');
        continue;
      }
      state.fingerprints.add(fingerprint);
    }
    output.push(clean);
  }
}

function rejectInstanceAlerts(input, state) {
  if (input === undefined) return;
  const length = readArray(input, state);
  if (length !== null && length > 0) drop(state, 'wrong_event', length);
}

function processAlerts(input, source, output, state) {
  if (source === 'control_plane') {
    processArray(input, 'alerts', (value, current) => processFixedEvent(value, TELEMETRY_SCHEMA.alerts, current), output, state);
    return;
  }
  rejectInstanceAlerts(input, state);
}

function encodedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function enforceSize(clean, state) {
  const limit = TELEMETRY_SCHEMA.limits.maxBytes;
  const trimOrder = ['alerts', 'events', 'errors', 'metrics'];
  let size = encodedBytes(clean);
  for (const key of trimOrder) {
    while (size > limit && clean[key].length > 0) {
      clean[key].pop();
      drop(state, 'payload_limit');
      size = encodedBytes(clean);
    }
  }
  return size <= limit;
}

/**
 * Validate and project a report. The clean value contains only schema fields.
 * `options.source` is `instance` by default, which drops control-plane-only events
 * with `wrong_event`; `control_plane` enables those events for control-plane reports.
 * Events declared for instances remain accepted in either mode.
 * @param {{ source?: 'instance' | 'control_plane' }} [options]
 */
export function scrubReport(input, options = {}) {
  const state = newState();
  const source = options?.source === 'control_plane' ? 'control_plane' : 'instance';
  try {
    const fields = readRecord(input, state);
    if (!fields) {
      drop(state, 'invalid_report');
      return { clean: null, dropped: state.dropped };
    }

    const arrayNames = new Set(['metrics', 'errors', 'events', 'alerts']);
    for (const key of fields.keys()) {
      if (!Object.hasOwn(TELEMETRY_SCHEMA.envelope.fields, key) && !arrayNames.has(key)) drop(state, 'unknown_field');
    }
    const envelope = projectFields(fields, TELEMETRY_SCHEMA.envelope.fields, state, { ignored: arrayNames });
    if (!envelope.ok) {
      drop(state, 'invalid_report');
      return { clean: null, dropped: state.dropped };
    }

    const clean = { ...envelope.value, metrics: [], errors: [], events: [], alerts: [] };
    processArray(fields.get('metrics'), 'metrics', processMetric, clean.metrics, state);
    processArray(fields.get('errors'), 'errors', (value, current) => processFixedEvent(value, TELEMETRY_SCHEMA.errors, current), clean.errors, state);
    processArray(fields.get('events'), 'events', (value, current) => processEvent(value, current, source), clean.events, state);
    processAlerts(fields.get('alerts'), source, clean.alerts, state);

    if (!enforceSize(clean, state)) {
      drop(state, 'invalid_report');
      return { clean: null, dropped: state.dropped };
    }
    return { clean, dropped: state.dropped };
  } catch {
    drop(state, 'invalid_report');
    return { clean: null, dropped: state.dropped };
  }
}
