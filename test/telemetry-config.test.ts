import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';

const AUTH = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.test' };
const CLOUD = {
  TABULA_CLOUD_TOKEN: 'k'.repeat(40),
  TABULA_CLOUD_URL: 'https://cloud.example.test',
  TABULA_CLOUD_WORKSPACE_ID: 'ws_123',
};

describe('TABULA_TELEMETRY', () => {
  it('defaults self-hosted accounts off and hosted accounts on', () => {
    expect(loadConfig(AUTH, () => {}).telemetry).toEqual({ defaultEnabled: false, forced: null });
    expect(loadConfig({ ...AUTH, ...CLOUD }, () => {}).telemetry).toEqual({ defaultEnabled: true, forced: null });
  });

  it('lets the operator force either state for the owner privacy panel', () => {
    expect(loadConfig({ ...AUTH, TABULA_TELEMETRY: 'off' }, () => {}).telemetry).toEqual({ defaultEnabled: false, forced: 'off' });
    expect(loadConfig({ ...AUTH, TABULA_TELEMETRY: 'on' }, () => {}).telemetry).toEqual({ defaultEnabled: true, forced: 'on' });
    expect(loadConfig({ ...AUTH, ...CLOUD, TABULA_TELEMETRY: 'off' }, () => {}).telemetry).toEqual({ defaultEnabled: false, forced: 'off' });
  });

  it.each(['yes', '1', 'true', 'ON', 'maybe'])('refuses invalid value %s', (value) => {
    expect(() => loadConfig({ ...AUTH, TABULA_TELEMETRY: value }, () => {})).toThrow('TABULA_TELEMETRY must be on or off');
  });

  it('honours the legacy MIRA spelling and TABULA takes precedence', () => {
    expect(loadConfig({ ...AUTH, MIRA_TELEMETRY: 'on' }, () => {}).telemetry).toEqual({ defaultEnabled: true, forced: 'on' });
    expect(loadConfig({ ...AUTH, MIRA_TELEMETRY: 'on', TABULA_TELEMETRY: 'off' }, () => {}).telemetry).toEqual({ defaultEnabled: false, forced: 'off' });
  });
});
