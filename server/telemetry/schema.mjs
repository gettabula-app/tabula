// Copied to tabula-cloud/src/telemetry unchanged.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const schemaText = readFileSync(new URL('../../docs/telemetry-schema.json', import.meta.url), 'utf8');

/** Freeze JSON-shaped values recursively without changing their shape. */
export function deepFreezeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreezeJson(value[key], seen);
  return Object.freeze(value);
}

/** @type {Readonly<Record<string, any>>} */
export const TELEMETRY_SCHEMA = deepFreezeJson(JSON.parse(schemaText));

/** SHA-256 of the exact schema file bytes, suitable for control-plane agreement checks. */
export const SCHEMA_HASH = createHash('sha256').update(schemaText, 'utf8').digest('hex');

/** Return a frozen metric definition, or undefined for an unknown metric. */
export function getMetricDefinition(name) {
  if (typeof name !== 'string' || !Object.hasOwn(TELEMETRY_SCHEMA.metrics, name)) return undefined;
  return TELEMETRY_SCHEMA.metrics[name];
}

/** Return a frozen product-event definition, or undefined for an unknown event. */
export function getEventDefinition(name) {
  if (typeof name !== 'string' || !Object.hasOwn(TELEMETRY_SCHEMA.events, name)) return undefined;
  return TELEMETRY_SCHEMA.events[name];
}
