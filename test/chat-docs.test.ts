import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../docs/guide/chat.md', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../docs/chat.md', import.meta.url), 'utf8');

describe('chat email setup documentation', () => {
  it('warns that default log mode exposes mention text and does not deliver email', () => {
    expect(readme).toContain('a chat mention email includes its message text (up to 140 characters) in that output');
    expect(guide).toContain('With the default `TABULA_MAIL=log`, mention emails are not delivered');
    expect(guide).toContain('prints their contents to process output, including the first 140 characters');
    expect(guide).toContain('configure `TABULA_MAIL=smtp` or `TABULA_MAIL=webhook` intentionally');
  });

  it('describes the mention mail delay override as test-only', () => {
    expect(spec).toContain('a test-only `TABULA_CHAT_MENTION_MAIL_AFTER_MS` shortens the wait for relay tests when `NODE_ENV=test`; the relay ignores it otherwise');
  });
});
