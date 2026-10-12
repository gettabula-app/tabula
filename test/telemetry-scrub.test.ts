import { describe, expect, it } from 'vitest';
import { TELEMETRY_SCHEMA, getMetricDefinition } from '../server/telemetry/schema.mjs';
import { scrubReport } from '../server/telemetry/scrub.mjs';

const schema = TELEMETRY_SCHEMA as any;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const URL = /(?:https?|ftp):\/\/|\bwww\./iu;
const IPV4 = /(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:\D|$)/u;
const TOKEN = /\bBearer\s+|\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|\b(?:access[_-]?token|api[_-]?key|secret|token)[_-][A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const SAFE_WORKSPACE_ID = 'ws_Qz43ux4p5HNJ';

function validMetric(name: string): any {
  const definition = getMetricDefinition(name) as any;
  const labels = Object.fromEntries(Object.entries(definition.labels ?? {}).map(([key, label]: [string, any]) => [key, label.values.find((value: string) => value !== 'other')]));
  const value = definition.kind === 'histogram'
    ? { count: 1, sum: 1, buckets: Array(definition.buckets.length + 1).fill(1) }
    : 1;
  return { name, labels, value };
}

function validEvent(name: string): any {
  switch (name) {
    case 'workspace_day':
      return { event: name, dau: 4, wau: 8, boards: 3, tickets: 2, features_used: ['board_text', 'chat'], app_version: 'v1.2.3', mode: 'hosted' };
    case 'feature_used':
      return { event: name, feature: 'board_text', count: 4 };
    case 'milestone':
      return { event: name, name: 'first_board' };
    case 'upgrade_result':
      return { event: name, from: 'v1.2.2', to: 'v1.2.3', result: 'ok', duration_ms: 1200 };
    case 'error_rate_day':
      return { event: name, top_codes: [{ code: 'not_found', count: 2 }] };
    default:
      throw new Error(`No fixture for event ${name}`);
  }
}

function validError(fingerprint = 'abcdef0123456789'): any {
  return { fingerprint, code: 'not_found', kind: 'api', status: 404, top_frame: 'server/api.mjs:27', count: 1 };
}

function validAlert(): any {
  return { kind: 'backup_stale', severity: 'warn', workspace: 'ws_8M2kW4p7nQ1Z', at: 1791676800000 };
}

function validReport(): any {
  const metrics = Object.keys(schema.metrics)
    .filter((name) => schema.metrics[name].source !== 'control_plane')
    .map(validMetric);
  const events = Object.keys(schema.events).map(validEvent);
  return {
    schema: 1,
    hour: 1791676800000,
    app_version: 'v1.2.3',
    schema_directory: 5,
    schema_chat: 3,
    node_major: 22,
    platform: 'linux',
    mode: 'hosted',
    connections_now: 2,
    connections_peak: 5,
    last_activity_at: null,
    workspace: 'ws_8M2kW4p7nQ1Z',
    metrics,
    errors: [validError()],
    events,
    alerts: [],
  };
}

function expectNoSensitiveText(clean: unknown): string {
  const serialized = JSON.stringify(clean);
  expect(serialized).not.toMatch(EMAIL);
  expect(serialized).not.toMatch(URL);
  expect(serialized).not.toMatch(IPV4);
  expect(serialized).not.toMatch(TOKEN);
  return serialized;
}

function expectMutationAbsent(serialized: string, value: unknown, allowWorkspaceId: boolean): void {
  const isString = typeof value === 'string';
  const allowedValue = isString && allowWorkspaceId && value === SAFE_WORKSPACE_ID;
  expect(isString && serialized.includes(value as string)).toBe(allowedValue);
  expect(serialized).not.toContain('prototype-marker');
  expect(serialized).not.toContain('sk_live_0123456789abcdef');
}

function scrubOnceWithoutThrow(input: unknown): ReturnType<typeof scrubReport> {
  let result: ReturnType<typeof scrubReport> | undefined;
  expect(() => { result = scrubReport(input); }).not.toThrow();
  if (!result) throw new Error('scrubReport did not return a result');
  return result;
}

function seededStrings(seed: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length: 4 }, () => `RND-${next().toString(16)}-${next().toString(16)}!Ω`);
}

function putAtPath(input: any, path: (string | number)[], value: unknown): any {
  const clone = structuredClone(input);
  let current = clone;
  for (const part of path.slice(0, -1)) current = current[part];
  current[path[path.length - 1]] = value;
  return clone;
}

