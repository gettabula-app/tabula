import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type ServerTemplate, type TemplateInput } from '../src/api';

// The template calls of src/api.ts: the documented method and path, the CSRF header on writes, the body, and the errors.

type Call = { url: string; init: RequestInit };

function recorder(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const headersOf = (call: Call) => call.init.headers as Record<string, string>;

const content = { objects: [], steps: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
const template: ServerTemplate = {
  id: 't1', version: 1, name: 'Retro', category: 'Retrospective', description: '', scope: 'personal', teamId: null, teamName: null,
  createdBy: 'u1', ownerName: 'Ana', createdAt: 1, updatedAt: 2, objectCount: 0, stepCount: 0, canChange: true, content,
};
const input: TemplateInput = { name: 'Retro', category: 'Retrospective', content };

afterEach(() => vi.restoreAllMocks());

describe('template calls', () => {
  it('list and fetch with plain GETs', async () => {
    const { fetchFn, calls } = recorder(() => json([]));
    const api = createApi(fetchFn);
    await api.listTemplates();
    await api.getTemplate('t1');
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([['GET', '/api/templates'], ['GET', '/api/templates/t1']]);
    for (const call of calls) {
      expect(call.init.credentials).toBe('same-origin');
      expect(call.init.body).toBeUndefined();
      expect(headersOf(call)['x-tabula']).toBeUndefined();
    }
  });

  it('create sends the template with the CSRF header and returns what the server made', async () => {
    const { fetchFn, calls } = recorder(() => json(template, 201));
    const made = await createApi(fetchFn).createTemplate({ ...input, scope: 'team', teamId: 'team1', description: 'About' });
    expect(calls[0].url).toBe('/api/templates');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])).toMatchObject({ 'x-tabula': '1', 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ...input, scope: 'team', teamId: 'team1', description: 'About' });
    expect(made.id).toBe('t1');
  });

  it('update sends only the fields it is given', async () => {
    const { fetchFn, calls } = recorder(() => json(template));
    await createApi(fetchFn).updateTemplate('t1', { name: 'New' });
    expect(calls[0].url).toBe('/api/templates/t1');
    expect(calls[0].init.method).toBe('PATCH');
    expect(headersOf(calls[0])['x-tabula']).toBe('1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'New' });
  });

  it('duplicate and delete are bodiless writes', async () => {
    const { fetchFn, calls } = recorder((call) => (call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(template, 201)));
    const api = createApi(fetchFn);
    expect((await api.duplicateTemplate('t1')).id).toBe('t1');
    await expect(api.deleteTemplate('t1')).resolves.toBeUndefined();
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([['POST', '/api/templates/t1/duplicate'], ['DELETE', '/api/templates/t1']]);
    for (const call of calls) {
      expect(call.init.body).toBeUndefined();
      expect(headersOf(call)['x-tabula']).toBe('1');
      expect(headersOf(call)['content-type']).toBeUndefined();
    }
  });

  it('encode the id in the path', async () => {
    const { fetchFn, calls } = recorder(() => json(template));
    await createApi(fetchFn).getTemplate('a/b?c');
    expect(calls[0].url).toBe('/api/templates/a%2Fb%3Fc');
  });

  it('give a megabyte of template time to travel, and the other calls the usual eight seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchFn } = recorder(() => json(template));
    const api = createApi(fetchFn);
    await api.createTemplate(input);
    await api.getTemplate('t1');
    await api.updateTemplate('t1', { name: 'x' });
    await api.listTemplates();
    await api.duplicateTemplate('t1');
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([30000, 30000, 30000, 30000, 30000]);
    await api.me();
    expect(timeout.mock.calls.at(-1)?.[0]).toBe(8000);
  });

  it('turn a refusal into an ApiError with the server\'s status, code and message', async () => {
    const reply = (status: number, error: string, message: string) => recorder(() => json({ error, message }, status)).fetchFn;
    const failed = async (fetchFn: typeof fetch) => createApi(fetchFn).createTemplate(input).catch((e: ApiError) => e);
    expect(await failed(reply(403, 'forbidden', 'Guests cannot create templates'))).toMatchObject({ status: 403, code: 'forbidden', message: 'Guests cannot create templates' });
    expect(await failed(reply(413, 'payload_too_large', 'The request body is too large'))).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(await failed(reply(402, 'read_only', 'This workspace is read-only.'))).toMatchObject({ status: 402, code: 'read_only' });
    expect(await failed(reply(400, 'bad_request', 'Object 1 has an SVG body that is not allowed: it uses <script>'))).toMatchObject({ status: 400 });
    expect(await failed((async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch)).toMatchObject({ status: 0, code: 'network' });
  });
});
