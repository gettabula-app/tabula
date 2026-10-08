import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';
import { READY_TTL_MS } from '../server/ai/live.mjs';
import { createOpenRun } from '../server/ai/run.mjs';
import { KEY, closeWorlds, deferred, setup } from './ai-run-harness';

// docs/ai.md, "Live runs": POST /api/ai/runs/:id/resolve. The first add or discard of a ready run wins; an add hands the
// proposal to the person who asked, whose app writes it. Who may do it is policy.mjs's rule.

afterEach(closeWorlds);

const generate = (boardId: string) => ({ feature: 'generate', boardId, input: { prompt: 'ten risks of moving to the cloud' } });

async function world() {
  const w = await setup();
  w.enable();
  const owner = w.person('owner');
  const boardId = w.board(owner);
  const editor = w.person('member');
  const viewer = w.person('member');
  const commenter = w.person('member');
  const stranger = w.person('member');
  w.share(boardId, editor, 'editor');
  w.share(boardId, viewer, 'viewer');
  w.share(boardId, commenter, 'commenter');
  const resolve = (who: typeof owner, id: string, body: unknown = { action: 'accept' }) => w.call(who, 'POST', `/api/ai/runs/${id}/resolve`, body);
  const runReady = async () => {
    const res = await w.run(owner, generate(boardId));
    expect(res.events.at(-1)!.event).toBe('result');
    return res.events[0].data.runId as string;
  };
  return { w, owner, boardId, editor, viewer, commenter, stranger, resolve, runReady };
}