function mutationPoints(report: any): { label: string; path: (string | number)[] }[] {
  const points: { label: string; path: (string | number)[] }[] = [];
  for (const name of Object.keys(schema.envelope.fields)) points.push({ label: `envelope.${name}`, path: [name] });
  for (let metricIndex = 0; metricIndex < report.metrics.length; metricIndex++) {
    const metric = report.metrics[metricIndex];
    points.push({ label: `metrics.${metric.name}.name`, path: ['metrics', metricIndex, 'name'] });
    for (const labelName of Object.keys(schema.metrics[metric.name].labels ?? {})) {
      points.push({ label: `metrics.${metric.name}.labels.${labelName}`, path: ['metrics', metricIndex, 'labels', labelName] });
    }
    if (schema.metrics[metric.name].kind === 'histogram') {
      for (const key of ['count', 'sum', 'buckets']) points.push({ label: `metrics.${metric.name}.value.${key}`, path: ['metrics', metricIndex, 'value', key] });
      points.push({ label: `metrics.${metric.name}.value.buckets[0]`, path: ['metrics', metricIndex, 'value', 'buckets', 0] });
    } else {
      points.push({ label: `metrics.${metric.name}.value`, path: ['metrics', metricIndex, 'value'] });
    }
  }
  for (let eventIndex = 0; eventIndex < report.events.length; eventIndex++) {
    const event = report.events[eventIndex];
    points.push({ label: `events.${event.event}.event`, path: ['events', eventIndex, 'event'] });
    for (const fieldName of Object.keys(schema.events[event.event].fields)) {
      const field = schema.events[event.event].fields[fieldName];
      const path = ['events', eventIndex, fieldName];
      points.push({ label: `events.${event.event}.${fieldName}`, path });
      if (field.type === 'array') {
        points.push({ label: `events.${event.event}.${fieldName}[0]`, path: [...path, 0] });
        if (field.items.type === 'object') {
          for (const childName of Object.keys(field.items.fields)) points.push({ label: `events.${event.event}.${fieldName}[0].${childName}`, path: [...path, 0, childName] });
        }
      }
    }
  }
  for (const [collectionName, descriptor] of [['errors', schema.errors], ['alerts', schema.alerts]] as const) {
    for (let index = 0; index < report[collectionName].length; index++) {
      for (const fieldName of Object.keys(descriptor.fields)) points.push({ label: `${collectionName}.${fieldName}`, path: [collectionName, index, fieldName] });
    }
  }
  return points;
}

