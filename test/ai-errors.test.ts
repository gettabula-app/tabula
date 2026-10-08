import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AI_STATUS, AiError, describeError, redactBody, redactHeaders, scrubText } from '../server/ai/errors.mjs';

// docs/ai.md: "The request and error loggers redact authorization, x-api-key and the apiKey body field".

const KEY = `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;

describe('AiError', () => {
  it('has a fixed message and status per code, and nothing else of its own', () => {
    for (const [code, status] of Object.entries(AI_STATUS)) {
      const err = new AiError(code as keyof typeof AI_STATUS);
      expect(err).toBeInstanceOf(Error);
      expect([err.code, err.status, err.name]).toEqual([code, status, 'AiError']);
      expect(err.message.length).toBeGreaterThan(5);
    }
    expect(AI_STATUS).toMatchObject({ ai_key_invalid: 400, ai_rate_limited: 429, ai_unavailable: 502, ai_unconfigured: 409, internal: 500 });
  });

  it('reads an unknown code as internal', () => {
    const err = new AiError('nonsense' as any);
    expect([err.code, err.status]).toEqual(['internal', 500]);
  });
});

describe('redactHeaders', () => {
  it('blanks the credentials of a plain object, whatever the case', () => {
    const out = redactHeaders({ Authorization: `Bearer ${KEY}`, 'X-Api-Key': KEY, cookie: 'tabula_session=abc', 'content-type': 'application/json', 'anthropic-beta': 'x' });
    expect(out).toEqual({ Authorization: '[redacted]', 'X-Api-Key': '[redacted]', cookie: '[redacted]', 'content-type': 'application/json', 'anthropic-beta': 'x' });
  });

  it('reads a Headers object too', () => {
    const out = redactHeaders(new Headers({ 'x-api-key': KEY, authorization: `Bearer ${KEY}`, accept: 'application/json' }));
    expect(out).toEqual({ 'x-api-key': '[redacted]', authorization: '[redacted]', accept: 'application/json' });
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe('redactBody', () => {
  it('blanks the key fields at any depth and leaves the rest', () => {
    const body = { provider: 'anthropic', apiKey: KEY, nested: { api_key: KEY, list: [{ 'x-api-key': KEY, keep: 1 }], Authorization: KEY }, 'API-KEY': KEY, text: 'hello' };
    const out = redactBody(body);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out).toMatchObject({ provider: 'anthropic', text: 'hello', nested: { list: [{ keep: 1 }] } });
    expect(body.apiKey).toBe(KEY);
  });

  it('survives values that are not objects and very deep ones', () => {
    expect(redactBody(null)).toBeNull();
    expect(redactBody('x')).toBe('x');
    let deep: any = { apiKey: KEY };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(() => redactBody(deep)).not.toThrow();
  });
});

describe('scrubText', () => {
  it('blanks key-like strings and credential headers in free text', () => {
    const text = `failed: x-api-key: ${KEY} and Authorization: Bearer ${KEY} for sk-ant-short-1234567 or Bearer abc.def-123 ok`;
    const out = scrubText(text);
    expect(out).not.toMatch(/sk-ant|abc\.def/);
    expect(out).toContain('failed:');
    expect(out).toContain('ok');
  });

  it('leaves ordinary text alone and tolerates nothing', () => {
    expect(scrubText('connection reset by peer')).toBe('connection reset by peer');
    expect(scrubText(undefined)).toBe('');
  });
});

describe('describeError', () => {
  it('reduces an AiError to its name, code and status', () => {
    expect(describeError(new AiError('ai_rate_limited', { retryAfter: 4 }))).toBe('AiError code=ai_rate_limited status=429');
  });

  it('reduces a provider error, which carries the request headers, to its name and status', () => {
    const err = Anthropic.APIError.generate(401, { error: { message: KEY } }, `bad ${KEY}`, new Headers({ 'x-api-key': KEY }));
    const text = describeError(err);
    expect(text).toMatch(/status=401/);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('bad');
    const loose: any = new Error(`boom ${KEY}`);
    loose.status = 500;
    loose.headers = { authorization: KEY };
    expect(describeError(loose)).toBe('Error status=500');
  });

  it('keeps the stack of any other error, with key-like text blanked', () => {
    const text = describeError(new TypeError(`cannot read ${KEY}`));
    expect(text).toContain('TypeError');
    expect(text).toContain('cannot read');
    expect(text).not.toContain(KEY);
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(undefined)).toBe('');
  });
});
