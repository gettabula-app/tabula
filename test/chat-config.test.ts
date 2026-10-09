import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';

// TABULA_CHAT (docs/chat.md): off unless set, and only in accounts mode.

const ACCOUNTS = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com' };
const load = (env: Record<string, string>) => {
  const warnings: string[] = [];
  const config = loadConfig(env, (w: string) => warnings.push(w));
  return { config, warnings };
};

describe('TABULA_CHAT', () => {
  it('is off by default', () => {
    expect(load(ACCOUNTS).config.chat).toBeUndefined();
  });

  it('turns chat on in accounts mode', () => {
    expect(load({ ...ACCOUNTS, TABULA_CHAT: 'on' }).config.chat).toBe(true);
    expect(load({ ...ACCOUNTS, TABULA_CHAT: ' on ' }).config.chat).toBe(true);
    expect(load({ ...ACCOUNTS, TABULA_CHAT: 'off' }).config.chat).toBeUndefined();
  });

  it('is ignored with a warning in open mode', () => {
    const { config, warnings } = load({ TABULA_CHAT: 'on' });
    expect(config.chat).toBeUndefined();
    expect(warnings.join('\n')).toContain('TABULA_CHAT=on is ignored');
  });

  it('honours the old MIRA_ spelling', () => {
    expect(load({ ...ACCOUNTS, MIRA_CHAT: 'on' }).config.chat).toBe(true);
  });

  it.each(['yes', '1', 'true', 'ON'])('refuses %s', (value) => {
    expect(() => load({ ...ACCOUNTS, TABULA_CHAT: value })).toThrow('TABULA_CHAT must be on or off');
  });
});