describe('scrubReport', () => {
  it('projects the complete catalogue into a clean report without drops', () => {
    const report = validReport();
    const result = scrubReport(report);
    expect(result.dropped.total).toBe(0);
    expect(result.clean).toEqual(report);
    expectNoSensitiveText(result.clean);
  });

  it.each(Object.entries(schema.metrics))('validates metric entry %s', (name, definition: any) => {
    const report = validReport();
    report.metrics = [validMetric(name)];
    const result = scrubReport(report);
    const sourceMetric = definition.source === 'control_plane';
    expect(result.clean?.metrics).toEqual(sourceMetric ? [] : [validMetric(name)]);
    expect(result.dropped.byReason.unknown_metric ?? 0).toBe(sourceMetric ? 1 : 0);
    const invalid = putAtPath(report, ['metrics', 0, 'value'], definition.kind === 'histogram' ? [] : 'not-a-number');
    const rejected = scrubReport(invalid);
    expect(rejected.clean?.metrics).toEqual([]);
    expect(rejected.dropped.total).toBeGreaterThan(0);
  });

  it.each(Object.keys(schema.events))('validates product event entry %s', (name) => {
    const report = validReport();
    report.events = [validEvent(name)];
    const result = scrubReport(report);
    expect(result.clean?.events).toEqual([validEvent(name)]);

    const invalid = structuredClone(report);
    const firstField = Object.keys(schema.events[name].fields)[0];
    invalid.events[0][firstField] = 'https://private.example/path?token=sk_live_0123456789';
    const rejected = scrubReport(invalid);
    expectNoSensitiveText(rejected.clean);
    expect(rejected.clean?.events).toEqual([]);
  });

  it('validates error fields and keeps control-plane alerts out of instance reports', () => {
    const report = validReport();
    const valid = scrubReport(report);
    expect(valid.clean?.errors).toEqual([validError()]);
    expect(valid.clean?.alerts).toEqual([]);

    for (const field of Object.keys(schema.errors.fields)) {
      const invalid = structuredClone(report);
      invalid.errors[0][field] = 'https://private.example/path?token=sk_live_0123456789';
      const result = scrubReport(invalid);
      expectNoSensitiveText(result.clean);
      expect(result.clean?.errors).toEqual([]);
    }
    const instanceAlert = structuredClone(report);
    instanceAlert.alerts = [validAlert()];
    const rejectedAlert = scrubReport(instanceAlert);
    expect(rejectedAlert.clean?.alerts).toEqual([]);
    expect(rejectedAlert.dropped.byReason.wrong_event).toBe(1);

    const privateAlert = structuredClone(report);
    privateAlert.alerts = [{ ...validAlert(), workspace: 'alice.private@example.test' }];
    const rejectedPrivateAlert = scrubReport(privateAlert);
    expectNoSensitiveText(rejectedPrivateAlert.clean);
    expect(rejectedPrivateAlert.clean?.alerts).toEqual([]);
  });

  it('requires histogram bucket arrays to match the descriptor and stay cumulative', () => {
    const report = validReport();
    const definition = getMetricDefinition('http_duration_ms') as any;
    const buckets = Array(definition.buckets.length + 1).fill(1);
    report.metrics = [{ name: 'http_duration_ms', labels: { route: 'health' }, value: { count: 1, sum: 1, buckets: [...buckets, 1] } }];
    const wrongLength = scrubReport(report);
    expect(wrongLength.clean?.metrics).toEqual([]);

    report.metrics[0].value.buckets = [...buckets];
    report.metrics[0].value.buckets[1] = 0;
    const decreasing = scrubReport(report);
    expect(decreasing.clean?.metrics).toEqual([]);
    expect(decreasing.dropped.byReason.invalid_shape).toBe(1);
  });

  it('replaces every bad metric label with other and never preserves the submitted value', () => {
    const report = validReport();
    report.metrics = [{
      name: 'http_requests_total',
      labels: { route: 'https://private.example/boards/secret?token=sk_live_0123456789', status_class: '500' },
      value: 1,
    }];
    const result = scrubReport(report);
    expect(result.clean?.metrics).toEqual([{ name: 'http_requests_total', labels: { route: 'other', status_class: 'other' }, value: 1 }]);
    expect(result.dropped.byReason.invalid_label).toBe(2);
    expectNoSensitiveText(result.clean);
  });

  it('drops unknown fields, unknown names, cross-event fields, and non-enumerated source metrics', () => {
    const report = validReport();
    report.unlisted = 'alice@example.test';
    report.metrics.push({ name: 'invented_metric', labels: { url: 'https://private.example' }, value: 1 });
    report.metrics.push({ name: 'scrubber_dropped_total', labels: { reason: 'unknown_field' }, value: 5 });
    report.events.push({ event: 'milestone', feature: 'board_text' });
    const result = scrubReport(report);
    expect(result.clean).not.toHaveProperty('unlisted');
    expect(result.clean?.metrics.some((metric: any) => metric.name === 'invented_metric' || metric.name === 'scrubber_dropped_total')).toBe(false);
    expect(result.clean?.events.some((event: any) => event.event === 'milestone' && event.feature !== undefined)).toBe(false);
    expectNoSensitiveText(result.clean);
    expect(result.dropped.byReason.unknown_metric).toBe(2);
    expect(result.dropped.byReason.wrong_event).toBeGreaterThan(0);
  });

  it('enforces safe integer ranges, hour alignment, minute truncation, and error status classes', () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const report = validReport();
      report.metrics = [{ name: 'http_requests_total', labels: { route: 'health', status_class: '2xx' }, value }];
      expect(scrubReport(report).clean?.metrics).toEqual([]);
    }

    const badHour = validReport();
    badHour.hour += 1;
    expect(scrubReport(badHour).clean).toBeNull();
    const badActivity = validReport();
    badActivity.last_activity_at = 1791676800001;
    expect(scrubReport(badActivity).clean).toBeNull();
    for (const status of [1, 99, 600]) {
      const report = validReport();
      report.errors = [validError()];
      report.errors[0].status = status;
      expect(scrubReport(report).clean?.errors).toEqual([]);
    }
  });

  it('caps label combinations, fingerprints, and all record events deterministically', () => {
    const report = validReport();
    const definition = getMetricDefinition('client_sessions_total') as any;
    const device = definition.labels.device.values;
    const browser = definition.labels.browser.values;
    const os = definition.labels.os.values;
    const installed = definition.labels.installed.values;
    const combinations = [];
    for (const d of device) for (const b of browser) for (const o of os) for (const app of installed) combinations.push({ device: d, browser: b, os: o, installed: app });
    report.metrics = combinations.slice(0, 201).map((labels: any) => ({ name: 'client_sessions_total', labels, value: 1 }));
    report.errors = [];
    report.events = [];
    report.alerts = [];
    const labelsResult = scrubReport(report);
    expect(labelsResult.clean?.metrics).toHaveLength(200);
    expect(labelsResult.dropped.byReason.cardinality_limit).toBe(1);

    report.metrics = [];
    report.errors = Array.from({ length: 51 }, (_, index) => validError(index.toString(16).padStart(16, '0')));
    const errorsResult = scrubReport(report);
    expect(errorsResult.clean?.errors).toHaveLength(50);
    expect(errorsResult.dropped.byReason.cardinality_limit).toBe(1);

    report.errors = [];
    report.metrics = validReport().metrics;
    report.events = Array.from({ length: 1001 }, (_, index) => ({ event: 'feature_used', feature: index % 2 ? 'chat' : 'board_text', count: 1 }));
    const eventsResult = scrubReport(report);
    expect(eventsResult.clean?.events).toHaveLength(1000);
    expect(eventsResult.dropped.byReason.too_many_events).toBe(1);
    expect(scrubReport(report)).toEqual(eventsResult);
  });

  it('keeps serialized clean output within the byte limit while recording trimmed entries', () => {
    const longVersion = `v${'1'.repeat(63)}`;
    const report = validReport();
    report.metrics = [];
    report.errors = [];
    report.alerts = [];
    report.events = Array.from({ length: 1000 }, () => ({
      event: 'workspace_day', dau: 9007199254740991, wau: 9007199254740991, boards: 9007199254740991, tickets: 9007199254740991,
      features_used: schema.events.workspace_day.fields.features_used.items.values, app_version: longVersion, mode: 'hosted',
    }));
    const result = scrubReport(report);
    expect(result.clean).not.toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(result.clean)).byteLength).toBeLessThanOrEqual(schema.limits.maxBytes);
    expect(result.dropped.byReason.payload_limit).toBeGreaterThan(0);
  });

  it('rejects prototype keys, getters, cycles, proxies and non-plain objects without throwing', () => {
    const report = validReport();
    Object.defineProperty(report, 'constructor', { value: 'secret_key_0123456789', enumerable: true });
    Object.defineProperty(report.events[0], '__proto__', { value: 'secret_key_0123456789', enumerable: true });
    Object.defineProperty(report.metrics[0].labels ?? report.metrics[0], 'prototype', { value: 'secret_key_0123456789', enumerable: true });
    const result = scrubReport(report);
    expectNoSensitiveText(result.clean);
    expect(result.clean).not.toHaveProperty('constructor');
    expect(result.dropped.byReason.prototype_key).toBeGreaterThan(0);

    const getter = validReport();
    Object.defineProperty(getter, 'workspace', { enumerable: true, get: () => { throw new Error('no read'); } });
    expect(() => scrubReport(getter)).not.toThrow();
    const cycle: any = validReport();
    cycle.self = cycle;
    expect(() => scrubReport(cycle)).not.toThrow();
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('no proxy trap'); } });
    expect(() => scrubReport(proxy)).not.toThrow();
    expect(scrubReport(new Date()).clean).toBeNull();
  });

  it('feeds seeded adversarial strings and structures into every catalogue field without throwing or leaking them', () => {
    const baseline = validReport();
    const marker = 'sk_live_0123456789abcdef';
    const forbiddenObject: Record<string, unknown> = { marker: 'https://private.example/?token=secret_0123456789' };
    Object.defineProperty(forbiddenObject, '__proto__', { value: 'prototype-marker', enumerable: true });
    const values: unknown[] = [
      'alice.private@example.test',
      'https://private.example/boards/private?token=sk_live_0123456789abcdef',
      '203.0.113.42',
      '2001:db8::cafe',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature0123456789',
      marker,
      'access_token_privatevalue123456789',
      'ws_Qz43ux4p5HNJ',
      'x'.repeat(10_240),
      '漢字🔐\u0000\u001f',
      forbiddenObject,
      ['nested', 'array', marker],
      ...seededStrings(0x0cd65a11),
    ];
    const points = mutationPoints(baseline);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      for (const value of values) {
        const input = putAtPath(baseline, point.path, value);
        const result = scrubOnceWithoutThrow(input);
        const serialized = expectNoSensitiveText(result.clean);
        const allowWorkspaceId = point.label === 'envelope.workspace' || point.label === 'alerts.workspace';
        expectMutationAbsent(serialized, value, allowWorkspaceId);
      }
    }
  });
});