describe('resolving a run', () => {
  it('hands the proposal to the first editor who adds it, and tells the next one it is too late', async () => {
    const { w, editor, owner, resolve, runReady } = await world();
    const id = await runReady();
    const first = await resolve(editor, id);
    expect([first.status, first.body]).toEqual([200, { id, action: 'accept', feature: 'generate', proposal: { kind: 'create', objects: [{ text: 'A risk' }] }, cut: false }]);
    const second = await resolve(owner, id);
    expect([second.status, second.body.error]).toEqual([409, 'ai_run_resolved']);
    const discard = await resolve(owner, id, { action: 'discard' });
    expect([discard.status, discard.body.error]).toEqual([409, 'ai_run_resolved']);
    expect(w.audits().map((a) => a.action)).toEqual(expect.arrayContaining(['ai.run.accept']));
  });

  it('a discard carries no proposal', async () => {
    const { owner, resolve, runReady } = await world();
    const id = await runReady();
    const res = await resolve(owner, id, { action: 'discard' });
    expect([res.status, res.body]).toEqual([200, { id, action: 'discard', feature: 'generate' }]);
  });

  it('refuses viewers and commenters, and does not settle the run for them', async () => {
    const { viewer, commenter, owner, resolve, runReady } = await world();
    const id = await runReady();
    for (const who of [viewer, commenter]) {
      const res = await resolve(who, id);
      expect([res.status, res.body.error]).toEqual([403, 'forbidden']);
    }
    expect((await resolve(owner, id)).status).toBe(200);
  });

  it('is a 404 for someone who cannot open the board, and for a run that does not exist', async () => {
    const { stranger, owner, resolve, runReady } = await world();
    const id = await runReady();
    expect((await resolve(stranger, id)).status).toBe(404);
    expect((await resolve(owner, 'nosuchrun')).status).toBe(404);
    expect((await resolve(owner, id)).status).toBe(200);
  });

  it('cannot settle a run that is still going', async () => {
    const { w, owner, boardId, resolve } = await world();
    const gate = deferred();
    w.state.script = async function* (req) {
      yield { type: 'progress' };
      await gate.promise;
      yield { type: 'result', value: { objects: [{ text: 'late' }] }, usage: { model: req.model } };
    };
    const res = await fetch(`${w.base}/api/ai/run`, {
      method: 'POST',
      headers: { 'x-tabula': '1', 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify(generate(boardId)),
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const id = JSON.parse(/^data: (.+)$/m.exec(new TextDecoder().decode(value))![1]).runId;
    const early = await resolve(owner, id);
    expect([early.status, early.body.error]).toEqual([409, 'ai_run_running']);
    gate.resolve();
    while (!(await reader.read()).done);
    expect((await resolve(owner, id)).status).toBe(200);
  });

  it('expires a run nobody settles', async () => {
    const { w, owner, resolve, runReady } = await world();
    const id = await runReady();
    w.state.t += READY_TTL_MS;
    const res = await resolve(owner, id);
    expect([res.status, res.body.error]).toEqual([409, 'ai_run_resolved']);
  });

  it('checks the body and the CSRF header', async () => {
    const { w, owner, resolve, runReady } = await world();
    const id = await runReady();
    expect((await resolve(owner, id, { action: 'keep' })).status).toBe(400);
    expect((await resolve(owner, id, { action: 'accept', extra: 1 })).status).toBe(400);
    const res = await fetch(`${w.base}/api/ai/runs/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ action: 'accept' }),
    });
    expect(res.status).toBe(403);
    expect((await resolve(owner, id)).status).toBe(200);
  });

  it('is refused while the hosted workspace is read-only, and the run stays ready', async () => {
    const { w, owner, resolve, runReady } = await world();
    const id = await runReady();
    w.state.readOnly = true;
    const res = await resolve(owner, id);
    expect([res.status, res.body.error]).toEqual([402, 'read_only']);
    w.state.readOnly = false;
    expect((await resolve(owner, id)).status).toBe(200);
  });

  it('a failed run cannot be settled', async () => {
    const { w, owner, boardId, resolve } = await world();
    w.state.script = async function* () {
      yield* [];
      throw new Error('boom');
    };
    const res = await w.run(owner, generate(boardId));
    expect(res.events.at(-1)!.event).toBe('error');
    const back = await resolve(owner, res.events[0].data.runId);
    expect([back.status, back.body.error]).toEqual([409, 'ai_run_resolved']);
  });
});

describe('open mode', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r)))));
  });

  async function openWorld(env: Record<string, string> = { TABULA_AI_API_KEY: KEY, TABULA_AI_OPEN: '1' }) {
    const config = loadConfig({ ...env }, () => {});
    const open = createOpenRun({
      config,
      canWriteRoom: (role: string, kind: string) => kind === 'board' && role === 'owner',
      readRoom: (_name: string, fn: (doc: Y.Doc) => unknown) => fn(new Y.Doc()),
      roomExists: () => true,
      createProvider: () => ({
        run: (req: any) =>
          (async function* () {
            yield { type: 'result', value: { objects: [{ text: 'idea' }] }, usage: { model: req.model } };
          })(),
      }),
      log: () => {},
    });
    const server = http.createServer((req, res) => {
      const m = /^\/api\/ai\/runs\/([^/]+)\/resolve$/.exec(req.url ?? '');
      void (m ? open.resolve(req, res, m[1]) : open.handle(req, res));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown, headers: Record<string, string> = { 'x-tabula': '1' }) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: res.status, text: await res.text() };
    };
    return { post, open };
  }

  it('anyone settles, first come, and the runner is nobody', async () => {
    const { post, open } = await openWorld();
    const ran = await post('/api/ai/run', generate('board1'));
    const id = JSON.parse(/^data: (.+)$/m.exec(ran.text)![1]).runId;
    expect(open.live.get(id).by).toEqual({ id: null, name: null });
    const first = await post(`/api/ai/runs/${id}/resolve`, { action: 'accept' });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text).proposal).toEqual({ kind: 'create', objects: [{ text: 'idea' }] });
    const second = await post(`/api/ai/runs/${id}/resolve`, { action: 'discard' });
    expect([second.status, JSON.parse(second.text).error]).toEqual([409, 'ai_run_resolved']);
  });

  it('needs the CSRF header and AI turned on', async () => {
    const { post } = await openWorld();
    expect((await post('/api/ai/runs/x/resolve', { action: 'accept' }, {})).status).toBe(403);
    const off = await openWorld({});
    const res = await off.post('/api/ai/runs/x/resolve', { action: 'accept' });
    expect([res.status, JSON.parse(res.text).error]).toEqual([403, 'ai_disabled']);
  });
});
