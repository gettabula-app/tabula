import { describe, expect, it, vi } from 'vitest';
import { withLegacyEnv } from '../server/env.mjs';

describe('withLegacyEnv', () => {
  it('copies a MIRA_ variable to its TABULA_ name', () => {
    const warn = vi.fn<(message: string) => void>();
    const env = withLegacyEnv({ MIRA_AUTH: 'on', MIRA_CLOUD_WORKSPACE_ID: 'ws_1', PORT: '8787' }, warn);
    expect(env.TABULA_AUTH).toBe('on');
    expect(env.TABULA_CLOUD_WORKSPACE_ID).toBe('ws_1');
    expect(env.PORT).toBe('8787');
  });

  it('lets an existing TABULA_ variable win, without a warning for the ignored legacy one', () => {
    const warn = vi.fn<(message: string) => void>();
    const env = withLegacyEnv({ MIRA_AUTH: 'on', TABULA_AUTH: 'off', MIRA_MAIL: 'file' }, warn);
    expect(env.TABULA_AUTH).toBe('off');
    expect(env.TABULA_MAIL).toBe('file');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0];
    expect(message).toContain('MIRA_MAIL (use TABULA_MAIL)');
    expect(message).not.toContain('MIRA_AUTH');
  });

  it('treats an empty TABULA_ value as set', () => {
    const warn = vi.fn<(message: string) => void>();
    expect(withLegacyEnv({ MIRA_MAIL_FROM: 'a@b.c', TABULA_MAIL_FROM: '' }, warn).TABULA_MAIL_FROM).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, naming every legacy variable and its replacement', () => {
    const warn = vi.fn<(message: string) => void>();
    withLegacyEnv({ MIRA_AUTH: 'on', MIRA_OWNER_EMAIL: 'a@b.c', MIRA_BASE_URL: 'http://x.example' }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0];
    for (const name of ['AUTH', 'OWNER_EMAIL', 'BASE_URL']) {
      expect(message).toContain(`MIRA_${name} (use TABULA_${name})`);
    }
  });

  it('does not warn when no legacy variable is used', () => {
    const warn = vi.fn<(message: string) => void>();
    const env = withLegacyEnv({ TABULA_AUTH: 'on', PORT: '9000', MIRAGE: 'x', XMIRA_Y: 'z' }, warn);
    expect(env).toEqual({ TABULA_AUTH: 'on', PORT: '9000', MIRAGE: 'x', XMIRA_Y: 'z' });
    expect(withLegacyEnv({}, warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a new object and leaves its input alone', () => {
    const input: Record<string, string> = { MIRA_AUTH: 'on', PORT: '8787' };
    const snapshot = { ...input };
    const env = withLegacyEnv(input, () => {});
    expect(env).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(Object.keys(input)).toEqual(['MIRA_AUTH', 'PORT']);
  });

  it('is idempotent: running its result through again changes and says nothing more', () => {
    const warn = vi.fn<(message: string) => void>();
    const once = withLegacyEnv({ MIRA_AUTH: 'on' }, warn);
    const twice = withLegacyEnv(once, warn);
    expect(twice).toEqual(once);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads process.env by default without changing it', () => {
    const warn = vi.fn<(message: string) => void>();
    vi.stubEnv('MIRA_ENV_TEST_ONLY', 'yes');
    try {
      expect(withLegacyEnv(undefined, warn).TABULA_ENV_TEST_ONLY).toBe('yes');
      expect(process.env.TABULA_ENV_TEST_ONLY).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
